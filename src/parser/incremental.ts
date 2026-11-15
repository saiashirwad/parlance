import { type Diagnostic, sortDiagnostics } from "../diagnostic.ts";
import { type Span } from "../source.ts";
import { lexInto } from "./lex.ts";
import {
  type Edit,
  type ItemRange,
  type ParseOptions,
  type ParseResult,
  fragileAst,
  parseItemRange,
  parseSource,
  trustedAst,
} from "./parse.ts";
import type { GrammarSpec } from "./spec.ts";
import { EOF, ERROR, TokenBuilder, TokenList, TriviaBuilder, WORD } from "./tokens.ts";

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
  if (!trustedAst.has(value)) {
    for (const item of list) if (!isItem(item)) return null;
  }
  return list as readonly Item[];
};

const validatedRoots = new WeakSet<object>();

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

const startTokenAt = (tokens: TokenList, offset: number): number => {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (tokens.end[middle]! <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.min(low, tokens.length - 1);
};

const stopTokenAt = (tokens: TokenList, offset: number): number => {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (tokens.start[middle]! < offset) low = middle + 1;
    else high = middle;
  }
  return Math.min(low, tokens.length - 1);
};

const startsItem = (tokens: TokenList, index: number, sync: Uint8Array, wordKeyId: number): boolean => {
  if (sync[tokens.keyAt(index)] === 1) return true;
  return tokens.kindAt(index) === WORD && sync[wordKeyId] === 1;
};

const firstEndingAfter = (items: readonly Item[], offset: number): number => {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (items[middle]!.span.end <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
};

const firstStartingAt = (items: readonly Item[], offset: number): number => {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (items[middle]!.span.start < offset) low = middle + 1;
    else high = middle;
  }
  return low;
};

const selectWindow = (items: readonly Item[], edit: Edit): readonly [number, number] => {
  const count = items.length;
  if (count === 0) return [-1, -1];
  const first = firstEndingAfter(items, edit.start);
  const last = firstStartingAt(items, edit.end) - 1;
  let low: number;
  let high: number;
  if (first <= last) {
    low = first;
    high = last;
  } else {
    const before = first - 1;
    const after = firstStartingAt(items, edit.end);
    if (before >= 0 && after < count) {
      low = before;
      high = after;
    } else if (before >= 0) low = high = before;
    else if (after < count) low = high = after;
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

const tokenStartingAt = (tokens: TokenList, offset: number): number => {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (tokens.start[middle]! < offset) low = middle + 1;
    else high = middle;
  }
  return low < tokens.length && tokens.start[low] === offset ? low : -1;
};

const countTriviaStartsBefore = (trivia: { readonly length: number; readonly start: Uint32Array; }, offset: number): number => {
  let low = 0;
  let high = trivia.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (trivia.start[middle]! < offset) low = middle + 1;
    else high = middle;
  }
  return low;
};

const sameRange = (
  left: string,
  leftStart: number,
  leftEnd: number,
  right: string,
  rightStart: number,
  rightEnd: number,
): boolean => {
  const length = leftEnd - leftStart;
  if (length !== rightEnd - rightStart) return false;
  for (let index = 0; index < length; index++) {
    if (left.charCodeAt(leftStart + index) !== right.charCodeAt(rightStart + index)) return false;
  }
  return true;
};

const sameAt = (left: TokenList, leftIndex: number, right: TokenList, rightIndex: number, delta: number): boolean => {
  if (
    left.kind[leftIndex] !== right.kind[rightIndex]
    || left.keyId[leftIndex] !== right.keyId[rightIndex]
    || left.end[leftIndex] !== right.end[rightIndex]! + delta
  ) return false;
  if ((left.kind[leftIndex]! & 7) === WORD || (left.kind[leftIndex]! & 7) === ERROR) {
    return sameRange(
      left.source,
      left.start[leftIndex]!,
      left.end[leftIndex]!,
      right.source,
      right.start[rightIndex]!,
      right.end[rightIndex]!,
    );
  }
  return left.start[leftIndex] === right.start[rightIndex]! + delta;
};

const sameTrivia = (left: { readonly length: number; readonly start: Uint32Array; readonly end: Uint32Array; readonly kind: Uint8Array; }, right: { readonly length: number; readonly start: Uint32Array; readonly end: Uint32Array; readonly kind: Uint8Array; }, from: number): boolean => {
  let index = 0;
  while (index < left.length && index < right.length && right.start[index]! < from) index++;
  const remaining = right.length - index;
  if (left.length !== remaining) return false;
  for (let at = 0; at < left.length; at++) {
    if (
      left.start[at] !== right.start[index + at]
      || left.end[at] !== right.end[index + at]
      || left.kind[at] !== right.kind[index + at]
    ) return false;
  }
  return true;
};

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
const sameBuilderAt = (source: string, tokens: TokenBuilder, at: number, old: TokenList, index: number, delta: number): boolean => {
  if (
    tokens.kind[at] !== old.kind[index]
    || tokens.keyId[at] !== old.keyId[index]
    || tokens.end[at] !== old.end[index]! + delta
  ) return false;
  if ((tokens.kind[at]! & 7) === WORD || (tokens.kind[at]! & 7) === ERROR) {
    return sameRange(
      source,
      tokens.start[at]!,
      tokens.end[at]!,
      old.source,
      old.start[index]!,
      old.end[index]!,
    );
  }
  return tokens.start[at] === old.start[index]! + delta;
};

/** Text before the edit is unchanged, so equal boundaries and keys mean the same tokens. */
const sameStructureAt = (tokens: TokenBuilder, at: number, old: TokenList, index: number, delta: number): boolean =>
  tokens.kind[at] === old.kind[index]
  && tokens.keyId[at] === old.keyId[index]
  && tokens.start[at] === old.start[index]! + delta
  && tokens.end[at] === old.end[index]! + delta;

const sameBuilderSlice = (tokens: TokenBuilder, old: TokenList, from: number): boolean => {
  const count = tokens.count;
  if (count > old.length) return false;
  for (let index = from; index < count; index++) {
    if (!sameStructureAt(tokens, index, old, index, 0)) return false;
  }
  return true;
};

/**
 * Reuse the previous token tail after an edit.
 *
 * The stream is lexed from offset 0. A token regex can match a longer string
 * after an edit, so tokens before the edit are not reused on a guess about how
 * far a change can reach. Each lexed token before the window is compared with
 * the previous stream during the scan; a difference forces a full parse.
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
  prefix: number,
): { tokens: TokenList; resync: number; verified: boolean; mismatch: boolean } => {
  const old = previous.tokens;
  const resyncFrom = edit.start + edit.insert.length;
  const tokens = new TokenBuilder(old.length + 8);
  const trivia = new TriviaBuilder(previous.trivia.length + 8);
  let resync = -1;
  let mismatch = false;
  const stop = (builder: TokenBuilder, offset: number): boolean => {
    const at = builder.count - 1;
    if (at < prefix) {
      if (!sameStructureAt(builder, at, old, at, 0)) {
        mismatch = true;
        return true;
      }
      return false;
    }
    if (offset < resyncFrom) return false;
    const index = tokenStartingAt(old, builder.start[at]! - delta);
    if (index < prefix) return false;
    if (!sameBuilderAt(source, builder, at, old, index, delta)) return false;
    resync = index;
    return true;
  };
  lexInto(spec, source, 0, tokens, trivia, reusableTail(spec) ? stop : undefined);

  if (mismatch) return { tokens: tokens.finish(source, trivia, spec), resync, verified: true, mismatch };

  if (resync < 0) {
    return { tokens: tokens.finish(source, trivia, spec), resync, verified: false, mismatch };
  }

  if (delta === 0 && sameBuilderSlice(tokens, old, prefix) && sameTrivia(trivia.finish(), previous.trivia, 0)) {
    return {
      tokens: new TokenList(
        source,
        old.kind,
        old.keyId,
        old.start,
        old.end,
        old.length,
        old.trivia,
        old.wordKeyId,
        old.tokenNames,
        old.ruleOf,
      ),
      resync,
      verified: true,
      mismatch,
    };
  }

  const tailFrom = resync + 1;
  if (tailFrom < old.length) tokens.append(old, tailFrom, old.length, delta);
  else tokens.push(EOF, spec.eofKeyId, source.length, source.length, 0);
  if (tailFrom < old.length) {
    const from = countTriviaStartsBefore(previous.trivia, old.end[resync]!);
    trivia.append(previous.trivia, from, previous.trivia.length, delta);
  }
  return { tokens: tokens.finish(source, trivia, spec), resync, verified: true, mismatch };
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
  // An item that read past its neighbour, or a repair that rolled back over
  // items, depends on tokens the window does not re-read.
  if (fragileAst.has(previous.value as object)) return fallback();
  // Where the root stopped early. A reparsed item that reads that far could
  // make a full parse roll back and repair it.
  const stuck = previous.diagnostics.find((entry) => entry.code === "parse/unexpected");
  const trusted = trustedAst.has(previous.value as object);
  const items = itemsOf(previous.value);
  if (!items) return fallback();
  if (!trusted && !validatedRoots.has(previous.value as object)) {
    if (!ordered(items, oldLength)) return fallback();
    validatedRoots.add(previous.value as object);
  }
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

  const [low, high] = selectWindow(items, edit);
  const count = items.length;
  let end = high;
  const prefix = low <= 0 ? 0 : startTokenAt(previous.tokens, items[low - 1]!.span.end);
  const { tokens, resync, verified, mismatch } = relex(spec, previous, source, edit, delta, prefix);
  if (mismatch) return fallback();
  const startToken = low <= 0
    ? incremental.guarded
      ? items[0] === undefined
        ? 0
        : stopTokenAt(tokens, mapOffset(items[0].span.start))
      : 0
    : startTokenAt(tokens, mapOffset(items[low - 1]!.span.end));
  // Reused prefix items are only sound when their tokens are unchanged. A
  // token regex can reach across the edit and reclassify text far before it,
  // so compare against the old prefix boundary, not the new token index.
  if (!verified) {
    if (tokens.length < prefix) return fallback();
    for (let index = 0; index < prefix; index++) {
      if (!sameAt(tokens, index, previous.tokens, index, 0)) return fallback();
    }
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
    // The last reparsed item may read into the first reused one, but not past it.
    const limit = end < count - 1 ? stopTokenAt(tokens, mapEnd(items[end + 1]!.span.end)) : tokens.length;
    if (range.reach >= limit) return fallback();
    if (stuck && range.high >= stopTokenAt(tokens, mapOffset(stuck.span.start))) return fallback();
    if (
      stop < tokens.length - 1
      && end < count - 1
      && range.first.includes(1)
      && !startsItem(tokens, stop, range.first, spec.wordKeyId)
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

  const repairedStart = tokens.start[startToken]!;
  const repairedEnd = stop > startToken ? tokens.end[stop - 1]! : repairedStart;

  // Reused suffix items are only sound when the tokens above them agree with
  // the previous stream. A guarded root also has footer tokens outside the
  // repetition; compare everything from the window end to EOF. For an
  // unguarded root, a resync inside the suffix covers the rest of it.
  if (incremental.guarded) {
    const oldStop = stopTokenAt(previous.tokens, items[end]?.span.end ?? 0);
    const length = tokens.length - stop;
    if (length !== previous.tokens.length - oldStop) return fallback();
    for (let index = 0; index < length; index++) {
      if (!sameAt(tokens, stop + index, previous.tokens, oldStop + index, delta)) return fallback();
    }
  } else if (end < count - 1) {
    const oldStop = stopTokenAt(previous.tokens, items[end]!.span.end);
    if (resync < 0 || resync >= stop) {
      const newEnd = resync >= 0 ? Math.min(resync + 1, tokens.length) : tokens.length;
      const length = newEnd - stop;
      if (length > previous.tokens.length - oldStop) return fallback();
      for (let index = 0; index < length; index++) {
        if (!sameAt(tokens, stop + index, previous.tokens, oldStop + index, delta)) return fallback();
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
    if (options.mutate) {
      for (const key in record) shift(record[key]);
      return record;
    }
    const clone: Record<string, unknown> = {};
    for (const key in record) clone[key] = shift(record[key]);
    return clone;
  };
  // A zero-length delta leaves every reused span in place. Reuse the nodes
  // directly instead of deep-cloning them; `before` already shares this way.
  const after = delta === 0 ? olds : olds.map(shift);

  const spliced: unknown[] = [...before, ...range.values, ...after];
  if (incremental.min > 0 && spliced.length === 0) return fallback();
  if (!trusted && !ordered(spliced, source.length)) return fallback();
  validatedRoots.add(spliced);

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
      ? tokens.start[0]!
      : rootStartsBeforeItems && oldRootSpan
      ? mapOffset(oldRootSpan.start)
      : first && isItem(first)
      ? first.span.start
      : tokens.start[0]!;
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
  if (value !== null && typeof value === "object") trustedAst.add(value as object);
  const result: IncrementalResult<A> = {
    ok,
    value: value as A,
    tokens,
    trivia: tokens.trivia,
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
