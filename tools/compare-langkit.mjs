#!/usr/bin/env node
/**
 * Compare the grammar-driven parser in this checkout with the older langkit
 * checkout on the same grammar and the same generated corpus.
 *
 *   node tools/compare-langkit.mjs [--langkit <path>] [--json]
 *
 * This is a parser-throughput comparison, not a language-semantics comparison:
 * both grammars accept `let name = number;` declarations. The old parser builds
 * parserator closures; the new parser compiles to a token array + loops.
 */
import { cpus, homedir, loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = args.indexOf("--langkit");
const oldRoot = flag >= 0 ? args[flag + 1] : `${homedir()}/code/langkit`;
const json = args.includes("--json");
const gate = args.includes("--gate");
const force = args.includes("--force");
const ratioFlag = args.indexOf("--max-ratio");
const maxRatio = ratioFlag >= 0 ? Number(args[ratioFlag + 1]) : 0.75;
const loadFlag = args.indexOf("--max-load-per-core");
const maxLoadPerCore = loadFlag >= 0 ? Number(args[loadFlag + 1]) : 0.75;
if (!Number.isFinite(maxRatio) || maxRatio <= 0) throw new Error("--max-ratio must be a positive number");
if (!Number.isFinite(maxLoadPerCore) || maxLoadPerCore < 0) {
  throw new Error("--max-load-per-core must be zero or a positive number");
}
const loadPerCore = () => loadavg()[0] / cpus().length;
if (gate && !force && loadPerCore() > maxLoadPerCore) {
  console.error(
    `Refusing the performance gate: load ${loadavg()[0].toFixed(2)} over ${cpus().length} cores is above ${
      maxLoadPerCore.toFixed(2)
    } per core. Use --force to run anyway.`,
  );
  process.exit(2);
}

const oldGrammar = `grammar Common

skip = /\\s+/
word = /[A-Za-z_][A-Za-z0-9_]*/
token Number = /\\d+/

File = declarations:Decl*

Decl = #let "let" ~ name:Name "=" value:Number ";"

Name = name:ident
`;

const newGrammar = `grammar Common

skip /\\s+/
word /[A-Za-z_][A-Za-z0-9_]*/
token Number /\\d+/

root File

rule File = { @file declarations:Decl* };

rule Decl = { @let "let" ~ name:Name "=" value:$Number ";" };

rule Name = { word };
`;

const corpus = (count) =>
  Array.from({ length: count }, (_, index) => `let v${index} = ${index};`).join("\n") + "\n";

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const measure = (body, warmups = 2, runs = 7) => {
  for (let index = 0; index < warmups; index++) body();
  const times = [];
  for (let index = 0; index < runs; index++) {
    const start = performance.now();
    body();
    times.push(performance.now() - start);
  }
  return median(times);
};

/** Interleaves the two parsers so load drift hits both sides. */
const compare = (oldBody, newBody, warmups = 2, runs = 7) => {
  for (let index = 0; index < warmups; index++) {
    oldBody();
    newBody();
  }
  const oldTimes = [];
  const newTimes = [];
  for (let index = 0; index < runs; index++) {
    let start = performance.now();
    oldBody();
    oldTimes.push(performance.now() - start);
    start = performance.now();
    newBody();
    newTimes.push(performance.now() - start);
  }
  return [median(oldTimes), median(newTimes)];
};

const message = (error) => error instanceof Error ? error.message : String(error);
const oldModule = (name) => pathToFileURL(`${oldRoot}/examples/grammar/${name}`).href;

let old;
let current;
try {
  old = {
    grammar: await import(oldModule("grammar.ts")),
    model: await import(oldModule("grammar-model.ts")),
    runtime: await import(oldModule("runtime.ts")),
  };
  current = {
    parse: await import("../src/grammar/parse.ts"),
    compile: await import("../src/grammar/compile.ts"),
  };
} catch (error) {
  console.error(`Cannot load both checkouts: ${message(error)}`);
  console.error(`Pass --langkit <path> (looked in ${oldRoot}).`);
  process.exit(1);
}

const oldCompile = measure(() => {
  const checked = old.grammar.checkSource(oldGrammar);
  if (!checked.success) throw new Error(`old grammar rejected: ${JSON.stringify(checked.errors[0])}`);
  // Match the new side's "grammar -> callable parser" measurement.
  old.runtime.define(old.model.wire(checked.value));
  return checked.value;
}, 1, 5);
const oldChecked = old.grammar.checkSource(oldGrammar);
if (!oldChecked.success) throw new Error(`old grammar rejected: ${JSON.stringify(oldChecked.errors[0])}`);
const oldGenerated = old.runtime.define(old.model.wire(oldChecked.value)).parse;

const newParsed = current.parse.parseGrammar(newGrammar);
if (!newParsed.ok) throw new Error(`new grammar rejected: ${JSON.stringify(newParsed.diagnostics[0])}`);
const newCompiled = current.compile.compileGrammar(newParsed.file);
if (!newCompiled.valid) throw new Error(`new grammar rejected: ${newCompiled.diagnostics.map((entry) => entry.message).join("; ")}`);

const newCompile = measure(() => {
  const parsed = current.parse.parseGrammar(newGrammar);
  if (!parsed.ok) throw new Error("new grammar stopped parsing");
  const compiled = current.compile.compileGrammar(parsed.file);
  if (!compiled.valid) throw new Error("new grammar stopped compiling");
  return compiled;
}, 1, 5);

const rows = [];
for (const count of [20_000, 100_000, 200_000]) {
  const source = corpus(count);
  const oldResult = oldGenerated(source);
  if (!oldResult.success) throw new Error(`old parser rejected the ${count}-declaration corpus`);
  const newResult = newCompiled.parse(source);
  if (!newResult.ok) throw new Error(`new parser rejected the ${count}-declaration corpus`);

  const oldDeclarations = oldResult.value?.declarations?.length;
  const newDeclarations = newResult.value?.declarations?.length;
  if (oldDeclarations !== count || newDeclarations !== count) {
    throw new Error(`declaration count mismatch: old ${oldDeclarations}, new ${newDeclarations}, expected ${count}`);
  }

  const [oldMs, newMs] = compare(
    () => {
      if (!oldGenerated(source).success) throw new Error("old parse failed during timing");
    },
    () => {
      if (!newCompiled.parse(source).ok) throw new Error("new parse failed during timing");
    },
  );

  const editAt = source.indexOf(`let v${Math.floor(count / 2)} = `) + `let v${Math.floor(count / 2)} = `.length;
  const edited = source.slice(0, editAt) + "1" + source.slice(editAt + 1);
  const previous = newCompiled.parse(source);
  const edit = { start: editAt, end: editAt + 1, insert: "1" };
  const { reparse } = await import("../src/parser/incremental.ts");
  const incrementalMs = measure(() => {
    const result = reparse(newCompiled.spec, previous, edited, edit, { previousSource: source, verify: false });
    if (result.stats.fallback) throw new Error("incremental parse fell back");
  }, 1, 5);

  const mb = source.length / 1e6;
  rows.push({
    declarations: count,
    bytes: source.length,
    oldMs,
    newMs,
    oldMbPerSecond: mb / (oldMs / 1000),
    newMbPerSecond: mb / (newMs / 1000),
    ratio: newMs / oldMs,
    incrementalMs,
  });
}

const result = {
  oldRoot,
  compile: { oldMs: oldCompile, newMs: newCompile },
  rows,
  node: process.version,
  cores: cpus().length,
  load: loadavg().map((value) => Number(value.toFixed(2))),
};

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`old langkit: ${oldRoot}`);
  console.log(`node ${result.node}, ${result.cores} cores, load ${result.load.join(" ")}\n`);
  console.log("| corpus | old langkit | parlance | parlance / old |");
  console.log("| --- | ---: | ---: | ---: |");
  console.log(
    `| compile grammar -> parser | ${oldCompile.toFixed(2)} ms | ${newCompile.toFixed(2)} ms | ${
      (newCompile / oldCompile).toFixed(2)
    }x |`,
  );
  for (const row of rows) {
    console.log(
      `| ${row.declarations.toLocaleString("en-US")} declarations (${(row.bytes / 1e6).toFixed(2)} MB) | ${
        row.oldMs.toFixed(1)
      } ms (${row.oldMbPerSecond.toFixed(1)} MB/s) | ${row.newMs.toFixed(1)} ms (${
        row.newMbPerSecond.toFixed(1)
      } MB/s) | ${row.ratio.toFixed(2)}x |`,
    );
  }
  console.log("\nIncremental middle edit (new only):");
  for (const row of rows) {
    console.log(
      `- ${row.declarations.toLocaleString("en-US")} declarations: ${row.incrementalMs.toFixed(1)} ms, ${
        (row.incrementalMs / row.newMs * 100).toFixed(1)
      }% of a full parse`,
    );
  }
  console.log("\nDifferent grammars and AST shapes: compare parser throughput, not checking or memory.");
}

if (gate) {
  const failures = rows.filter((row) => row.ratio > maxRatio);
  if (failures.length > 0) {
    for (const row of failures) {
      console.error(
        `performance gate failed: ${row.declarations.toLocaleString("en-US")} declarations is ${row.ratio.toFixed(2)}x the old parser (limit ${maxRatio.toFixed(2)}x)`,
      );
    }
    process.exitCode = 1;
  } else {
    console.error(`performance gate passed: every corpus is at most ${maxRatio.toFixed(2)}x the old parser`);
  }
}
