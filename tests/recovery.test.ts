import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { analyze, type Language } from "../src/language.ts";
import { ModuleGraph } from "../src/modules.ts";
import { reparse } from "../src/parser/incremental.ts";
import { diff } from "../src/source.ts";
import { advanced } from "../examples/advanced/advanced.ts";
import { calc } from "../examples/calc/calc.ts";
import { schema } from "../examples/schema/schema.ts";

const root = new URL("..", import.meta.url).pathname;
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const stdlib = read("examples/advanced/stdlib.advanced");
const main = read("examples/advanced/main.advanced");
const blog = read("examples/schema/blog.schema");
const uri = "file:///virtual/main.advanced";

const analyzeMain = (source: string) => {
  const graph = new ModuleGraph({
    languages: [advanced],
    read: (path) => path.endsWith("/stdlib.advanced") ? stdlib : null,
  });
  return graph.analyze(uri, { source });
};

const localDefinitions = (source: string): number =>
  analyzeMain(source).facts.definitions.filter((entry) => entry.uri === undefined || entry.uri === uri).length;

const replace = (source: string, from: string, to: string): string => {
  assert.ok(source.includes(from), `missing ${JSON.stringify(from)}`);
  return source.replace(from, to);
};

const codes = (diagnostics: readonly { readonly code?: string }[]): (string | undefined)[] =>
  diagnostics.map((entry) => entry.code);

test("a broken let keeps every later definition of main.advanced", () => {
  const clean = localDefinitions(main);
  assert.equal(clean, 23);
  const typos: Record<string, string> = {
    "missing operand": replace(main, "let a = 2 + 5 in", "let a = 2 + in"),
    "missing in": replace(main, "let a = 2 + 5 in", "let a = 2 + 5"),
    "missing value": replace(main, "let a = 2 + 5 in", "let a = in"),
    "open call": replace(main, "let ignored = print(answer) in", "let ignored = print(answer in"),
    "empty argument": replace(main, "Leaf(total), Leaf(a)", "Leaf(total), , Leaf(a)"),
    "missing name": replace(main, "let start = getValue(both(id)) in", "let = getValue(both(id)) in"),
  };
  for (const [name, source] of Object.entries(typos)) {
    const analysis = analyzeMain(source);
    const parse = analysis.diagnostics.filter((entry) => entry.code?.startsWith("parse/"));
    assert.deepEqual(codes(parse), ["parse/missing"], name);
    // A missing name is not a definition; every other one survives.
    assert.equal(localDefinitions(source), name === "missing name" ? clean - 1 : clean, name);
  }
});

test("repair shapes: error nodes, missing tokens, and skipped tokens", () => {
  const value = (source: string) => calc.grammar.parse(source).value as any;

  const operand = calc.grammar.parse("let a = 1 + ;\n");
  assert.deepEqual(codes(operand.diagnostics), ["parse/missing"]);
  assert.deepEqual((operand.value as any).declarations[0].value.right, { kind: "error", span: { start: 11, end: 11 } });

  const semicolon = value("let a = 1\nlet b = 2;\n");
  assert.equal(semicolon.declarations.length, 2);

  const skipped = calc.grammar.parse("let a = 1 ) );\nshow a;\n");
  assert.deepEqual(codes(skipped.diagnostics), ["parse/skipped", "parse/skipped"]);
  assert.equal((skipped.value as any).declarations.length, 2);

  const group = calc.grammar.parse("let a = (1 + ;\nshow a;\n");
  assert.deepEqual(codes(group.diagnostics), ["parse/missing"]);
  assert.equal((group.value as any).declarations.length, 2);

  // A missing list item is reported and left out of the list.
  const call = advanced.grammar.parse("let x = f(1, , 2) in x\n");
  assert.deepEqual(codes(call.diagnostics), ["parse/missing"]);
  const [item] = (call.value as any).items;
  assert.equal(item.expression.value.operations[0].arguments.length, 2);
});

test("an unclosed paren in 20000 calc declarations keeps all of them", () => {
  const lines = Array.from({ length: 20000 }, (_, index) => `let v${index} = ${index} + ${index % 97} * 3;`);
  const clean = lines.join("\n") + "\n";
  const open = replace(clean, "let v10000 = 10000 + 9 * 3;", "let v10000 = (10000 + 9 * 3;");
  const result = calc.grammar.parse(open);
  assert.equal((result.value as any).declarations.length, 20000);
  assert.deepEqual(codes(result.diagnostics), ["parse/missing"]);
});

test("edits around a repaired item reuse the tree and match a full parse", () => {
  const lines = Array.from({ length: 2000 }, (_, index) => `let v${index} = ${index} + ${index % 97} * 3;`);
  const clean = lines.join("\n") + "\n";
  const broken = replace(clean, "let v1000 = 1000 + 30 * 3;", "let v1000 = 1000 + ;");
  const open = replace(clean, "let v1000 = 1000 + 30 * 3;", "let v1000 = (1000 + 30 * 3;");
  const scenarios: [string, string, string][] = [
    ["type a typo", clean, broken],
    ["edit after the broken item", broken, replace(broken, "let v1500 = 1500", "let v1500 = 1501")],
    ["edit before the broken item", broken, replace(broken, "let v500 = 500", "let v500 = 501")],
    ["fix the typo", broken, clean],
    ["unclose a paren", clean, open],
    ["edit with an unclosed paren", open, replace(open, "let v1500 = 1500", "let v1500 = 1501")],
    ["drop a semicolon", clean, replace(clean, "let v1000 = 1000 + 30 * 3;", "let v1000 = 1000 + 30 * 3")],
  ];
  for (const [name, from, to] of scenarios) {
    const previous = calc.grammar.parse(from);
    const result = reparse(calc.grammar.spec, previous, to, diff(from, to)!, { previousSource: from });
    const full = calc.grammar.parse(to);
    assert.equal(result.stats.fallback, false, name);
    assert.ok(result.stats.reparsed <= 3, `${name}: reparsed ${result.stats.reparsed}`);
    assert.deepEqual(result.value, full.value, name);
    assert.deepEqual(result.diagnostics, full.diagnostics, name);
  }
});

test("random edits on broken sources: reparse matches a full parse", () => {
  const program = Array.from({ length: 30 }, (_, index) => `let v${index} = ${index} + (v${Math.max(0, index - 1)} * 3);`)
    .join("\n") + "\nshow v29;\n";
  const fragments = [";", "(", ")", "+", " in ", " let ", "x", "=", "{", "}", ",", "1", " "];
  const languages: [string, Language<any, any, any>, string][] = [["calc", calc, program], ["advanced", advanced, main], [
    "schema",
    schema,
    blog,
  ]];
  for (const [name, language, base] of languages) {
    let seed = 12345;
    const random = (limit: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % limit;
    };
    let source = base;
    let previous = language.grammar.parse(source);
    for (let step = 0; step < 1000; step++) {
      if (step % 25 === 0) {
        source = base;
        previous = language.grammar.parse(source);
      }
      const at = random(source.length + 1);
      const remove = random(3) === 0 ? Math.min(random(4), source.length - at) : 0;
      const insert = random(2) === 0 ? fragments[random(fragments.length)]! : "";
      const next = source.slice(0, at) + insert + source.slice(at + remove);
      const edit = diff(source, next);
      if (!edit) continue;
      const result = reparse(language.grammar.spec, previous, next, edit, { previousSource: source });
      const full = language.grammar.parse(next);
      const where = `${name} step ${step}: ${JSON.stringify(edit)}`;
      assert.deepEqual(result.value, full.value, where);
      assert.deepEqual(result.diagnostics, full.diagnostics, where);
      source = next;
      previous = result;
    }
  }
});

test("single-token deletions analyze without internal errors", () => {
  const cases: [Language<any, any, any>, string, string][] = [
    [advanced, main, "memory://main.advanced"],
    [schema, blog, "memory://blog.schema"],
  ];
  for (const [language, source, name] of cases) {
    const tokens = language.grammar.lex(source);
    for (let index = 0; index < tokens.length - 1; index++) {
      const edited = source.slice(0, tokens.startAt(index)) + source.slice(tokens.endAt(index));
      const internal = analyze(language, edited, name).diagnostics.find((entry) => /Internal/.test(entry.message));
      assert.equal(internal, undefined, `deleting ${JSON.stringify(tokens.textAt(index))} at ${tokens.startAt(index)}`);
    }
  }
});