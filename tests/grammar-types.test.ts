import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compileGrammar, type CompiledGrammar } from "../src/grammar/compile.ts";
import type { GrammarFile } from "../src/grammar/ast.ts";
import { parseGrammar } from "../src/grammar/parse.ts";
import { type Generated, generateTypes } from "../src/grammar/types.ts";

const calcSource = readFileSync(new URL("../examples/calc/calc.parl", import.meta.url), "utf8");

const load = (source: string): { readonly file: GrammarFile; readonly compiled: CompiledGrammar } => {
  const parsed = parseGrammar(source);
  assert.equal(parsed.ok, true, parsed.ok ? "" : JSON.stringify(parsed.diagnostics));
  if (!parsed.ok) throw new Error("unreachable");
  const compiled = compileGrammar(parsed.file);
  assert.equal(compiled.valid, true, compiled.diagnostics.map((entry) => entry.message).join("\n"));
  return { file: parsed.file, compiled };
};

const calc = load(calcSource);
const calcTypes = generateTypes(calc.file);

type Schema = {
  readonly interfaces: Map<string, { readonly name: string; readonly fields: Map<string, string> }>;
  readonly unions: Map<string, readonly string[]>;
};

const splitTopLevel = (text: string, separator: "|" | ","): string[] => {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote !== null) {
      if (char === "\\") index++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") depth--;
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter((part) => part.length > 0);
};

/** Extracts just enough of the generated module to check runtime values structurally. */
const schemaOf = (text: string): Schema => {
  const lines = text.split("\n");
  const interfaces: Schema["interfaces"] = new Map();
  const unions: Schema["unions"] = new Map();

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const typeMatch = /^export type ([A-Za-z_$][A-Za-z0-9_$]*) = ?(.*)$/.exec(line);
    if (typeMatch) {
      const name = typeMatch[1]!;
      let body = typeMatch[2]!;
      if (!body.endsWith(";")) {
        const parts: string[] = [];
        while (++index < lines.length) {
          const member = lines[index]!.trim();
          if (member.length === 0) continue;
          if (!member.startsWith("|")) break;
          let value = member.slice(1).trim();
          const done = value.endsWith(";");
          if (done) value = value.slice(0, -1);
          parts.push(value);
          if (done) break;
        }
        body = parts.join(" | ");
      } else {
        body = body.slice(0, -1);
      }
      unions.set(name, splitTopLevel(body, "|"));
      continue;
    }
    const interfaceMatch = /^export interface ([A-Za-z_$][A-Za-z0-9_$]*) \{$/.exec(line);
    if (interfaceMatch) {
      const name = interfaceMatch[1]!;
      const fields = new Map<string, string>();
      while (++index < lines.length && lines[index] !== "}") {
        const field = /^  readonly (?:"([^"]+)"|([A-Za-z_$][A-Za-z0-9_$]*)): (.+);$/.exec(lines[index]!);
        if (field) fields.set(field[1] ?? field[2]!, field[3]!);
      }
      interfaces.set(name, { name, fields });
    }
  }
  return { interfaces, unions };
};

const schema = schemaOf(calcTypes.text);

const resolvesToText = (name: string, seen = new Set<string>()): boolean => {
  if (name === "Text") return true;
  if (seen.has(name)) return false;
  seen.add(name);
  const members = schema.unions.get(name);
  return members?.some((member) => resolvesToText(member, seen)) ?? false;
};

const expectText = (value: unknown, path: string): void => {
  assert.equal(typeof value, "object", `${path} should be Text`);
  assert.notEqual(value, null, `${path} should be Text`);
  const record = value as Record<string, unknown>;
  assert.equal(typeof record.text, "string", `${path}.text`);
  expectValue(record.span, "Span", `${path}.span`);
};

const expectInterface = (value: unknown, name: string, path: string): void => {
  const declared = schema.interfaces.get(name);
  assert.ok(declared, `${path}: no interface ${name}`);
  assert.equal(typeof value, "object", `${path} should be ${name}`);
  assert.notEqual(value, null, `${path} should be ${name}`);
  assert.equal(Array.isArray(value), false, `${path} should be ${name}`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    assert.ok(declared.fields.has(key), `${path}: unexpected field ${key} on ${name}`);
  }
  for (const [field, type] of declared.fields) {
    assert.equal(Object.hasOwn(record, field), true, `${path}: missing field ${field} on ${name}`);
    expectValue(record[field], type, `${path}.${field}`);
  }
};

const expectUnion = (value: unknown, members: readonly string[], path: string): void => {
  if (value === null) {
    assert.ok(members.includes("null"), `${path}: null not allowed by ${members.join(" | ")}`);
    return;
  }
  if (Array.isArray(value)) {
    const arrayMember = members.find((member) => /^readonly (.+)\[\]$/.test(member) || /^readonly \[/.test(member));
    assert.ok(arrayMember, `${path}: no array member in ${members.join(" | ")}`);
    expectValue(value, arrayMember!, path);
    return;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.kind === "string") {
      const matches = members.filter((member) => {
        const candidate = schema.interfaces.get(member);
        return candidate?.fields.get("kind") === JSON.stringify(record.kind);
      });
      assert.ok(
        matches.length > 0,
        `${path}: kind ${JSON.stringify(record.kind)} not in ${members.join(" | ")}`,
      );
      expectInterface(value, matches[0]!, path);
      return;
    }
    if (typeof record.text === "string") {
      assert.ok(
        members.some((member) => resolvesToText(member)),
        `${path}: no Text member in ${members.join(" | ")}`,
      );
      expectText(value, path);
      return;
    }
  }
  assert.fail(`${path}: value does not match ${members.join(" | ")}`);
};

const expectValue = (value: unknown, type: string, path: string): void => {
  const members = splitTopLevel(type, "|");
  if (members.length !== 1) {
    expectUnion(value, members, path);
    return;
  }
  const single = members[0]!;
  if (single === "null") {
    assert.equal(value, null, path);
    return;
  }
  if (single === "never") assert.fail(`${path}: never`);
  if (single === "Text") {
    expectText(value, path);
    return;
  }
  if (single === "Span") {
    assert.equal(typeof value, "object", `${path} should be Span`);
    assert.notEqual(value, null, `${path} should be Span`);
    const span = value as Record<string, unknown>;
    assert.equal(typeof span.start, "number", `${path}.start`);
    assert.equal(typeof span.end, "number", `${path}.end`);
    return;
  }
  if (single.startsWith("\"")) {
    assert.equal(value, JSON.parse(single), path);
    return;
  }
  if (single === "string" || single === "number" || single === "boolean") {
    assert.equal(typeof value, single, path);
    return;
  }
  const tuple = /^readonly \[(.*)\]$/.exec(single);
  if (tuple) {
    assert.equal(Array.isArray(value), true, `${path} should be a tuple`);
    const elementTypes = splitTopLevel(tuple[1]!, ",");
    const elements = value as readonly unknown[];
    assert.equal(elements.length, elementTypes.length, `${path}: tuple length`);
    elementTypes.forEach((element, index) => expectValue(elements[index], element, `${path}[${index}]`));
    return;
  }
  const array = /^readonly (.+)\[\]$/.exec(single);
  if (array) {
    assert.equal(Array.isArray(value), true, `${path} should be an array`);
    let element = array[1]!;
    if (element.startsWith("(") && element.endsWith(")")) element = element.slice(1, -1);
    (value as readonly unknown[]).forEach((entry, index) => expectValue(entry, element, `${path}[${index}]`));
    return;
  }
  const union = schema.unions.get(single);
  if (union) {
    expectUnion(value, union, path);
    return;
  }
  if (schema.interfaces.has(single)) {
    expectInterface(value, single, path);
    return;
  }
  assert.fail(`${path}: unsupported generated type ${single}`);
};

const declaredKinds = (): ReadonlySet<string> => {
  const kinds = new Set<string>();
  for (const value of schema.interfaces.values()) {
    const kind = value.fields.get("kind");
    if (kind !== undefined) kinds.add(kind);
  }
  return kinds;
};

const walkKinds = (value: unknown, visit: (kind: string, path: string) => void, path = "$"): void => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkKinds(entry, visit, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.kind === "string") visit(record.kind, path);
  for (const [key, entry] of Object.entries(record)) walkKinds(entry, visit, `${path}.${key}`);
};

test("calc types include helpers, tagged node interfaces, and rule aliases", () => {
  assert.match(calcTypes.text, /^\/\/ Generated by parlance from Calc\. Do not edit\.$/m);
  assert.match(calcTypes.text, /export type Span = \{ readonly start: number; readonly end: number \};/);
  assert.match(calcTypes.text, /export type Text = \{ readonly text: string; readonly span: Span \};/);
  assert.match(calcTypes.text, /export interface FileFileNode \{/);
  assert.match(calcTypes.text, /export type File = FileFileNode;/);
  assert.match(calcTypes.text, /export interface DeclLetNode \{/);
  assert.match(calcTypes.text, /export interface DeclShowNode \{/);
  assert.match(calcTypes.text, /export type Decl =\n {2}\| DeclLetNode\n {2}\| DeclShowNode;/);
  assert.match(calcTypes.text, /export interface ExprBinaryNode \{/);
  assert.match(calcTypes.text, /export interface ExprPrefixNode \{/);
  assert.match(calcTypes.text, /export interface ExprPostfixNode \{/);
  assert.match(calcTypes.text, /export type Name = Text;/);
  assert.deepEqual(calcTypes.diagnostics, []);
});

test("generated interfaces cover every field and kind in a parsed calc AST", () => {
  const source = "let total = (1 + 2) * 3;\nshow -total == 7;\n";
  const result = calc.compiled.parse(source);
  assert.equal(result.ok, true, result.diagnostics.map((entry) => entry.message).join("\n"));
  assert.deepEqual(result.diagnostics, []);

  expectValue(result.value, "File", "$");

  const kinds = declaredKinds();
  let nodes = 0;
  walkKinds(result.value, (kind, path) => {
    nodes++;
    assert.ok(kinds.has(JSON.stringify(kind)), `${path}: no generated kind ${JSON.stringify(kind)}`);
  });
  assert.ok(nodes >= 5, "expected tagged nodes in the AST");
});

test("generation is deterministic", () => {
  assert.equal(generateTypes(calc.file).text, generateTypes(calc.file).text);
  assert.equal(generateTypes(calc.file).text, calcTypes.text);
});

test("comments and whitespace do not change generated types", () => {
  const decorated = calcSource
    .replace("grammar Calc", "/* heading */\n\ngrammar Calc")
    .replace("rule Expr = precedence {", "rule Expr =\n\n  // operators\n  precedence {")
    .replace("@file declarations:Decl*", "// declarations\n    @file declarations:Decl*")
    .replace(/\n/g, "\n  \n")
    .concat("\n/* trailing */\n");
  const other = load(decorated);
  const generated = generateTypes(other.file);
  assert.equal(generated.text, calcTypes.text);
  assert.deepEqual(generated.diagnostics, []);
});

test("a precedence rule emits binary, prefix, and postfix interfaces", () => {
  const lines = calcTypes.text.split("\n");
  for (const name of ["ExprBinaryNode", "ExprPrefixNode", "ExprPostfixNode"]) {
    const at = lines.findIndex((line) => line === `export interface ${name} {`);
    assert.ok(at >= 0, `missing ${name}`);
    assert.equal(lines[at + 1], `  readonly kind: "${name.slice(4, -4).toLowerCase()}";`);
  }
  assert.match(calcTypes.text, /export type Expr =\n(?: {2}\| .*\n)* {2}\| ExprBinaryNode\n {2}\| ExprPrefixNode\n {2}\| ExprPostfixNode;/);
});

const mulberry32 = (seed: number): (() => number) => {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const expression = (random: () => number, depth: number): string => {
  if (depth <= 0 || random() < 0.3) {
    const leaves = ["1", "2", "3.5", "42", "true", "false", "x", "y", "total"];
    return leaves[Math.floor(random() * leaves.length)]!;
  }
  const choice = Math.floor(random() * 5);
  if (choice === 0) return `(${expression(random, depth - 1)})`;
  if (choice === 1) return `- ${expression(random, depth - 1)}`;
  if (choice === 2) return `! ${expression(random, depth - 1)}`;
  const operators = ["+", "-", "*", "/"];
  const operator = operators[Math.floor(random() * operators.length)]!;
  return `${expression(random, depth - 1)} ${operator} ${expression(random, depth - 1)}`;
};

test("property-style generated calc programs match the generated schema", () => {
  const random = mulberry32(0x5eed);
  const kinds = declaredKinds();
  let nodes = 0;
  for (let index = 0; index < 50; index++) {
    const left = expression(random, 3);
    const right = expression(random, 3);
    const source = `let a = ${left};\nshow ${right};\n`;
    const result = calc.compiled.parse(source);
    assert.equal(result.ok, true, `program ${index}: ${source}\n${result.diagnostics.map((entry) => entry.message).join("\n")}`);
    assert.deepEqual(result.diagnostics, [], `program ${index}: ${source}`);
    expectValue(result.value, "File", `program[${index}]`);
    walkKinds(result.value, (kind, path) => {
      nodes++;
      assert.ok(kinds.has(JSON.stringify(kind)), `${path}: no generated kind ${JSON.stringify(kind)}`);
    });
  }
  assert.ok(nodes > 100, "expected the generated programs to contain many tagged nodes");
});

test("a rule named Text is renamed without breaking the helper", () => {
  const reserved = load("grammar Reserved\nroot Text\nrule Text = { word };\n");
  const generated: Generated = generateTypes(reserved.file);
  assert.equal(generated.diagnostics.some((entry) => entry.severity === "warning" && /Text/.test(entry.message)), true);
  assert.match(generated.text, /export type Text = \{ readonly text: string; readonly span: Span \};/);
  assert.match(generated.text, /export type TextRule = Text;/);
  assert.doesNotMatch(generated.text, /export type Text = Text;/);
});

test("the checked-in calc.ast.ts is current", () => {
  const committed = readFileSync(new URL("../examples/calc/calc.ast.ts", import.meta.url), "utf8");
  assert.equal(committed, calcTypes.text);
});
