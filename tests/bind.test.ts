import assert from "node:assert/strict";
import test from "node:test";
import { bind, type Bound, visibleAt } from "../src/check/index.ts";
import { compileSource } from "../src/grammar/compile.ts";
import { analyze, defineLanguage } from "../src/language.ts";
import type { Text } from "../src/source.ts";

const grammar = compileSource(`grammar Scoped
skip /\\s+/
root File
rule File = { @file items:Item* };
rule Item = {
  | @use "use" path:Name ";"
  | @let "let" name:Name "=" value:Expr ";"
  | @record "record" name:Name "{" fields:Field* "}"
  | @show "show" value:Expr ";"
};
rule Field = { @field name:Name ":" type:Name ";" };
rule Expr = {
  | @fn "fn" param:Name "=>" body:Expr
  | @local "local" name:Name "=" value:Expr "in" body:Expr
  | @name value:Name
};
rule Name = { word };

bind {
  import use.path
  def record.name: type
  def field.name: property "field" in record
  builtin Int, String: type
  ref field.type: type
  export def let.name: variable after
  def fn.param: parameter "variable" in fn.body
  def local.name: variable in local.body
  ref name.value: variable "name"
  unique field.type in record "{owner} repeats {name}"
}
`);
if ("error" in grammar) throw new Error(grammar.error.message);
assert.equal(grammar.valid, true, grammar.diagnostics.map((entry) => entry.message).join("\n"));

let bound: Bound<string> | undefined;
const scoped = defineLanguage<any, null, string>({
  name: "scoped",
  extensions: [".scoped"],
  grammar,
  check: (file, cx) => {
    cx.bind(cx.declare("host", { start: 0, end: 0 }, "variable", "manual"));
    bound = bind(file, cx, grammar.bind!, { builtin: (name) => `builtin ${name}` });
    for (const item of file.items) if (item.kind === "let") bound.define(item, `let ${item.name.text}`);
    return null;
  },
});

const messages = (source: string): string[] => analyze(scoped, source).diagnostics.map((entry) => entry.message);
const site = (source: string, needle: string, occurrence = 0): number => {
  let at = -1;
  for (let index = 0; index <= occurrence; index++) at = source.indexOf(needle, at + 1);
  return at;
};

test("bind: let is sequential, fn and local bind only in their body field", () => {
  assert.deepEqual(messages("let a = b;\nlet b = a;\nshow c;\n"), ['Unknown name "b"', 'Unknown name "c"']);
  assert.deepEqual(messages("show fn x => x;\nshow x;\n"), ['Unknown name "x"']);
  assert.deepEqual(messages("show local y = y in y;\n"), ['Unknown name "y"']);
  assert.deepEqual(messages("let a = host;\nlet a = a;\n"), ['Duplicate name "a"']);
  assert.deepEqual(messages("let host = 1;\n".replace("1", "host")), ['Duplicate name "host"']);
});

test("bind: members, builtins, unique, and the manual fallback", () => {
  const source = "record P { x: Int; x: String; y: Bogus; z: Int; }\nlet q = host;\n";
  assert.deepEqual(messages(source), [
    'Duplicate field "x"',
    'Unknown type "Bogus"',
    'P repeats "Int"',
  ]);
  const analysis = analyze(scoped, source);
  const file = analysis.tree as any;
  const record = file.items[0];
  assert.deepEqual(bound!.members<{ name: Text }>(record).map((field) => field.name.text), ["x", "y", "z"]);
  assert.equal(bound!.builtin(record.fields[0].type), "Int");
  assert.equal(bound!.duplicate(record.fields[3].type), true);
  const host = file.items[1].value.value;
  assert.equal(bound!.resolved(host)?.type, "manual");
  assert.ok(analysis.facts.references.some((reference) => reference.span.start === host.span.start));
});

test("bind: define settles types at the definition and every reference", () => {
  const source = "let a = host;\nshow a;\nshow a;\n";
  const analysis = analyze(scoped, source);
  const definition = analysis.facts.definitions.find((entry) => entry.name === "a")!;
  assert.equal(definition.type, "let a");
  for (const occurrence of [1, 2]) {
    const at = site(source, "show a", occurrence - 1) + 5;
    assert.ok(analysis.facts.types.some((typed) => typed.span.start === at && typed.type === "let a"), `typed at ${at}`);
  }
  assert.deepEqual(bound!.exports.map((binding) => binding.type), ["let a"]);
  assert.equal(bound!.used(definition), true);
});

test("bind: scope extents record where each name is visible", () => {
  const source = "let a = host;\nshow fn x => local y = x in y;\n";
  const analysis = analyze(scoped, source);
  const names = (offset: number) => visibleAt(analysis.facts, offset).map((definition) => definition.name);
  assert.deepEqual(names(site(source, "host")), []);
  assert.deepEqual(names(site(source, "show")), ["a"]);
  assert.deepEqual(names(site(source, "x", 1)), ["x", "a"]);
  assert.deepEqual(names(site(source, "y", 1)), ["y", "x", "a"]);
});

test("bind: defineLanguage derives imports and builtin completions", () => {
  const analysis = analyze(scoped, "use lib;\n");
  assert.deepEqual(scoped.imports!(analysis.tree).map((entry) => entry.specifier), ["lib"]);
  assert.deepEqual(scoped.completions, [
    { label: "Int", kind: "type", detail: "type" },
    { label: "String", kind: "type", detail: "type" },
  ]);
});
