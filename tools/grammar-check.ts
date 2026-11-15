#!/usr/bin/env node
/**
 * Compiles every checked-in grammar and proves each generated AST file matches
 * its grammar. This is the guard that catches a `.parl` edit without `parlance gen`.
 *
 * It also runs the self-host check: the grammar language parses itself with its
 * compiled parser and produces the same AST as the bootstrap parser.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withoutSpans } from "../src/grammar/ast.ts";
import { compileGrammar } from "../src/grammar/compile.ts";
import { parseGrammar } from "../src/grammar/parse.ts";
import { generateTypes } from "../src/grammar/types.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

const grammars = [
  { path: "src/grammar/grammar.parl", ast: null },
  { path: "examples/advanced/advanced.parl", ast: "examples/advanced/advanced.ast.ts" },
  { path: "examples/calc/calc.parl", ast: "examples/calc/calc.ast.ts" },
  { path: "examples/schema/schema.parl", ast: "examples/schema/schema.ast.ts" },
  { path: "examples/machine/machine.parl", ast: "examples/machine/machine.ast.ts" },
  { path: "examples/shade/shade.parl", ast: "examples/shade/shade.ast.ts" },
] as const;

const failures: string[] = [];
let compiledCount = 0;
let astCount = 0;

for (const grammar of grammars) {
  const source = readFileSync(`${root}/${grammar.path}`, "utf8");
  const parsed = parseGrammar(source, grammar.path);
  if (!parsed.ok) {
    failures.push(`${grammar.path}: ${parsed.diagnostics.map((entry) => entry.message).join("; ")}`);
    continue;
  }
  const compiled = compileGrammar(parsed.file, grammar.path);
  if (!compiled.valid) {
    failures.push(`${grammar.path}: ${compiled.diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.message).join("; ")}`);
    continue;
  }
  compiledCount++;
  const rules = parsed.file.rules.length;
  const tokens = parsed.file.tokens.length;
  process.stdout.write(`ok ${grammar.path} (${rules} rules, ${tokens} tokens)\n`);

  if (grammar.ast === null) continue;
  const generated = generateTypes(parsed.file);
  if (generated.diagnostics.some((entry) => entry.severity === "error")) {
    failures.push(`${grammar.path}: type generation failed: ${generated.diagnostics.map((entry) => entry.message).join("; ")}`);
    continue;
  }
  const checkedIn = readFileSync(`${root}/${grammar.ast}`, "utf8");
  if (generated.text !== checkedIn) {
    const expected = checkedIn.split("\n");
    const actual = generated.text.split("\n");
    const index = expected.findIndex((line, at) => line !== actual[at]);
    const line = index < 0 ? Math.min(expected.length, actual.length) : index;
    failures.push(
      `${grammar.ast} is stale at line ${line + 1}. Regenerate with:\n`
        + `  node src/grammar/cli.ts gen ${grammar.path} ${grammar.ast}\n`
        + `  - ${expected[line] ?? "<end>"}\n  + ${actual[line] ?? "<end>"}`,
    );
    continue;
  }
  astCount++;
  process.stdout.write(`ok ${grammar.ast} is current\n`);
}

const self = readFileSync(`${root}/src/grammar/grammar.parl`, "utf8");
const bootstrapped = parseGrammar(self, "src/grammar/grammar.parl");
if (!bootstrapped.ok) {
  failures.push(`self-host bootstrap parse failed: ${bootstrapped.diagnostics.map((entry) => entry.message).join("; ")}`);
} else {
  const compiler = compileGrammar(bootstrapped.file, "src/grammar/grammar.parl");
  const reparsed = compiler.parse(self);
  if (reparsed.diagnostics.length > 0) {
    failures.push(`self-host compiled parse reported: ${reparsed.diagnostics.map((entry) => entry.message).join("; ")}`);
  } else if (JSON.stringify(withoutSpans(reparsed.value)) !== JSON.stringify(withoutSpans(bootstrapped.file))) {
    failures.push("self-host AST differs from the bootstrap AST");
  } else {
    process.stdout.write("ok self-host: compiled grammar parses itself with the bootstrap AST\n");
  }
}

if (failures.length > 0) {
  process.stderr.write(`\n${failures.map((failure) => `FAIL ${failure}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`\nok ${compiledCount} grammars, ${astCount} generated ASTs current, self-host current\n`);
}
