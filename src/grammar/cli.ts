import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Diagnostic, render } from "../diagnostic.ts";
import { compileGrammar } from "./compile.ts";
import { parseGrammar } from "./parse.ts";
import { generateTypes } from "./types.ts";

const usage = "usage: node src/grammar/cli.ts gen <grammar.parl> <out.ts>\n       node src/grammar/cli.ts types <grammar.parl>";

const printDiagnostics = (source: string, diagnostics: readonly Diagnostic[]): void => {
  if (diagnostics.length === 0) return;
  process.stderr.write(`${diagnostics.map((entry) => render(entry, source)).join("\n")}\n`);
};

const load = (path: string) => {
  const source = readFileSync(resolve(path), "utf8");
  const parsed = parseGrammar(source, path);
  if (!parsed.ok) {
    printDiagnostics(source, parsed.diagnostics);
    return null;
  }
  const compiled = compileGrammar(parsed.file, path);
  if (!compiled.valid) {
    printDiagnostics(source, compiled.diagnostics);
    return null;
  }
  return { source, file: parsed.file };
};

const main = (argv: readonly string[]): number => {
  const [command, ...args] = argv;
  if (command === "gen" && args.length === 2) {
    const [grammar, output] = args as [string, string];
    const loaded = load(grammar);
    if (!loaded) return 1;
    const generated = generateTypes(loaded.file);
    printDiagnostics(loaded.source, generated.diagnostics);
    if (generated.diagnostics.some((entry) => entry.severity === "error")) return 1;
    writeFileSync(resolve(output), generated.text);
    process.stdout.write(`wrote ${output} (${Buffer.byteLength(generated.text, "utf8")} bytes)\n`);
    return 0;
  }
  if (command === "types" && args.length === 1) {
    const loaded = load(args[0]!);
    if (!loaded) return 1;
    const generated = generateTypes(loaded.file);
    printDiagnostics(loaded.source, generated.diagnostics);
    if (generated.diagnostics.some((entry) => entry.severity === "error")) return 1;
    process.stdout.write(generated.text);
    return 0;
  }
  process.stderr.write(`${usage}\n`);
  return 1;
};

process.exitCode = main(process.argv.slice(2));
