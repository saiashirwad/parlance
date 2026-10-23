/** A UTF-16 half-open range in a document. */
export type Span = { readonly start: number; readonly end: number };

/** Source text plus the span it was read from. */
export type Text = { readonly text: string; readonly span: Span };

export type Edit = { readonly start: number; readonly end: number; readonly insert: string };

export const span = (start: number, end: number): Span => ({ start, end });

export const point = (offset: number): Span => ({ start: offset, end: offset });

export const merge = (left: Span, right: Span): Span => ({
  start: Math.min(left.start, right.start),
  end: Math.max(left.end, right.end),
});

export const contains = (outer: Span, inner: Span): boolean =>
  outer.start <= inner.start && inner.end <= outer.end;

export const overlaps = (a: Span, b: Span): boolean => a.start < b.end && b.start < a.end;

export const empty = (value: Span): boolean => value.start === value.end;

export const text = (source: string, at: Span): Text => ({ text: source.slice(at.start, at.end), span: at });

export const applyEdit = (source: string, edit: Edit): string =>
  source.slice(0, edit.start) + edit.insert + source.slice(edit.end);

export const applyEdits = (source: string, edits: readonly Edit[]): string =>
  [...edits]
    .sort((a, b) => b.start - a.start)
    .reduce((current, edit) => applyEdit(current, edit), source);

export type Position = { readonly line: number; readonly character: number };

/** Line starts are UTF-16 offsets. `\r\n`, `\n`, and `\r` each end a line. */
export const lineStarts = (source: string): readonly number[] => {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);
    if (code === 13) {
      if (source.charCodeAt(index + 1) === 10) index++;
      starts.push(index + 1);
    } else if (code === 10) {
      starts.push(index + 1);
    }
  }
  return starts;
};

export const positionAt = (starts: readonly number[], offset: number): Position => {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low, character: offset - starts[low]! };
};

export const offsetAt = (starts: readonly number[], sourceLength: number, position: Position): number => {
  const line = Math.max(0, Math.min(position.line, starts.length - 1));
  return Math.max(0, Math.min(sourceLength, starts[line]! + Math.max(0, position.character)));
};

export type Source = {
  readonly uri: string;
  readonly text: string;
  readonly lineStarts: readonly number[];
};

export const source = (uri: string, text: string): Source => ({ uri, text, lineStarts: lineStarts(text) });
