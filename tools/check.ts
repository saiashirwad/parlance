#!/usr/bin/env node
/**
 * One command that proves the whole stack on the real paths.
 *
 *   node tools/check.ts            typecheck, tests, examples, LSP, tsgo navigation
 *   node tools/check.ts --bench    the above plus the benchmark smoke
 *
 * Every step runs the shipped artifact: the CLI, the Node loader, the LSP
 * process, and the real content mapper. No step imports an internal helper
 * in place of the path a user takes.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

type Step = {
  readonly name: string;
  readonly command: readonly string[];
  readonly expect?: readonly string[];
  readonly bench?: boolean;
};

const root = fileURLToPath(new URL("..", import.meta.url));
const bench = process.argv.includes("--bench");
const json = process.argv.includes("--json");

const steps: readonly Step[] = [
  { name: "typecheck", command: ["pnpm", "typecheck"] },
  { name: "unit + property tests", command: ["pnpm", "test"] },
  {
    name: "grammar and generated AST drift",
    command: ["node", "tools/grammar-check.ts"],
    expect: ["self-host: compiled grammar parses itself"],
  },
  {
    name: "check four example languages",
    command: [
      "./parlance",
      "check",
      "examples/advanced/main.advanced",
      "examples/calc/demo.calc",
      "examples/schema/blog.schema",
      "examples/machine/order.machine",
    ],
    expect: [
      "ok examples/advanced/main.advanced",
      "ok examples/calc/demo.calc",
      "ok examples/schema/blog.schema",
      "ok examples/machine/order.machine",
    ],
  },
  {
    name: "check cross-file examples",
    command: ["./parlance", "check", "examples/schema/catalog.schema", "examples/calc/imports.calc"],
    expect: ["ok examples/schema/catalog.schema", "ok examples/calc/imports.calc"],
  },
  {
    name: "check the grammar language",
    command: ["./parlance", "check", "src/grammar/grammar.parl"],
    expect: ["ok src/grammar/grammar.parl"],
  },
  {
    name: "run advanced through the Node loader",
    command: ["node", "--import", "./examples/register.ts", "examples/typescript/advanced.ts"],
    expect: ["The answer is:\n49\n49 10 20 2 20 true 7"],
  },
  {
    name: "run calc through the Node loader",
    command: ["node", "--import", "./examples/register.ts", "examples/typescript/calc.ts"],
    expect: ["250\n250 125 true"],
  },
  {
    name: "run calc that imports TypeScript through the Node loader",
    command: ["node", "--import", "./examples/register.ts", "examples/typescript/runpriced.ts"],
    expect: ["tax: 20 20"],
  },
  {
    name: "run imported examples through the Node loader",
    command: [
      "node",
      "--import",
      "./examples/register.ts",
      "--input-type=module",
      "-e",
      "const calc = await import('./examples/calc/imports.calc'); const schema = await import('./examples/schema/catalog.schema'); console.log(calc.default, schema.sql.includes('Catalog') && schema.sql.includes('User'));",
    ],
    expect: ["250 true"],
  },
  {
    name: "run schema against node:sqlite",
    command: ["node", "--import", "./examples/register.ts", "examples/typescript/schema.ts"],
    expect: ["sai@example.com 1 1 0 1 1 1 0"],
  },
  {
    name: "run imported schema through TypeScript",
    command: ["node", "--import", "./examples/register.ts", "examples/typescript/catalog.ts"],
    expect: ["1 1 Tools"],
  },
  {
    name: "run machine through the Node loader",
    command: ["node", "--import", "./examples/register.ts", "examples/typescript/machine.ts"],
    expect: ["Paid Checkout Paid pay 50"],
  },
  { name: "drive the real LSP over an edit", command: ["node", "tools/lsp-smoke.ts"], expect: ["ok lsp edit scenario"] },
  { name: "tsgo navigates into guest files", command: ["node", "--test", "tests/tsgo.test.ts"] },
  { name: "benchmark smoke", command: ["node", "tools/bench.ts"], expect: ["calc 100000 decls"], bench: true },
];

type Result = {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly command: string;
  readonly output: string;
};

const tail = (value: string, lines = 40): string => value.trimEnd().split("\n").slice(-lines).join("\n");

const run = (step: Step): Result => {
  const started = performance.now();
  const process_ = spawnSync(step.command[0]!, step.command.slice(1), {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  const output = `${process_.stdout ?? ""}${process_.stderr ?? ""}`;
  const missing = (step.expect ?? []).filter((line) => !output.includes(line));
  return {
    name: step.name,
    ok: process_.status === 0 && missing.length === 0,
    ms: Math.round(performance.now() - started),
    command: step.command.join(" "),
    output: missing.length > 0 ? `missing expected output: ${missing.join(", ")}\n${output}` : output,
  };
};

const selected = steps.filter((step) => bench || !step.bench);
const results: Result[] = [];
for (const step of selected) {
  if (!json) process.stdout.write(`… ${step.name}\n`);
  const result = run(step);
  results.push(result);
  if (!json) {
    process.stdout.write(
      `${result.ok ? "ok" : "FAIL"} ${step.name} ${result.ms}ms\n${result.ok ? "" : `${tail(result.output)}\n`}`,
    );
  }
}

if (json) {
  process.stdout.write(`${JSON.stringify(results.map(({ output, ...rest }) => ({ ...rest, output: rest.ok ? "" : tail(output) })), null, 2)}\n`);
}

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  process.stderr.write(`\n${failed.length} step(s) failed:\n`);
  for (const result of failed) process.stderr.write(`  ${result.command}\n`);
  process.exitCode = 1;
} else if (!json) {
  const total = results.reduce((sum, result) => sum + result.ms, 0);
  process.stdout.write(`\nall ${results.length} steps passed in ${(total / 1000).toFixed(1)}s\n`);
}
