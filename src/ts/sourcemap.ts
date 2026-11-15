import type { TsDoc } from "./template.ts";

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const vlq = (value: number): string => {
  let rest = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = "";
  do {
    let digit = rest & 31;
    rest >>>= 5;
    if (rest > 0) digit |= 32;
    out += BASE64[digit];
  } while (rest > 0);
  return out;
};

const lineStarts = (text: string): number[] => {
  const starts = [0];
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) starts.push(index + 1);
  return starts;
};

/** The line whose start is the last one at or before `offset`. */
const lineOf = (starts: readonly number[], offset: number): number => {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
};

export type RawSourceMap = {
  readonly version: 3;
  readonly sources: readonly string[];
  readonly sourcesContent: readonly string[];
  readonly names: readonly string[];
  readonly mappings: string;
};

/**
 * A v3 source map from a document's mappings to the guest `source` it was emitted from. Each mapping
 * starts a segment at its original start; the text after it, up to the next mapping, is left unmapped.
 */
export const sourceMap = (doc: TsDoc, source: string, url: string): RawSourceMap => {
  const generated = lineStarts(doc.text);
  const original = lineStarts(source);
  const ordered = doc.mappings.filter((mapping) => mapping[1] > 0).sort((a, b) => a[0] - b[0]);
  const lines: string[][] = generated.map(() => []);
  let previousLine = 0;
  let previousColumn = 0;
  const columns: number[] = generated.map(() => 0);
  for (let index = 0; index < ordered.length; index++) {
    const [virtual, length, start] = ordered[index]!;
    const line = lineOf(generated, virtual);
    const column = virtual - generated[line]!;
    const sourceLine = lineOf(original, start);
    const sourceColumn = start - original[sourceLine]!;
    const next = ordered[index + 1];
    const end = virtual + length;
    const row = lines[line]!;
    // Segment columns are relative to the previous segment on the same line.
    row.push(vlq(column - columns[line]!) + vlq(0) + vlq(sourceLine - previousLine) + vlq(sourceColumn - previousColumn));
    columns[line] = column;
    previousLine = sourceLine;
    previousColumn = sourceColumn;
    if ((next === undefined || next[0] > end) && end < doc.text.length && lineOf(generated, end) === line) {
      row.push(vlq(end - generated[line]! - columns[line]!));
      columns[line] = end - generated[line]!;
    }
  }
  return {
    version: 3,
    sources: [url],
    sourcesContent: [source],
    names: [],
    mappings: lines.map((row) => row.join(",")).join(";"),
  };
};

/** The document's text with an inline source map, so `node --enable-source-maps` reports guest positions. */
export const withSourceMap = (doc: TsDoc, source: string, url: string): string => {
  const encoded = Buffer.from(JSON.stringify(sourceMap(doc, source, url))).toString("base64");
  const text = doc.text.endsWith("\n") ? doc.text : `${doc.text}\n`;
  return `${text}//# sourceMappingURL=data:application/json;base64,${encoded}\n`;
};
