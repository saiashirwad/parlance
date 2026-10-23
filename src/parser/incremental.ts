import { type Diagnostic, sortDiagnostics } from "../diagnostic.ts";
import { type Span } from "../source.ts";
import { lexFrom } from "./lex.ts";
import {
  type Edit,
  type ItemRange,
  type ParseOptions,
  type ParseResult,
  parseItemRange,
  parseSource,
} from "./parse.ts";
import type { GrammarSpec, Key, LexToken, TokenList, Trivia } from "./spec.ts";

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

const lookbehind = /\(\?<[=!]/;

const tailReuse = new WeakMap<GrammarSpec, boolean>();

/**
 * A lookbehind at a shifted position can read text before the resync boundary,
 * where the two sources differ. Those grammars lex to the end instead.
 */
const reusableTail = (spec: GrammarSpec): boolean => {
  const cached = tailReuse.get(spec);
  if (cached !== undefined) return cached;
  const patterns = [
    ...spec.skips.map((pattern) => pattern.source),
    spec.word.source,
    ...spec.tokens.map((token) => token.regex.source),
    ...spec.inline.map((inline) => inline.regex.source),
  ];
  const value = !patterns.some((pattern) => lookbehind.test(pattern));
  tailReuse.set(spec, value);
  return value;
};

const tokenStartingAt = (tokens: readonly LexToken[], offset: number): number => {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (tokens[middle]!.span.start < offset) low = middle + 1;
    else high = middle;
  }
  return low < tokens.length && tokens[low]!.span.start === offset ? low : -1;
};

const countTriviaStartsBefore = (trivia: readonly Trivia[], offset: number): number => {
  let low = 0;
  let high = trivia.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (trivia[middle]!.span.start < offset) low = middle + 1;
    else high = middle;
  }
  return low;
};

const shiftToken = (token: LexToken, delta: number): LexToken => ({
  ...token,
  span: { start: token.span.start + delta, end: token.span.end + delta },
});

const shiftTrivia = (entry: Trivia, delta: number): Trivia => ({
  ...entry,
  span: { start: entry.span.start + delta, end: entry.span.end + delta },
});

/**
 * Reuse the previous token tail after an edit.
 *
 * The stream is lexed from offset 0. A token regex can match a longer string
 * after an edit, so tokens before the edit are not reused on a guess about how
 * far a change can reach.
 *
 * Lexing stops at the first boundary at or after the inserted text where the
 * produced token equals the previous token shifted by `delta`. From that offset
 * the remaining source text is identical, so the shifted previous tail is the
 * exact tokenization. Lookbehind can read across that boundary, so
 * `reusableTail` turns reuse off for grammars that use it.
 */
const relex = (
  spec: GrammarSpec,
  previous: ParseResult<unknown>,
  source: string,
  edit: Edit,
  delta: number,
): TokenList & { readonly resync: number } => {
  const old = previous.tokens;
  const resyncFrom = edit.start + edit.insert.length;
  let resync = -1;
  const stop = (tokens: readonly LexToken[], offset: number): boolean => {
    if (offset < resyncFrom) return false;
    const token = tokens[tokens.length - 1]!;
    const index = tokenStartingAt(old, token.span.start - delta);
    if (index < 0) return false;
    const before = old[index]!;
    if (
      token.kind !== before.kind
      || token.text !== before.text
      || token.name !== before.name
      || token.span.end !== before.span.end + delta
    ) return false;
    resync = index;
    return true;
  };
  const run = lexFrom(spec, source, 0, reusableTail(spec) ? stop : undefined);

  const tailFrom = resync + 1;
  let tailTokens: readonly LexToken[];
  if (tailFrom <= 0 || tailFrom >= old.length) {
    tailTokens = [];
  } else if (delta === 0) {
    tailTokens = old.slice(tailFrom);
  } else {
    const tail = new Array<LexToken>(old.length - tailFrom);
    for (let index = 0; index < tail.length; index++) tail[index] = shiftToken(old[tailFrom + index]!, delta);
    tailTokens = tail;
  }
  let tailTrivia: readonly Trivia[] = [];
  if (tailFrom > 0 && tailFrom < old.length) {
    const from = countTriviaStartsBefore(previous.trivia, old[tailFrom - 1]!.span.end);
    if (delta === 0) {
      tailTrivia = previous.trivia.slice(from);
    } else {
      const tail = new Array<Trivia>(previous.trivia.length - from);
      for (let index = 0; index < tail.length; index++) tail[index] = shiftTrivia(previous.trivia[from + index]!, delta);
      tailTrivia = tail;
    }
  }
  return {
    tokens: run.tokens.concat(tailTokens),
    trivia: run.trivia.concat(tailTrivia),
    resync,
  };
};

const sameToken = (left: LexToken, right: LexToken, delta: number): boolean =>
  left.kind === right.kind
  && left.text === right.text
  && left.name === right.name
  && left.span.start === right.span.start + delta
  && left.span.end === right.span.end + delta;

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

  if (incremental.guarded) {
    if (items.length === 0) return fallback();
    const first = items[0]!.span.start;
    const last = items[items.length - 1]!.span.end;
    if (edit.start <= first || edit.start >= last || edit.end > last) return fallback();
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

  const { tokens, trivia, resync } = relex(spec, previous, source, edit, delta);
  const [low, high] = selectWindow(items, edit);
  const count = items.length;
  let end = high;
  const startToken = low <= 0
    ? items[0] === undefined
      ? 0
      : stopTokenAt(tokens, mapOffset(items[0].span.start))
    : startTokenAt(tokens, mapOffset(items[low - 1]!.span.end));
  // Reused prefix items are only sound when their tokens are unchanged. A
  // lookahead token before the edit can be reclassified by text after it.
  const prefix = Math.min(startToken, previous.tokens.length, tokens.length);
  for (let index = 0; index < prefix; index++) {
    if (!sameToken(tokens[index]!, previous.tokens[index]!, 0)) return fallback();
  }
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
        ? incremental.guarded
          ? stopTokenAt(tokens, mapEnd(items[end]!.span.end))
          : tokens.length - 1
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

  // A guarded root keeps header/footer syntax outside the parsed window. A
  // malformed item could otherwise make the window parser skip into that
  // syntax, so diagnostics inside a guarded window force a full parse.
  if (incremental.guarded && range.diagnostics.some((entry) => entry.severity === "error")) return fallback();

  const repairedStart = tokens[startToken]!.span.start;
  const repairedEnd = stop > startToken ? tokens[stop - 1]!.span.end : repairedStart;

  // Reused suffix items are only sound when the tokens above them agree with
  // the previous stream. A guarded root also has footer tokens outside the
  // repetition; compare everything from the window end to EOF. For an
  // unguarded root, a resync inside the suffix covers the rest of it.
  if (incremental.guarded) {
    const oldStop = stopTokenAt(previous.tokens, items[end]?.span.end ?? 0);
    const length = tokens.length - stop;
    if (length !== previous.tokens.length - oldStop) return fallback();
    for (let index = 0; index < length; index++) {
      if (!sameToken(tokens[stop + index]!, previous.tokens[oldStop + index]!, delta)) return fallback();
    }
  } else if (end < count - 1) {
    const oldStop = stopTokenAt(previous.tokens, items[end]!.span.end);
    if (resync < 0 || resync >= stop) {
      const newEnd = resync >= 0 ? Math.min(resync + 1, tokens.length) : tokens.length;
      const length = newEnd - stop;
      if (length > previous.tokens.length - oldStop) return fallback();
      for (let index = 0; index < length; index++) {
        if (!sameToken(tokens[stop + index]!, previous.tokens[oldStop + index]!, delta)) return fallback();
      }
    }
  }

  // Snapshot before `mutate` shifts the reused items in place.
  const lastOldEnd = items[items.length - 1]?.span.end;
  const before = count === 0 || low < 0 ? [] : items.slice(0, low);
  const olds = count === 0 || low < 0 ? [] : items.slice(end + 1);
  const shift = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      if (options.mutate) {
        for (const child of value) shift(child);
        return value;
      }
      const copy = new Array<unknown>(value.length);
      for (let index = 0; index < value.length; index++) copy[index] = shift(value[index]);
      return copy;
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
    const keys = Object.keys(record);
    if (options.mutate) {
      for (let index = 0; index < keys.length; index++) shift(record[keys[index]!]);
      return record;
    }
    const clone: Record<string, unknown> = {};
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]!;
      clone[key] = shift(record[key]);
    }
    return clone;
  };
  // A zero-length delta leaves every reused span in place. Reuse the nodes
  // directly instead of deep-cloning them; `before` already shares this way.
  const after = delta === 0 ? olds : olds.map(shift);

  const spliced: unknown[] = [...before, ...range.values, ...after];
  if (incremental.min > 0 && spliced.length === 0) return fallback();
  if (!ordered(spliced, source.length)) return fallback();

  let value: unknown;
  if (incremental.shape === "array") {
    value = spliced;
  } else {
    const field = incremental.field!;
    const root = previous.value as Record<string, unknown>;
    const clone: Record<string, unknown> = {};
    for (const key of Object.keys(root)) {
      if (key === field || key === "span") continue;
      const fieldValue = root[key];
      clone[key] = key === "kind" || delta === 0 ? fieldValue : shift(fieldValue);
    }
    clone[field] = spliced;
    const oldRootSpan = root.span as Span | undefined;
    const firstOld = items[0]?.span;
    const rootStartsBeforeItems = oldRootSpan !== undefined && firstOld !== undefined && oldRootSpan.start < firstOld.start;
    const rootEndsAfterItems = oldRootSpan !== undefined && lastOldEnd !== undefined && oldRootSpan.end > lastOldEnd;
    const first = spliced[0];
    const last = spliced[spliced.length - 1];
    // A window at token 0 reparsed every leading recovery token, so the root
    // starts where the token stream does. A guarded root keeps its header and
    // footer, so the previous root span still bounds it.
    const start = incremental.guarded && oldRootSpan
      ? mapOffset(oldRootSpan.start)
      : startToken === 0
      ? tokens[0]!.span.start
      : rootStartsBeforeItems && oldRootSpan
      ? mapOffset(oldRootSpan.start)
      : first && isItem(first)
      ? first.span.start
      : tokens[0]!.span.start;
    const lastEnd = last && isItem(last) ? last.span.end : start;
    // The root repetition spans the recovery tokens it skipped, not just its
    // items, so a repaired tail can reach past the last item.
    const rootEnd = incremental.guarded && oldRootSpan
      ? mapEnd(oldRootSpan.end)
      : end === count - 1
      ? Math.max(lastEnd, repairedEnd)
      : rootEndsAfterItems && oldRootSpan
      ? mapEnd(oldRootSpan.end)
      : lastEnd;
    clone.span = { start, end: rootEnd };
    value = clone;
  }

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
    trivia,
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
