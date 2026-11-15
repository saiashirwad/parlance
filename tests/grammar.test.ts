import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { withoutSpans } from "../src/grammar/ast.ts";
import { compileGrammar } from "../src/grammar/compile.ts";
import { parseGrammar } from "../src/grammar/parse.ts";

const grammarSource = readFileSync(new URL("../src/grammar/grammar.parl", import.meta.url), "utf8");
const calcSource = readFileSync(new URL("../examples/calc/calc.parl", import.meta.url), "utf8");

const compile = (source: string) => {
  const parsed = parseGrammar(source);
  assert.equal(parsed.ok, true, parsed.ok ? "" : JSON.stringify(parsed.diagnostics));
  if (!parsed.ok) throw new Error("unreachable");
  return { parsed: parsed.file, compiled: compileGrammar(parsed.file) };
};

const load = (source: string) => {
  const value = compile(source);
  assert.equal(value.compiled.valid, true, value.compiled.diagnostics.map((entry) => entry.message).join("\n"));
  return value;
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

test("recovery repairs a malformed declaration in place", () => {
  const { compiled } = load(calcSource);
  const source = "let a = 1;\nlet = 2;\nlet c = 3;\n";
  const result = compiled.parse(source);
  assert.deepEqual(result.diagnostics.map((entry) => [entry.code, entry.message]), [["parse/missing", "Expected a name"]]);
  const file = result.value as any;
  assert.equal(file.kind, "file");
  assert.equal(file.declarations.length, 3);
  // The missing name is a zero-width token right after "let".
  assert.deepEqual(file.declarations[1].name, { text: "", span: { start: 14, end: 14 }, missing: true });
  assert.equal(file.declarations[1].value.value.text, "2");
  assert.equal(file.declarations[2].name.text, "c");
});

test("grammar checks report left recursion, nullable loops, and unused rules", () => {
  const left = compile(`
grammar Bad
root A
rule A = { @a A "x" | @b "y" };
`);
  assert.match(left.compiled.diagnostics.map((entry) => entry.message).join("\n"), /Left recursion/);

  const loop = compile(`
grammar Bad
root A
rule A = { ("x"?)* };
`);
  assert.match(loop.compiled.diagnostics.map((entry) => entry.message).join("\n"), /match nothing/);

  const unused = compile(`
grammar Bad
root A
rule A = { "x" };
rule B = { "y" };
`);
  assert.match(unused.compiled.diagnostics.map((entry) => entry.message).join("\n"), /Unused rule: B/);
});

test("a nullable earlier alternative warns that later alternatives are unreachable", () => {
  const choice = compile(`
grammar Choice
skip /\\s+/
root File
rule File = { Maybe? | "x" };
rule Maybe = { "m" };
`);
  const messages = choice.compiled.diagnostics.map((entry) => `${entry.severity}: ${entry.message}`).join("\n");
  assert.match(messages, /warning: Alternative 1 can match nothing, so later alternatives are unreachable/);
  assert.equal(choice.compiled.valid, true);

  const distinct = compile(`
grammar Distinct
root File
rule File = { "a" | "b" };
`);
  assert.deepEqual(distinct.compiled.diagnostics, []);
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

const bindGrammar = `grammar B
root File
rule File = { @file items:Item* };
rule Item = {
  | @let "let" name:Name "=" value:Name ";"
  | @use "use" target:Name ";"
};
rule Name = { word };
`;

test("a bind block parses the same with the bootstrap and the self-hosted parser", () => {
  const { compiled: grammar } = load(grammarSource);
  const source = `${bindGrammar}
bind {
  import use.target
  builtin Int, String: type "scalar"
  scope file, let.value
  export def let.name: variable "value" after
  def let.name: parameter in let.value
  def let.name: property in file
  ref use.target, let.value: value "name"
  unique use.target in file "{name} is used twice in {owner}"
}
`;
  const bootstrap = compile(source).parsed;
  const self = grammar.parse(source);
  assert.deepEqual(self.diagnostics, []);
  assert.deepEqual(withoutSpans(self.value), withoutSpans(bootstrap));
  assert.deepEqual((self.value as typeof bootstrap).bind, bootstrap.bind);
  assert.equal(bootstrap.bind?.entries.length, 8);
});

test("a bind block compiles to a spec and checks tags, fields, kinds, and labels", () => {
  const ok = load(`${bindGrammar}
bind {
  export def let.name: variable "value" after
  ref use.target: value "name"
  builtin Int: type
}
`).compiled;
  assert.deepEqual(ok.bind?.defs, [{
    node: "let",
    field: "name",
    kind: "variable",
    label: "value",
    detail: "value",
    owner: null,
    within: null,
    after: true,
    exported: true,
  }]);
  assert.deepEqual(ok.bind?.refs, [{ node: "use", field: "target", label: "value", noun: "name" }]);
  assert.equal(load(bindGrammar).compiled.bind, null);

  const bad = compile(`${bindGrammar}
bind {
  def nope.name: variable
  def let.nope: variable
  def let.name: thing
  ref use.target: missing
  scope let
}
`).compiled;
  assert.equal(bad.valid, false);
  assert.deepEqual(bad.diagnostics.filter((entry) => entry.code === "grammar/bind").map((entry) => entry.message), [
    "Unknown tag @nope in bind",
    "@let has no field nope",
    'Unknown definition kind "thing"',
    'No def or builtin is labelled "missing"',
  ]);
});
