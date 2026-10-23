import assert from "node:assert/strict";
import test from "node:test";
import { compileGrammar } from "../src/grammar/compile.ts";
import { parseGrammar } from "../src/grammar/parse.ts";

const compile = (source: string) => {
  const parsed = parseGrammar(source);
  assert.equal(parsed.ok, true, parsed.ok ? "" : JSON.stringify(parsed.diagnostics));
  if (!parsed.ok) throw new Error("unreachable");
  const compiled = compileGrammar(parsed.file);
  assert.equal(compiled.valid, true, compiled.diagnostics.map((entry) => entry.message).join("\n"));
  return compiled;
};

test("a custom word pattern advances the lexer", () => {
  const grammar = compile(`
grammar CustomWord
word /[a-z]+/
root File
rule File = { word };
`);
  const tokens = grammar.lex("abc").tokens;
  assert.deepEqual(
    tokens.map((token) => [token.kind, token.text, token.span.start, token.span.end]),
    [["word", "abc", 0, 3], ["eof", "", 3, 3]],
  );
});

test("a custom word pattern coexists with punctuation and trivia", () => {
  const grammar = compile(`
grammar CustomWord
skip /\\s+/
word /[a-z]+/
root File
rule File = { items:word* };
`);
  const tokens = grammar.lex("ab cd\n ef").tokens;
  assert.deepEqual(
    tokens.map((token) => [token.kind, token.text, token.span.start, token.span.end]),
    [["word", "ab", 0, 2], ["word", "cd", 3, 5], ["word", "ef", 7, 9], ["eof", "", 9, 9]],
  );
});
