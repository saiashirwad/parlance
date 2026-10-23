import { performance } from "node:perf_hooks";
import { analyze, analyzeParsed } from "../src/language.ts";
import type { CompiledGrammar } from "../src/grammar/compile.ts";
import { reparse } from "../src/parser/incremental.ts";
import { diff } from "../src/source.ts";
import { calc } from "../examples/calc/calc.ts";
import { schema } from "../examples/schema/schema.ts";

type Result = {
  readonly name: string;
  readonly bytes: number;
  readonly tokens: number;
  readonly lexMs: number;
  readonly parseMs: number;
  readonly mbPerSecond: number;
  readonly incrementalMs: number | null;
  readonly reused: number | null;
  readonly reparsed: number | null;
  readonly fallback: boolean | null;
};

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

const measure = (name: string, grammar: CompiledGrammar<any>, source: string, editAt: number): Result => {
  const lexical = grammar.lex(source);
  const lexRuns: number[] = [];
  const parseRuns: number[] = [];
  for (let run = 0; run < 4; run++) {
    const lexStart = performance.now();
    grammar.lex(source);
    lexRuns.push(performance.now() - lexStart);
    const parseStart = performance.now();
    const parsed = grammar.parse(source);
    parseRuns.push(performance.now() - parseStart);
    if (!parsed.ok) throw new Error(`${name}: generated corpus does not parse`);
  }
  const parseMs = median(parseRuns);
  const lexMs = median(lexRuns);
  const replacement = source[editAt] === "7" ? "8" : "7";
  const before = source.slice(0, editAt) + replacement + source.slice(editAt + 1);
  const previous = grammar.parse(source);
  if (!previous.ok) throw new Error(`${name}: previous corpus does not parse`);
  const edit = diff(source, before);
  if (!edit) throw new Error(`${name}: edit did not change the corpus`);
  const runs: number[] = [];
  let last = reparse(grammar.spec, previous, before, edit, { previousSource: source, verify: true });
  for (let run = 0; run < 5; run++) {
    const start = performance.now();
    last = reparse(grammar.spec, previous, before, edit, { previousSource: source, verify: false });
    runs.push(performance.now() - start);
  }
  if (last.stats.fallback) throw new Error(`${name}: incremental reparse fell back`);
  return {
    name,
    bytes: source.length,
    tokens: lexical.tokens.length,
    lexMs,
    parseMs,
    mbPerSecond: source.length / 1e6 / (parseMs / 1000),
    incrementalMs: median(runs),
    reused: last.stats.reused,
    reparsed: last.stats.reparsed,
    fallback: last.stats.fallback,
  };
};

const calcCorpus = (count: number): string => {
  const lines: string[] = [];
  for (let index = 0; index < count; index++) lines.push(`let v${index} = ${index} + ${index % 97} * 3;`);
  lines.push(`show v${count - 1} * 2;`);
  return lines.join("\n") + "\n";
};

const schemaCorpus = (count: number): string => {
  const lines = ["schema Bench", ""];
  for (let index = 0; index < count; index++) {
    lines.push(
      `model M${index} {`,
      `  id: Int @primary @auto`,
      `  name: String @unique`,
      `  count: Int`,
      `}`,
      "",
      `query byId${index}(id: Int): M${index}? = M${index} |> where id == id |> first;`,
      "",
    );
  }
  return lines.join("\n");
};

const results: Result[] = [];
for (const count of [2_000, 20_000, 100_000]) {
  const source = calcCorpus(count);
  const at = source.indexOf("let v" + Math.floor(count / 2)) + "let v".length;
  results.push(measure(`calc ${count} decls`, calc.grammar, source, at));
}
for (const count of [50, 500]) {
  const source = schemaCorpus(count);
  results.push(measure(`schema ${count} models`, schema.grammar, source, source.indexOf("model M" + Math.floor(count / 2)) + 8));
}

console.table(results.map((result) => ({
  name: result.name,
  KB: Math.round(result.bytes / 1024),
  tokens: result.tokens,
  "lex ms": result.lexMs.toFixed(2),
  "parse ms": result.parseMs.toFixed(2),
  "MB/s": result.mbPerSecond.toFixed(1),
  "edit ms": result.incrementalMs?.toFixed(3) ?? "-",
  reused: result.reused ?? "-",
  reparsed: result.reparsed ?? "-",
})));

if (process.argv.includes("--json")) console.log(JSON.stringify(results, null, 2));

const sample = calcCorpus(200);
const analysis = analyze(calc, sample, "memory://bench.calc");
if (!analysis.valid) throw new Error("calc sample does not check");
const edit = diff(sample, sample.replace("let v10 = 10 +", "let v10 = 11 +"));
if (!edit) throw new Error("no sample edit");
const changed = sample.replace("let v10 = 10 +", "let v10 = 11 +");
const parsed = reparse(calc.grammar.spec, analysis.parse, changed, edit, { previousSource: sample });
const updated = analyzeParsed(calc, changed, "memory://bench.calc", parsed, parsed.stats);
if (!updated.valid) throw new Error("incremental analysis does not check");
