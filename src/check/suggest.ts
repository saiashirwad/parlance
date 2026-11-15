import type { Fix } from "../diagnostic.ts";
import type { Span } from "../source.ts";

/** Levenshtein distance, or `limit + 1` once it must exceed `limit`. */
const distance = (a: string, b: string, limit: number): number => {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let least = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const value = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + cost);
      row.push(value);
      if (value < least) least = value;
    }
    if (least > limit) return limit + 1;
    previous = row;
  }
  return previous[b.length]!;
};

/** The candidate closest to `name` by edit distance, if any is close enough to be a typo. */
export const closest = (name: string, candidates: Iterable<string>): string | undefined => {
  const limit = Math.max(1, Math.floor(name.length / 3));
  let best: string | undefined;
  let least = limit + 1;
  for (const candidate of candidates) {
    if (candidate === name || candidate === "") continue;
    const found = candidate.toLowerCase() === name.toLowerCase() ? 0 : distance(name, candidate, limit);
    if (found < least) {
      least = found;
      best = candidate;
    }
  }
  return best;
};

/** A "did you mean" quick fix that replaces `span` with the nearest candidate, if there is one. */
export const didYouMean = (name: string, span: Span, candidates: Iterable<string>): Fix | undefined => {
  const near = closest(name, candidates);
  return near === undefined ? undefined : { title: `Did you mean ${JSON.stringify(near)}?`, edits: [{ span, newText: near }] };
};
