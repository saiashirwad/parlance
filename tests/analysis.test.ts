import assert from "node:assert/strict";
import test from "node:test";
import { analyze, analyzeParsed } from "../src/language.ts";
import { reparse } from "../src/parser/incremental.ts";
import { diff } from "../src/source.ts";
import { calc } from "../examples/calc/calc.ts";

const declarations = (count: number, value: number): string =>
  [
    ...Array.from({ length: count }, (_, index) => `let v${index} = ${index + value};`),
    "show v1 + v2;",
    "",
  ].join("\n");

test("analysis can run on an incrementally reparsed tree", () => {
  const before = declarations(24, 0);
  const after = before.replace("let v12 = 12;", "let v12 = 99;");
  const previous = analyze(calc, before, "memory://incremental.calc");
  assert.deepEqual(previous.diagnostics, []);
  const edit = diff(before, after);
  assert.ok(edit);
  const parsed = reparse(calc.grammar.spec, previous.parse, after, edit, { previousSource: before });
  assert.equal(parsed.stats.fallback, false);
  assert.ok(parsed.stats.reused > 0);
  const analysis = analyzeParsed(calc, after, "memory://incremental.calc", parsed, parsed.stats);
  assert.equal(analysis.valid, true);
  assert.equal(analysis.incremental?.reused, parsed.stats.reused);
  assert.deepEqual(analysis.tree, analyze(calc, after, "memory://fully.calc").tree);
});

test("incremental analysis still reports new type errors", () => {
  const before = "let x = 1;\nshow x;\n";
  const after = "let x = 1 + true;\nshow x;\n";
  const previous = analyze(calc, before, "memory://incremental.calc");
  const edit = diff(before, after);
  assert.ok(edit);
  const parsed = reparse(calc.grammar.spec, previous.parse, after, edit, { previousSource: before });
  const analysis = analyzeParsed(calc, after, "memory://incremental.calc", parsed, parsed.stats);
  assert.equal(analysis.valid, false);
  assert.match(analysis.diagnostics.map((entry) => entry.message).join("\n"), /Expected number, found boolean/);
});

test("diff finds a single minimal edit", () => {
  assert.equal(diff("abc", "abc"), null);
  assert.deepEqual(diff("abc", "axc"), { start: 1, end: 2, insert: "x" });
  assert.deepEqual(diff("abc", "abcd"), { start: 3, end: 3, insert: "d" });
  assert.deepEqual(diff("abcd", "abc"), { start: 3, end: 4, insert: "" });
  assert.deepEqual(diff("", "hello"), { start: 0, end: 0, insert: "hello" });
});
