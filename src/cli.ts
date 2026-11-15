#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { discoverConfig, loadProject, type ProjectConfig } from "./config.ts";
import { type Diagnostic, render } from "./diagnostic.ts";
import { compileGrammar } from "./grammar/compile.ts";
import { parseGrammar } from "./grammar/parse.ts";
import { generateTypes } from "./grammar/types.ts";
import { extensionMap, type AnyLanguage } from "./language.ts";
import { ModuleGraph } from "./modules.ts";

const usage = `usage:
  parlance check <file...> [--config <path>]
  parlance emit --target <name> <file> [--out <path>] [--config <path>]
  parlance lsp [--config <path>]
  parlance gen <grammar.parl> <out.ts>`;

const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

const valueOf = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} needs a value`);
  return value;
};

const withoutFlags = (args: readonly string[], flags: readonly string[]): string[] => {
  const result: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (flags.includes(args[index]!)) {
      index++;
      continue;
    }
    result.push(args[index]!);
  }
  return result;
};

const projectFor = async (args: readonly string[]): Promise<ProjectConfig> => {
  const config = valueOf(args, "--config") ?? discoverConfig(process.cwd());
  if (!config) fail("No parlance config found. Pass --config ./parlance.config.ts");
  return loadProject(config!);
};

const print = (file: string, source: string, diagnostics: readonly Diagnostic[]): number => {
  for (const diagnostic of diagnostics) {
    process.stderr.write(`${file}: ${render(diagnostic, source)}\n`);
  }
  return diagnostics.filter((entry) => entry.severity === "error").length;
};

const check = async (args: readonly string[]): Promise<number> => {
  const files = withoutFlags(args, ["--config"]);
  if (files.length === 0) fail(usage);
  const { languages, resolve: resolver } = await projectFor(args);
  const registry = extensionMap(languages);
  const graph = new ModuleGraph({ languages, ...(resolver ? { resolve: resolver } : {}) });
  let errors = 0;
  for (const file of files) {
    const path = resolve(file);
    const language = [...registry].find(([extension]) => path.endsWith(extension))?.[1];
    if (!language) {
      process.stderr.write(`${file}: no registered language for this extension\n`);
      errors++;
      continue;
    }
    const source = readFileSync(path, "utf8");
    const analysis = graph.analyze(path, { source });
    errors += print(file, source, analysis.diagnostics);
    if (analysis.valid) process.stdout.write(`ok ${file}\n`);
  }
  return errors;
};

const emit = async (args: readonly string[]): Promise<number> => {
  const target = valueOf(args, "--target");
  const out = valueOf(args, "--out");
  const files = withoutFlags(args, ["--target", "--out", "--config"]);
  if (!target || files.length !== 1) fail(usage);
  const { languages, resolve: resolver } = await projectFor(args);
  const registry = extensionMap(languages);
  const path = resolve(files[0]!);
  const language = [...registry].find(([extension]) => path.endsWith(extension))?.[1];
  if (!language) fail(`${files[0]}: no registered language for this extension`);
  const source = readFileSync(path, "utf8");
  const analysis = new ModuleGraph({ languages, ...(resolver ? { resolve: resolver } : {}) }).analyze(path, { source });
  if (print(files[0]!, source, analysis.diagnostics) > 0 || analysis.ir === null) return 1;
  const emitTarget = language!.targets?.[target!];
  if (!emitTarget) {
    const available = Object.keys(language!.targets ?? {});
    fail(`${language!.name} has no target ${JSON.stringify(target)}. Available: ${available.join(", ") || "none"}`);
  }
  const artifact = emitTarget!(analysis.ir);
  if (out) {
    writeFileSync(resolve(out), artifact.text);
    process.stdout.write(`wrote ${out} (${Buffer.byteLength(artifact.text, "utf8")} bytes)\n`);
  } else {
    process.stdout.write(artifact.text);
  }
  return 0;
};

const lsp = async (args: readonly string[]): Promise<number> => {
  const { languages, resolve: resolver } = await projectFor(args);
  if (languages.length === 0) fail("The config exports no languages");
  const { serve } = await import("./lsp/server.ts");
  serve(languages, resolver ? { resolve: resolver } : {});
  return 0;
};

const gen = (args: readonly string[]): number => {
  const [grammar, output] = args;
  if (!grammar || !output) fail(usage);
  const source = readFileSync(resolve(grammar!), "utf8");
  const parsed = parseGrammar(source, grammar);
  if (!parsed.ok) return print(grammar!, source, parsed.diagnostics);
  const compiled = compileGrammar(parsed.file, grammar!);
  if (!compiled.valid) return print(grammar!, source, compiled.diagnostics);
  const generated = generateTypes(parsed.file);
  const problems = print(grammar!, source, generated.diagnostics);
  if (problems > 0) return 1;
  writeFileSync(resolve(output!), generated.text);
  process.stdout.write(`wrote ${output} (${Buffer.byteLength(generated.text, "utf8")} bytes)\n`);
  return 0;
};

const main = async (): Promise<number> => {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "check":
      return check(args);
    case "emit":
      return emit(args);
    case "lsp":
      return lsp(args);
    case "gen":
      return gen(args);
    default:
      process.stderr.write(`${usage}\n`);
      return 1;
  }
};

process.exitCode = await main();
