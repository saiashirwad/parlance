import { type Diagnostic, sortDiagnostics } from "../diagnostic.ts";
import { type Span } from "../source.ts";
import { lex } from "./lex.ts";
import {
  type Edit,
  type ItemRange,
  type ParseOptions,
  type ParseResult,
  parseItemRange,
  parseSource,
} from "./parse.ts";
import type { GrammarSpec, Key, LexToken } from "./spec.ts";

export type IncrementalOptions = ParseOptions & {
  /** Compare against a full parse and fall back on any difference. */
  readonly verify?: boolean;
  /** The source `previous` was parsed from, used for the reuse soundness guard. */
  readonly previousSource?: string;
  /** Shift reused ASTs in place. Only for callers that discard `previous` immediately. */
  readonly mutate?: boolean;
};

export type IncrementalStats = {
  readonly fallback: boolean;
  readonly reused: number;
  readonly reparsed: number;
  /** Half-open range of item indexes in the new item list. */
  readonly window: readonly [number, number];
};

export type IncrementalResult<A = unknown> = ParseResult<A> & { readonly stats: IncrementalStats };

type Item = { readonly kind: string; readonly span: Span };

const isItem = (value: unknown): value is Item => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.kind !== "string") return false;
  const span = record.span;
  if (span === null || typeof span !== "object") return false;
  const offsets = span as Record<string, unknown>;
  return typeof offsets.start === "number" && typeof offsets.end === "number";
};

const extractItems = (spec: GrammarSpec, value: unknown): readonly Item[] | null => {
  const incremental = spec.incremental;
  if (!incremental || value === null || typeof value !== "object") return null;
  if (incremental.shape === "field" && incremental.field === null) return null;
  const list = incremental.shape === "array"
    ? value
    : (value as Record<string, unknown>)[incremental.field!];
  if (!Array.isArray(list)) return null;
  for (const item of list) if (!isItem(item)) return null;
  return list as readonly Item[];
};

const ordered = (items: readonly unknown[], limit: number): items is readonly Item[] => {
  let previousEnd = 0;
  for (const item of items) {
    if (!isItem(item)) return false;
    const { start, end } = item.span;
    if (start < 0 || start > end || end > limit || start < previousEnd) return false;
    previousEnd = end;
  }
  return true;
};

const startTokenAt = (tokens: readonly LexToken[], offset: number): number => {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (tokens[middle]!.span.end <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.min(low, tokens.length - 1);
};

const stopTokenAt = (tokens: readonly LexToken[], offset: number): number => {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (tokens[middle]!.span.start < offset) low = middle + 1;
    else high = middle;
  }
  return Math.min(low, tokens.length - 1);
};

const startsItem = (token: LexToken, sync: ReadonlySet<Key>): boolean => {
  switch (token.kind) {
    case "word":
      return sync.has(`word:${token.text}`) || sync.has("word");
    case "symbol":
      return sync.has(`symbol:${token.text}`);
    case "token":
      return sync.has(`token:${token.name}`);
    case "regex":
      return sync.has(`regex:${token.index ?? 0}`);
    case "eof":
      return false;
    case "error":
      return sync.has(`symbol:${token.text}`);
  }
};

const selectWindow = (items: readonly Item[], edit: Edit): readonly [number, number] => {
  const count = items.length;
  if (count === 0) return [-1, -1];
  let low = -1;
  let high = -1;
  for (let index = 0; index < count; index++) {
    const span = items[index]!.span;
    if (span.end > edit.start && span.start < edit.end) {
      if (low < 0) low = index;
      high = index;
    }
  }
  if (low < 0) {
    let before = -1;
    let after = -1;
    for (let index = 0; index < count; index++) {
      const span = items[index]!.span;
      if (span.end <= edit.start) before = index;
      if (after < 0 && span.start >= edit.end) after = index;
    }
    if (before >= 0 && after >= 0) {
      low = before;
      high = after;
    } else if (before >= 0) low = high = before;
    else if (after >= 0) low = high = after;
    else return [0, count - 1];
  }
  return [Math.max(0, low - 1), Math.min(count - 1, high + 1)];
};

export const reparse = <A>(
  spec: GrammarSpec,
  previous: ParseResult<A>,
  source: string,
  edit: Edit,
  options: IncrementalOptions = {},
): IncrementalResult<A> => {
  const parseOptions: ParseOptions = options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth };
  const delta = edit.insert.length - (edit.end - edit.start);
  const oldLength = options.previousSource?.length ?? source.length - delta;
  const full = (): ParseResult<A> => parseSource<A>(spec, source, parseOptions);
  const itemsOf = (value: unknown): readonly Item[] | null => extractItems(spec, value);
  const fallback = (): IncrementalResult<A> => {
    const result = full();
    const count = itemsOf(result.value)?.length ?? 0;
    return { ...result, stats: { fallback: true, reused: 0, reparsed: count, window: [0, count] } };
  };

  const incremental = spec.incremental;
  if (!incremental || previous.value === null) return fallback();
  const items = itemsOf(previous.value);
  if (!items || !ordered(items, oldLength)) return fallback();
  if (edit.start < 0 || edit.end < edit.start || edit.end > oldLength) return fallback();
  if (oldLength + delta !== source.length) return fallback();
  if (options.previousSource !== undefined) {
    const expected = options.previousSource.slice(0, edit.start)
      + edit.insert
      + options.previousSource.slice(edit.end);
    if (expected !== source) return fallback();
  }

  if (incremental.shape === "field") {
    const field = incremental.field;
    if (field === null) return fallback();
    const root = previous.value as Record<string, unknown>;
    if (typeof root.kind !== "string" || !Array.isArray(root[field])) return fallback();
    for (const key of Object.keys(root)) {
      if (key === "kind" || key === "span" || key === field) continue;
      const extra = root[key];
      if (extra === null || typeof extra !== "object") continue;
      const extraSpan = (extra as { readonly span?: Span; }).span;
      if (!extraSpan) return fallback();
      if (extraSpan.start < edit.end && edit.start < extraSpan.end) return fallback();
    }
    if (items.length > 0) {
      const rootSpan = root.span as Span | undefined;
      if (!rootSpan || rootSpan.start > items[0]!.span.start || rootSpan.end < items[items.length - 1]!.span.end) {
        return fallback();
      }
    }
  }

  const mapOffset = (offset: number): number =>
    offset <= edit.start ? offset : offset >= edit.end ? offset + delta : edit.start + edit.insert.length;
  // A boundary that sits exactly on an insertion belongs to the text after it.
  const mapEnd = (offset: number): number =>
    offset < edit.start ? offset : offset >= edit.end ? offset + delta : edit.start + edit.insert.length;

  const lexed = lex(spec, source);
  // Tokenization outside the edit must be unchanged. A broken quote or comment
  // can merge tokens far past the edited item; comparing the reused token tail
  // catches that before any AST is reused.
  const tokensOutsideEdit = (): boolean => {
    let next = 0;
    for (const old of previous.tokens) {
      if (old.kind === "eof") continue;
      if (old.span.end > edit.start && old.span.start < edit.end) continue;
      const expected = old.span.start >= edit.end ? old.span.start + delta : old.span.start;
      while (next < lexed.tokens.length && lexed.tokens[next]!.span.start < expected) next++;
      const token = lexed.tokens[next];
      if (
        !token || token.span.start !== expected || token.kind !== old.kind
        || token.text !== old.text || token.name !== old.name
      ) return false;
      next++;
    }
    return true;
  };
  if (!tokensOutsideEdit()) return fallback();
  const tokens = lexed.tokens;
  const [low, high] = selectWindow(items, edit);
  const count = items.length;
  let end = high;
  const startToken = low <= 0 ? 0 : startTokenAt(tokens, mapOffset(items[low - 1]!.span.end));
  let range: ItemRange | null = null;
  let stop = 0;
  if (count === 0 || low < 0) {
    stop = tokens.length - 1;
    const parsed = parseItemRange(spec, tokens, 0, stop, parseOptions);
    if (parsed.next !== stop) return fallback();
    range = parsed;
  } else {
    for (let attempt = 0; attempt < 3; attempt++) {
      stop = end === count - 1
        ? tokens.length - 1
        : stopTokenAt(tokens, mapEnd(items[end]!.span.end));
      const parsed = parseItemRange(spec, tokens, startToken, stop, parseOptions);
      if (parsed.next === stop) {
        range = parsed;
        break;
      }
      if (parsed.next > stop && end < count - 1) {
        end += 1;
        continue;
      }
      break;
    }
    if (!range) return fallback();
    if (
      stop < tokens.length - 1
      && end < count - 1
      && range.first.size > 0
      && !startsItem(tokens[stop]!, range.first)
    ) {
      // The root repetition would stop at this token, so items after the
      // window could not have been parsed in a full parse.
      return fallback();
    }
  }

  const before = count === 0 || low < 0 ? [] : items.slice(0, low);
  const olds = count === 0 || low < 0 ? [] : items.slice(end + 1);
  const shift = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      if (options.mutate) {
        for (const child of value) shift(child);
        return value;
      }
      return value.map(shift);
    }
    if (value === null || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (typeof record.start === "number" && typeof record.end === "number") {
      if (options.mutate) {
        record.start = mapOffset(record.start);
        record.end = mapOffset(record.end);
        return record;
      }
      return { ...record, start: mapOffset(record.start), end: mapOffset(record.end) };
    }
    if (options.mutate) {
      for (const child of Object.values(record)) shift(child);
      return record;
    }
    const clone: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) clone[key] = shift(child);
    return clone;
  };
  const after = olds.map(shift);

  if (options.previousSource !== undefined) {
    const oldSource = options.previousSource;
    for (const item of before) {
      if (oldSource.slice(item.span.start, item.span.end) !== source.slice(item.span.start, item.span.end)) {
        return fallback();
      }
    }
    for (let index = 0; index < olds.length; index++) {
      const moved = after[index];
      if (!isItem(moved)) return fallback();
      const item = olds[index]!;
      if (oldSource.slice(item.span.start, item.span.end) !== source.slice(moved.span.start, moved.span.end)) {
        return fallback();
      }
    }
  }

  const spliced: unknown[] = [...before, ...range.values, ...after];
  if (!ordered(spliced, source.length)) return fallback();

  let value: unknown;
  if (incremental.shape === "array") {
    value = spliced;
  } else {
    const field = incremental.field!;
    const root = previous.value as Record<string, unknown>;
    const clone = { ...root, [field]: spliced };
    const oldRootSpan = root.span as Span | undefined;
    const extra = Object.keys(root)
      .filter((key) => key !== "kind" && key !== "span" && key !== field)
      .flatMap((key) => {
        const span = (root[key] as { readonly span?: Span; } | null)?.span;
        return span ? [span] : [];
      });
    const firstOld = items[0]?.span;
    const lastOld = items[items.length - 1]?.span;
    const hasHeader = firstOld !== undefined && extra.some((span) => span.start < firstOld.start);
    const hasFooter = lastOld !== undefined && extra.some((span) => span.end > lastOld.end);
    const first = spliced[0];
    const last = spliced[spliced.length - 1];
    const start = hasHeader && oldRootSpan
      ? mapOffset(oldRootSpan.start)
      : first && isItem(first)
      ? first.span.start
      : tokens[0]!.span.start;
    const rootEnd = hasFooter && oldRootSpan
      ? mapEnd(oldRootSpan.end)
      : last && isItem(last)
      ? last.span.end
      : start;
    clone.span = { start, end: rootEnd };
    value = clone;
  }

  const repairedStart = tokens[startToken]!.span.start;
  const repairedEnd = stop > startToken ? tokens[stop - 1]!.span.end : repairedStart;
  const kept: Diagnostic[] = [];
  for (const entry of previous.diagnostics) {
    const start = mapOffset(entry.span.start);
    const end = mapOffset(entry.span.end);
    if (end <= repairedStart) {
      kept.push({ ...entry, span: { start, end } });
    } else if (start >= repairedEnd) {
      kept.push({ ...entry, span: { start, end } });
    }
  }
  const diagnostics = sortDiagnostics([...kept, ...range.diagnostics]);
  const ok = value !== null && diagnostics.every((entry) => entry.severity !== "error");
  const result: IncrementalResult<A> = {
    ok,
    value: value as A,
    tokens,
    trivia: lexed.trivia,
    diagnostics,
    stats: {
      fallback: false,
      reused: before.length + olds.length,
      reparsed: range.values.length,
      window: [count === 0 || low < 0 ? 0 : low, (count === 0 || low < 0 ? 0 : low) + range.values.length],
    },
  };

  if (options.verify) {
    const check = full();
    const same = JSON.stringify(check.value) === JSON.stringify(result.value)
      && JSON.stringify(check.diagnostics) === JSON.stringify(result.diagnostics);
    if (!same) {
      const total = itemsOf(check.value)?.length ?? 0;
      return { ...check, stats: { fallback: true, reused: 0, reparsed: total, window: [0, total] } };
    }
  }
  return result;
};
