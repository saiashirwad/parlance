import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compileGrammar, type CompiledGrammar } from "../src/grammar/compile.ts";
import { parseGrammar } from "../src/grammar/parse.ts";
import { reparse } from "../src/parser/incremental.ts";
import type { Edit, ParseResult } from "../src/parser/parse.ts";
import type { GrammarSpec } from "../src/parser/spec.ts";
import { applyEdit } from "../src/source.ts";

const load = (relative: string): CompiledGrammar => {
  const parsed = parseGrammar(readFileSync(new URL(relative, import.meta.url), "utf8"));
  assert.equal(parsed.ok, true, parsed.ok ? "" : JSON.stringify(parsed.diagnostics));
  if (!parsed.ok) throw new Error("unreachable");
  const compiled = compileGrammar(parsed.file);
  assert.equal(compiled.valid, true, compiled.diagnostics.map((entry) => entry.message).join("\n"));
  return compiled;
};

const calc = load("../examples/calc/calc.parl");
const strings = (() => {
  const parsed = parseGrammar(String.raw`
grammar Strings

skip /\s+/
word /[A-Za-z_][A-Za-z0-9_]*/
token Str /"[^"]*"/

root File

rule File = {
  @file items:Decl*
};

rule Decl = {
  | @let "let" name:Name "=" value:Expr ";"
};

rule Name = { word };

rule Expr = {
  | value:$Str
  | value:Name
};
`);
  assert.equal(parsed.ok, true, parsed.ok ? "" : JSON.stringify(parsed.diagnostics));
  if (!parsed.ok) throw new Error("unreachable");
  const compiled = compileGrammar(parsed.file);
  assert.equal(compiled.valid, true, compiled.diagnostics.map((entry) => entry.message).join("\n"));
  return compiled;
})();

const list = (() => {
  const parsed = parseGrammar(String.raw`
grammar List

skip /\s+/
word /[A-Za-z_][A-Za-z0-9_]*/
root File

rule File = { Decl* };

rule Decl = { @item "item" name:Name ";" };

rule Name = { word };
`);
  assert.equal(parsed.ok, true, parsed.ok ? "" : JSON.stringify(parsed.diagnostics));
  if (!parsed.ok) throw new Error("unreachable");
  const compiled = compileGrammar(parsed.file);
  assert.equal(compiled.valid, true, compiled.diagnostics.map((entry) => entry.message).join("\n"));
  return compiled;
})();

type Item = { readonly kind: string; readonly span: { readonly start: number; readonly end: number } };

const itemsOf = (spec: GrammarSpec, value: unknown): readonly Item[] => {
  const incremental = spec.incremental;
  assert.ok(incremental, "expected an incremental grammar");
  if (incremental.shape === "array") {
    assert.ok(Array.isArray(value));
    return value as readonly Item[];
  }
  assert.ok(value !== null && typeof value === "object");
  const list = (value as Record<string, unknown>)[incremental.field!];
  assert.ok(Array.isArray(list));
  return list as readonly Item[];
};

const program = [
  "// leading comment",
  "let a = 1;",
  "show a + 2;",
  "let b = 3 * (4 - 5);",
  "show -b;",
  "// trailing comment",
  "",
].join("\n");

const at = (source: string, text: string, delta = 0): number => {
  const index = source.indexOf(text);
  assert.ok(index >= 0, `missing ${JSON.stringify(text)}`);
  return index + delta;
};

const check = (
  name: string,
  old: string,
  edit: Edit,
  spec: GrammarSpec = calc.spec,
  parse: (source: string) => ParseResult<unknown> = (source) => calc.parse(source),
  options: { readonly verify?: boolean } = {},
) => {
  const previous = parse(old);
  const snapshot = JSON.stringify(previous);
  const next = applyEdit(old, edit);
  const result = reparse(spec, previous, next, edit, {
    previousSource: old,
    ...(options.verify === undefined ? {} : { verify: options.verify }),
  });
  assert.equal(JSON.stringify(previous), snapshot, `${name}: previous was mutated`);
  const full = parse(next);
  assert.deepEqual(result.value, full.value, `${name}: value differs from full parse`);
  assert.deepEqual(result.diagnostics, full.diagnostics, `${name}: diagnostics differ from full parse`);
  assert.equal(result.ok, full.ok, `${name}: ok differs from full parse`);
  assert.equal(JSON.stringify(result.tokens), JSON.stringify(full.tokens), `${name}: tokens differ`);
  assert.equal(JSON.stringify(result.trivia), JSON.stringify(full.trivia), `${name}: trivia differ`);
  const items = itemsOf(spec, result.value);
  assert.equal(
    result.stats.reused + result.stats.reparsed,
    items.length,
    `${name}: reused + reparsed must equal the item count`,
  );
  assert.equal(
    result.stats.window[1] - result.stats.window[0],
    result.stats.reparsed,
    `${name}: window size must equal reparsed`,
  );
  return { previous, next, result, full, items };
};

test("baseline: one declaration edit verifies and reuses untouched items", () => {
  const name = at(program, "a = 1;");
  const edit = { start: name, end: name + 1, insert: "total" };
  const { result, items } = check("baseline", program, edit, calc.spec, undefined, { verify: true });
  assert.equal(result.stats.fallback, false);
  assert.ok(result.stats.reused > 0);
  assert.equal(result.stats.reused + result.stats.reparsed, items.length);
  assert.equal(result.stats.window[1] - result.stats.window[0], result.stats.reparsed);
});

test("targeted edits: insertion, deletion, replacement, trivia, EOF, offset zero", () => {
  const before = check("insert at item start", program, {
    start: at(program, "let a"),
    end: at(program, "let a"),
    insert: "let z = 9;\n",
  });
  assert.equal(before.result.stats.fallback, false);

  const end = at(program, "show a + 2;", "show a + 2;".length);
  check("insert at item end", program, { start: end, end, insert: "\nlet z = a + 1;" });

  const second = at(program, "show a + 2;");
  check("delete a declaration", program, { start: second, end: at(program, "let b"), insert: "" });

  const value = at(program, "3 *", 0);
  check("replace a token inside a declaration", program, { start: value, end: value + 1, insert: "8" });

  const comment = at(program, "trailing");
  check("edit inside a comment (trivia)", program, { start: comment, end: comment + 8, insert: "changed" });

  check("edit at EOF", program, { start: program.length, end: program.length, insert: "let e = 5;\n" });
  check("edit at offset zero", program, { start: 0, end: 0, insert: "let p = 0;\n" });

  const empty = check("empty file to declaration", "", { start: 0, end: 0, insert: "let a = 1;\n" });
  assert.equal(empty.result.value === null, false);

  const last = at(program, "show -b;");
  check("delete the last declaration", program, { start: last, end: last + "show -b;".length, insert: "" });

  const paste = at(program, "let b");
  check("paste several declarations", program, {
    start: paste,
    end: paste,
    insert: "let q = 1;\nshow q;\nlet r = q + 2;\n",
  });
});

test("tokenization changes and encoding: quote, comment break, CRLF, surrogate pair", () => {
  const quoted = 'let a = "one";\nlet b = "two";\nlet c = "three";\n';
  const closing = quoted.indexOf('"two"') + '"two'.length;
  const broken = check("broken string token", quoted, { start: closing, end: closing + 1, insert: " " }, strings.spec, (source) =>
    strings.parse(source));
  assert.equal(broken.result.ok, false);

  const comment = at(program, "// trailing comment");
  const newline = at(program, "trailing") + "trailing".length;
  check("break a line comment into tokens", program, { start: newline, end: newline, insert: "\n" });

  const crlf = "let a = 1;\r\nshow a;\r\nlet b = 2;\r\n";
  check("CRLF source", crlf, { start: at(crlf, "1;"), end: at(crlf, "1;") + 1, insert: "42" });

  const emoji = "// 😀 note\nlet a = 1;\nshow a;\nlet b = 2;\nshow b;\n";
  const note = at(emoji, "note");
  const edited = check("surrogate pair before the edit", emoji, { start: note, end: note + 4, insert: "text" });
  assert.equal(edited.result.stats.fallback, false);
  assert.ok(edited.result.stats.reused > 0);
  check("replace the surrogate pair itself", emoji, {
    start: at(emoji, "😀"),
    end: at(emoji, "😀") + "😀".length,
    insert: "🙂",
  });
});

test("array-shaped roots splice items directly", () => {
  const source = "item a;\nitem b;\nitem c;\nitem d;\nitem e;\n";
  const start = at(source, "c;");
  const checked = check(
    "array shape",
    source,
    { start, end: start + 1, insert: "long" },
    list.spec,
    (value) => list.parse(value),
    { verify: true },
  );
  assert.equal(checked.result.stats.fallback, false);
  assert.ok(checked.result.stats.reused > 0);
  assert.ok(Array.isArray(checked.result.value));
  assert.equal(checked.items.length, 5);
});

test("reparse never mutates the previous result", () => {
  const previous = calc.parse(program);
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  };
  freeze(previous);
  const edit = { start: at(program, "let b"), end: at(program, "let b") + 5, insert: "show" };
  const next = applyEdit(program, edit);
  const result = reparse(calc.spec, previous, next, edit, { previousSource: program });
  assert.deepEqual(result.value, calc.parse(next).value);
  assert.deepEqual(result.diagnostics, calc.parse(next).diagnostics);
});

test("grammars without incremental support fall back to a full parse", () => {
  const parsed = parseGrammar(String.raw`
grammar Plain

skip /\s+/

root File

rule File = { @file "x" };
`);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  const plain = compileGrammar(parsed.file);
  assert.equal(plain.valid, true);
  assert.equal(plain.spec.incremental, null);
  const previous = plain.parse("x");
  const edit = { start: 1, end: 1, insert: " " };
  const next = applyEdit("x", edit);
  const result = reparse(plain.spec, previous, next, edit, { previousSource: "x", verify: true });
  assert.equal(result.stats.fallback, true);
  assert.equal(result.stats.reused, 0);
  assert.equal(result.stats.reparsed, 0);
  assert.deepEqual(result.stats.window, [0, 0]);
  assert.deepEqual(result.value, plain.parse(next).value);
  assert.deepEqual(result.diagnostics, plain.parse(next).diagnostics);
});

const seeded = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const pick = <T>(random: () => number, values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
const names = ["a", "b", "c", "x", "y", "total", "count", "value"] as const;
const literals = ["0", "1", "2", "3", "42", "true", "false"] as const;
const operators = ["+", "-", "*", "/", "==", "!="] as const;

const expression = (random: () => number, depth = 0): string => {
  if (depth >= 2 || random() < 0.35) {
    return random() < 0.25 ? pick(random, names) : pick(random, literals);
  }
  const roll = random();
  if (roll < 0.15) return `${pick(random, ["-", "!"])}${expression(random, depth + 1)}`;
  if (roll < 0.3) return `(${expression(random, depth + 1)})`;
  return `${expression(random, depth + 1)} ${pick(random, operators)} ${expression(random, depth + 1)}`;
};

const randomProgram = (random: () => number): string => {
  const count = 4 + Math.floor(random() * 6);
  const lines: string[] = [];
  for (let index = 0; index < count; index++) {
    lines.push(
      random() < 0.6
        ? `let ${pick(random, names)} = ${expression(random)};`
        : `show ${expression(random)};`,
    );
  }
  return lines.join(random() < 0.3 ? "\r\n" : "\n") + "\n";
};

const randomEdit = (source: string, items: readonly Item[], random: () => number): Edit => {
  if (items.length === 0) {
    return { start: 0, end: 0, insert: `let ${pick(random, names)} = ${expression(random)};\n` };
  }
  const item = pick(random, items);
  const choice = random();
  if (choice < 0.3) {
    const tokens = calc.lex(source).tokens.filter((token) =>
      token.span.start >= item.span.start
      && token.span.end <= item.span.end
      && (token.kind === "token" || (token.kind === "word" && !calc.spec.keywords.has(token.text)))
    );
    if (tokens.length > 0) {
      const token = pick(random, tokens);
      return {
        start: token.span.start,
        end: token.span.end,
        insert: token.kind === "token" ? pick(random, ["7", "123", "3.5"]) : pick(random, names),
      };
    }
  }
  if (choice < 0.55) {
    return {
      start: item.span.end,
      end: item.span.end,
      insert: `\nlet ${pick(random, names)} = ${expression(random)};`,
    };
  }
  if (choice < 0.75) {
    const index = items.indexOf(item);
    const next = items[index + 1];
    return { start: item.span.start, end: next ? next.span.start : item.span.end, insert: "" };
  }
  if (choice < 0.9) {
    return { start: item.span.start, end: item.span.start, insert: pick(random, ["\n", "// note\n", "  ", "\n\n"]) };
  }
  return {
    start: item.span.end,
    end: item.span.end,
    insert: `\nlet ${pick(random, names)} = ${expression(random)};\nshow ${expression(random)};`,
  };
};

test("randomized property: 80 seeds x 30 edits match a full parse", () => {
  let edits = 0;
  let fallbacks = 0;
  for (let seed = 1; seed <= 80; seed++) {
    const random = seeded(seed);
    let source = randomProgram(random);
    let previous = calc.parse(source);
    for (let round = 0; round < 30; round++) {
      const items = itemsOf(calc.spec, previous.value);
      const edit = randomEdit(source, items, random);
      const next = applyEdit(source, edit);
      const snapshot = JSON.stringify(previous);
      const result = reparse(calc.spec, previous, next, edit, { previousSource: source });
      assert.equal(JSON.stringify(previous), snapshot, `seed ${seed} round ${round}: previous mutated`);
      const full = calc.parse(next);
      assert.deepEqual(result.value, full.value, `seed ${seed} round ${round} (${JSON.stringify(edit)}): value`);
      assert.deepEqual(result.diagnostics, full.diagnostics, `seed ${seed} round ${round}: diagnostics`);
      assert.equal(result.ok, full.ok, `seed ${seed} round ${round}: ok`);
      const nextItems = itemsOf(calc.spec, result.value);
      assert.equal(result.stats.reused + result.stats.reparsed, nextItems.length);
      if (result.stats.fallback) fallbacks++;
      edits++;
      source = next;
      previous = result;
    }
  }
  assert.equal(edits, 80 * 30);
  assert.ok(fallbacks / edits < 0.3, `too many fallbacks: ${fallbacks}/${edits}`);
});