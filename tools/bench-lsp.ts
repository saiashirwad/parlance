import { performance } from "node:perf_hooks";
import { TextDocument } from "vscode-languageserver-textdocument";
import { analyze, analyzeParsed } from "../src/language.ts";
import { reparse } from "../src/parser/incremental.ts";
import { diff } from "../src/source.ts";
import { encodeAnalysis, folding } from "../src/lsp/semantic.ts";
import { calc } from "../examples/calc/calc.ts";

type Row = {
  readonly name: string;
  readonly bytes: number;
  readonly fullMs: number;
  readonly updateMs: number;
  readonly insertMs: number;
  readonly semanticMs: number;
  readonly foldingMs: number;
};

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

const measure = (body: () => void, warmups = 2, runs = 7): number => {
  for (let index = 0; index < warmups; index++) body();
  const times: number[] = [];
  for (let index = 0; index < runs; index++) {
    const start = performance.now();
    body();
    times.push(performance.now() - start);
  }
  return median(times);
};

const corpus = (count: number): string =>
  Array.from({ length: count }, (_, index) => `let v${index} = ${index} + ${index % 97} * 3;`).join("\n")
  + `\nshow v${count - 1} * 2;\n`;

const rows: Row[] = [];
for (const count of [2_000, 20_000, 100_000]) {
  const source = corpus(count);
  const analysis = analyze(calc, source, "memory://bench.calc");
  if (!analysis.valid) throw new Error(`${count}: corpus does not check`);
  const document = TextDocument.create("memory://bench.calc", "calc", 1, source);

  const middle = source.indexOf(`let v${Math.floor(count / 2)} = `) + `let v${Math.floor(count / 2)} = `.length;
  const digit = source[middle] === "9" ? "1" : "9";
  const replaced = source.slice(0, middle) + digit + source.slice(middle + 1);
  const replacement = diff(source, replaced);
  if (!replacement) throw new Error("no replacement edit");

  const inserted = source.slice(0, middle) + "1" + source.slice(middle);
  const insertion = diff(source, inserted);
  if (!insertion) throw new Error("no insertion edit");

  const update = (next: string, edit: NonNullable<typeof replacement>): void => {
    const parsed = reparse(calc.grammar.spec, analysis.parse, next, edit, { previousSource: source });
    if (parsed.stats.fallback) throw new Error(`${count}: incremental reparse fell back`);
    const updated = analyzeParsed(calc, next, "memory://bench.calc", parsed, parsed.stats);
    if (!updated.valid) throw new Error(`${count}: edited corpus does not check`);
  };

  rows.push({
    name: `calc ${count.toLocaleString("en-US")} decls`,
    bytes: source.length,
    fullMs: measure(() => {
      const fresh = analyze(calc, source, "memory://bench.calc");
      if (!fresh.valid) throw new Error("full analyze failed");
    }, 1, 5),
    updateMs: measure(() => update(replaced, replacement), 1, 7),
    insertMs: measure(() => update(inserted, insertion), 1, 7),
    semanticMs: measure(() => encodeAnalysis(document, analysis), 2, 7),
    foldingMs: measure(() => folding(analysis.lex, document, calc.grammar.spec), 2, 7),
  });
}

console.table(rows.map((row) => ({
  corpus: row.name,
  KB: Math.round(row.bytes / 1024),
  "full analyze ms": row.fullMs.toFixed(2),
  "edit + analyze ms": row.updateMs.toFixed(2),
  "insert + analyze ms": row.insertMs.toFixed(2),
  "semantic tokens ms": row.semanticMs.toFixed(2),
  "folding ms": row.foldingMs.toFixed(2),
})));

if (process.argv.includes("--json")) console.log(JSON.stringify(rows, null, 2));
