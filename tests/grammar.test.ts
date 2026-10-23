import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { withoutSpans } from "../src/grammar/ast.ts";
import { compileGrammar } from "../src/grammar/compile.ts";
import { parseGrammar } from "../src/grammar/parse.ts";

const grammarSource = readFileSync(new URL("../src/grammar/grammar.parl", import.meta.url), "utf8");
const calcSource = readFileSync(new URL("../examples/calc/calc.parl", import.meta.url), "utf8");

const load = (source: string) => {
  const parsed = parseGrammar(source);
  assert.equal(parsed.ok, true, parsed.ok ? "" : JSON.stringify(parsed.diagnostics));
  if (!parsed.ok) throw new Error("unreachable");
  const compiled = compileGrammar(parsed.file);
  assert.equal(compiled.valid, true, compiled.diagnostics.map((entry) => entry.message).join("\n"));
  return { parsed: parsed.file, compiled };
};

test("the grammar language parses itself with a compiled parser", () => {
  const { parsed, compiled } = load(grammarSource);
  const self = compiled.parse(grammarSource);
  assert.equal(self.diagnostics.length, 0);
  assert.deepEqual(withoutSpans(self.value), withoutSpans(parsed));
});

test("calc parses declarations, precedence, and prefix operators", () => {
  const { compiled } = load(calcSource);
  const result = compiled.parse("let x = 1 + 2 * 3;\nshow -x == 7;\n");
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.ok, true);
  const file = result.value as any;
  assert.equal(file.kind, "file");
  assert.equal(file.declarations.length, 2);
  const [letDecl, showDecl] = file.declarations;
  assert.equal(letDecl.kind, "let");
  assert.equal(letDecl.name.text, "x");
  assert.equal(letDecl.value.kind, "binary");
  assert.equal(letDecl.value.operator.text, "+");
  assert.equal(letDecl.value.right.kind, "binary");
  assert.equal(letDecl.value.right.operator.text, "*");
  assert.equal(showDecl.kind, "show");
  assert.equal(showDecl.value.kind, "binary");
  assert.equal(showDecl.value.left.kind, "prefix");
  assert.equal(showDecl.value.left.operator.text, "-");
});

test("spans are ordered and inside the source", () => {
  const { compiled } = load(calcSource);
  const source = "let total = (1 + 2) * 3;\nshow total;\n";
  const result = compiled.parse(source);
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.span === "object" && record.span !== null) {
      const span = record.span as { start: number; end: number };
      assert.ok(span.start >= 0 && span.end <= source.length, `span ${span.start}..${span.end}`);
      assert.ok(span.start <= span.end);
    }
    if (typeof record.text === "string" && typeof record.span === "object" && record.span !== null) {
      const span = record.span as { start: number; end: number };
      if (record.kind === undefined) assert.equal(source.slice(span.start, span.end), record.text);
    }
    Object.values(record).forEach(walk);
  };
  walk(result.value);
});

test("recovery keeps declarations after a malformed one", () => {
  const { compiled } = load(calcSource);
  const source = "let a = 1;\nlet = 2;\nlet c = 3;\n";
  const result = compiled.parse(source);
  assert.equal(result.diagnostics.length > 0, true);
  const file = result.value as any;
  assert.equal(file.kind, "file");
  assert.equal(file.declarations.length, 2);
  assert.equal(file.declarations[1].name.text, "c");
});

test("grammar checks report left recursion, nullable loops, and unused rules", () => {
  const left = load(`
grammar Bad
root A
rule A = { @a A "x" | @b "y" };
`);
  assert.match(left.compiled.diagnostics.map((entry) => entry.message).join("\n"), /Left recursion/);

  const loop = load(`
grammar Bad
root A
rule A = { "x"* };
`);
  assert.match(loop.compiled.diagnostics.map((entry) => entry.message).join("\n"), /match nothing/);

  const unused = load(`
grammar Bad
root A
rule A = { "x" };
rule B = { "y" };
`);
  assert.match(unused.compiled.diagnostics.map((entry) => entry.message).join("\n"), /Unused rule: B/);
});

test("source spans of text captures point at the captured characters", () => {
  const { compiled } = load(calcSource);
  const source = "let abc = 42;";
  const result = compiled.parse(source);
  const file = result.value as any;
  assert.equal(file.declarations[0].name.text, "abc");
  assert.equal(source.slice(file.declarations[0].name.span.start, file.declarations[0].name.span.end), "abc");
  assert.equal(file.declarations[0].value.value.text, "42");
  assert.equal(source.slice(file.declarations[0].value.value.span.start, file.declarations[0].value.value.span.end), "42");
});
