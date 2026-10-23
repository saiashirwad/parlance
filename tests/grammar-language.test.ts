import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { definitionAt } from "../src/check/index.ts";
import { grammarLanguage } from "../src/grammar/language.ts";
import { analyze } from "../src/language.ts";

const self = readFileSync(new URL("../src/grammar/grammar.parl", import.meta.url), "utf8");

test("the grammar language analyzes its own source", () => {
  const analysis = analyze(grammarLanguage, self, "src/grammar/grammar.parl");
  assert.deepEqual(analysis.diagnostics, []);
  assert.equal(analysis.valid, true);
  const names = new Set(analysis.facts.definitions.map((definition) => definition.name));
  for (const name of ["Grammar", "File", "Rule", "TokenDecl", "Primary"]) assert.ok(names.has(name), name);
  assert.ok(
    analysis.tokens.some((token) => token.kind === "keyword" && self.slice(token.span.start, token.span.end) === "grammar"),
    "grammar keyword has no semantic token",
  );
  assert.ok(
    analysis.tokens.some((token) => token.kind === "function" && self.slice(token.span.start, token.span.end) === "File"),
    "rule name has no function token",
  );
});

test("grammar static errors arrive with grammar spans", () => {
  const source = "grammar Bad\nroot A\nrule A = { A \"x\" | \"y\" };\n";
  const analysis = analyze(grammarLanguage, source, "memory://bad.parl");
  assert.equal(analysis.valid, false);
  const error = analysis.diagnostics.find((entry) => /Left recursion/.test(entry.message));
  assert.ok(error);
  assert.equal(source.slice(error.span.start, error.span.end), "A");
});

test("rule, token, and root references navigate", () => {
  const source = [
    "grammar Ref",
    "skip /\\s+/",
    "token Number /\\d+/",
    "root File",
    "rule File = { @file items:Decl* };",
    "rule Decl = { @value value:$Number };",
    "",
  ].join("\n");
  const analysis = analyze(grammarLanguage, source, "memory://ref.parl");
  assert.deepEqual(analysis.diagnostics, []);

  const tokenAt = source.indexOf("$Number") + 1;
  const token = definitionAt(analysis.facts, tokenAt);
  assert.equal(token?.name, "Number");
  assert.equal(token?.kind, "constant");
  assert.equal(source.slice(token.span.start, token.span.end), "Number");

  const rootAt = source.indexOf("root File") + "root ".length;
  const root = definitionAt(analysis.facts, rootAt);
  assert.equal(root?.name, "File");
  assert.equal(root?.kind, "function");
  assert.equal(source.slice(root.span.start, root.span.end), "File");
});
