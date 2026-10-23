import { type Diagnostic, error, sortDiagnostics } from "../diagnostic.ts";
import { type Span } from "../source.ts";
import { lex } from "./lex.ts";
import type { GrammarSpec, Key, LexToken, PExpr, PrecLevel, TokenList, Trivia } from "./spec.ts";

export type { Edit } from "../source.ts";

export type ParseOptions = { readonly maxDepth?: number };

export type ParseResult<A = unknown> = {
  readonly ok: boolean;
  readonly value: A | null;
  readonly tokens: readonly LexToken[];
  readonly trivia: readonly Trivia[];
  readonly diagnostics: readonly Diagnostic[];
};

type Reply =
  | { readonly ok: true; readonly value: unknown; readonly next: number; readonly cut?: boolean }
  | { readonly ok: false; readonly committed: boolean };

const FAIL: Reply = { ok: false, committed: false };

const tokenKey = (token: LexToken): Key => {
  switch (token.kind) {
    case "word":
      return `word:${token.text}`;
    case "symbol":
      return `symbol:${token.text}`;
    case "token":
      return `token:${token.name}`;
    case "regex":
      return `regex:${token.index ?? 0}`;
    case "eof":
      return "eof";
    case "error":
      return `symbol:${token.text}`;
  }
};

const matches = (first: ReadonlySet<Key>, token: LexToken): boolean => {
  const key = tokenKey(token);
  if (first.has(key)) return true;
  return token.kind === "word" && first.has("word");
};

const describe = (key: Key, spec: GrammarSpec): string => {
  if (key === "word") return "a name";
  if (key === "eof") return "end of file";
  if (key.startsWith("word:")) return JSON.stringify(key.slice(5));
  if (key.startsWith("symbol:")) return JSON.stringify(key.slice(7));
  if (key.startsWith("token:")) return `a ${key.slice(6)} token`;
  if (key.startsWith("regex:")) {
    const index = Number(key.slice(6));
    return `/${spec.inline[index]?.source ?? ""}/`;
  }
  return key;
};

const union = (sets: readonly ReadonlySet<Key>[]): ReadonlySet<Key> => {
  const result = new Set<Key>();
  for (const set of sets) for (const key of set) result.add(key);
  return result;
};

class Machine {
  readonly spec: GrammarSpec;
  readonly tokens: readonly LexToken[];
  readonly maxDepth: number;
  readonly diagnostics: Diagnostic[] = [];
  farthest = -1;
  expected = new Set<Key>();
  depth = 0;

  constructor(spec: GrammarSpec, tokens: readonly LexToken[], maxDepth: number) {
    this.spec = spec;
    this.tokens = tokens;
    this.maxDepth = maxDepth;
  }

  token(index: number): LexToken {
    return this.tokens[Math.min(index, this.tokens.length - 1)]!;
  }

  span(start: number, next: number): Span {
    if (next > start) return { start: this.token(start).span.start, end: this.token(next - 1).span.end };
    return { start: this.token(start).span.start, end: this.token(start).span.start };
  }

  record(keys: Iterable<Key>, at: number): void {
    if (at > this.farthest) {
      this.farthest = at;
      this.expected = new Set(keys);
    } else if (at === this.farthest) {
      for (const key of keys) this.expected.add(key);
    }
  }

  fail(keys: Iterable<Key>, at: number, committed = false): Reply {
    this.record(keys, at);
    return { ok: false, committed };
  }

  probe(body: () => Reply): Reply {
    const farthest = this.farthest;
    const expected = new Set(this.expected);
    const diagnostics = this.diagnostics.length;
    const reply = body();
    if (!reply.ok) {
      this.farthest = farthest;
      this.expected = expected;
      this.diagnostics.length = diagnostics;
    }
    return reply;
  }

  parseRoot(): Reply {
    const reply = this.parseExpr(this.spec.rules[this.spec.root]!.expr, 0);
    if (!reply.ok) {
      this.reportExpected();
      return reply;
    }
    if (this.token(reply.next).kind !== "eof") {
      const token = this.token(reply.next);
      this.diagnostics.push(error(`Unexpected ${JSON.stringify(token.text)}`, token.span, { code: "parse/unexpected" }));
    }
    return reply;
  }

  reportExpected(): void {
    const index = this.farthest < 0 ? 0 : this.farthest;
    const at = this.token(index).span;
    const keys = this.expected.size ? [...this.expected] : [...this.spec.rootFirst];
    const message = keys.length
      ? `Expected ${[...new Set(keys.map((key) => describe(key, this.spec)))].join(" or ")}`
      : "Unexpected token";
    const last = this.diagnostics[this.diagnostics.length - 1];
    if (last && last.span.start === at.start && last.span.end === at.end) return;
    this.diagnostics.push(error(message, at, { code: "parse/expected" }));
  }

  recover(expr: Extract<PExpr, { readonly t: "star" | "plus"; }>, start: number): number {
    const at = Math.max(this.farthest, start);
    const index = Math.min(at, this.tokens.length - 1);
    const keys = this.expected.size ? [...this.expected] : [...expr.sync];
    const message = keys.length
      ? `Expected ${[...new Set(keys.map((key) => describe(key, this.spec)))].join(" or ")}`
      : "Unexpected token";
    const token = this.token(index);
    const last = this.diagnostics[this.diagnostics.length - 1];
    if (!last || last.span.start !== token.span.start) {
      this.diagnostics.push(error(message, token.span, { code: "parse/recover" }));
    }
    let cursor = start;
    let depth = 0;
    while (cursor < this.tokens.length && this.token(cursor).kind !== "eof") {
      const current = this.token(cursor);
      if (cursor > start && depth === 0 && matches(expr.sync, current)) break;
      if (current.kind === "symbol") {
        if (current.text === "{" || current.text === "(" || current.text === "[") depth++;
        else if (current.text === "}" || current.text === ")" || current.text === "]") depth = Math.max(0, depth - 1);
      }
      cursor++;
    }
    this.farthest = cursor;
    this.expected.clear();
    return cursor === start ? start + 1 : cursor;
  }

  parseExpr(expr: PExpr, pos: number): Reply {
    if (this.depth >= this.maxDepth) {
      const token = this.token(pos);
      this.diagnostics.push(error("Expression is nested too deeply", token.span, { code: "parse/depth" }));
      return FAIL;
    }
    this.depth++;
    try {
      switch (expr.t) {
        case "lit": {
          const token = this.token(pos);
          const kind = expr.word ? "word" : "symbol";
          if (token.kind === kind && token.text === expr.text) {
            return { ok: true, value: { text: token.text, span: token.span }, next: pos + 1 };
          }
          return this.fail([expr.key], pos);
        }
        case "word": {
          const token = this.token(pos);
          if (token.kind !== "word") return this.fail(["word"], pos);
          return { ok: true, value: { text: token.text, span: token.span }, next: pos + 1 };
        }
        case "token": {
          const token = this.token(pos);
          if (token.kind !== "token" || token.name !== expr.name) return this.fail([`token:${expr.name}`], pos);
          return { ok: true, value: { text: token.text, span: token.span }, next: pos + 1 };
        }
        case "re": {
          const token = this.token(pos);
          if (token.kind !== "regex" || token.index !== expr.index) return this.fail([`regex:${expr.index}`], pos);
          return { ok: true, value: { text: token.text, span: token.span }, next: pos + 1 };
        }
        case "ref":
          return this.parseExpr(this.spec.rules[expr.rule]!.expr, pos);
        case "cut":
          return { ok: true, value: null, next: pos, cut: true };
        case "seq":
          return this.parseSeq(expr, pos);
        case "alt":
          return this.parseAlt(expr, pos);
        case "star":
        case "plus":
          return this.parseRepeat(expr, pos);
        case "opt": {
          const reply = this.probe(() => this.parseExpr(expr.e, pos));
          return reply.ok ? reply : { ok: true, value: null, next: pos };
        }
        case "and": {
          const reply = this.probe(() => this.parseExpr(expr.e, pos));
          return reply.ok ? { ok: true, value: null, next: pos } : { ok: false, committed: false };
        }
        case "not": {
          const reply = this.probe(() => this.parseExpr(expr.e, pos));
          if (!reply.ok) return { ok: true, value: null, next: pos };
          return { ok: false, committed: false };
        }
        case "sep":
          return this.parseSep(expr, pos);
        case "precedence":
          return this.parsePrecedence(expr, pos);
      }
    } finally {
      this.depth--;
    }
  }

  parseSeq(expr: Extract<PExpr, { readonly t: "seq"; }>, pos: number): Reply {
    const values: unknown[] = [];
    let index = pos;
    let cut = false;
    for (const item of expr.items) {
      const reply = this.parseExpr(item.expr, index);
      if (!reply.ok) return reply.committed || cut ? { ok: false, committed: true } : reply;
      values.push(reply.value);
      index = reply.next;
      cut ||= reply.cut === true;
    }
    return { ok: true, value: this.node(expr, pos, index, values), next: index, ...(cut ? { cut: true } : {}) };
  }

  node(expr: Extract<PExpr, { readonly t: "seq"; }>, start: number, next: number, values: readonly unknown[]): unknown {
    if (expr.tag !== null) {
      const node: Record<string, unknown> = { kind: expr.tag };
      expr.items.forEach((item, index) => {
        if (item.label !== null && item.label !== "_") node[item.label] = values[index];
      });
      node.span = this.span(start, next);
      return node;
    }
    const captured: unknown[] = [];
    expr.items.forEach((item, index) => {
      if (item.capture) captured.push(values[index]);
    });
    if (captured.length === 0) return null;
    return captured.length === 1 ? captured[0] : captured;
  }

  parseAlt(expr: Extract<PExpr, { readonly t: "alt"; }>, pos: number): Reply {
    const token = this.token(pos);
    let candidates = expr.alts.filter((alt) => alt.nullable || matches(alt.first, token));
    if (candidates.length === 0) {
      if (token.kind === "error" || token.kind === "eof") candidates = [...expr.alts];
      else {
        this.record(union(expr.alts.map((alt) => alt.first)), pos);
        return FAIL;
      }
    }
    for (const alt of candidates) {
      const reply = this.parseExpr(alt, pos);
      if (reply.ok) return reply;
      if (reply.committed) return reply;
    }
    return FAIL;
  }

  parseRepeat(expr: Extract<PExpr, { readonly t: "star" | "plus"; }>, pos: number): Reply {
    const values: unknown[] = [];
    let index = pos;
    let first = true;
    for (;;) {
      const token = this.token(index);
      if (token.kind === "eof") break;
      const canStart = matches(expr.first, token) || expr.e.nullable;
      if (!canStart) break;
      const before = index;
      const reply = this.parseExpr(expr.e, index);
      if (reply.ok) {
        if (reply.next === index) break;
        values.push(reply.value);
        index = reply.next;
        first = false;
        continue;
      }
      if (reply.committed && !expr.recover) return reply;
      if (!expr.recover) {
        if (first && expr.t === "plus") return reply;
        break;
      }
      index = this.recover(expr, index);
      if (index === before) index++;
      first = false;
    }
    if (first && expr.t === "plus") return this.fail(expr.first, pos);
    return { ok: true, value: values, next: index };
  }

  parseSep(expr: Extract<PExpr, { readonly t: "sep"; }>, pos: number): Reply {
    const values: unknown[] = [];
    let index = pos;
    const firstReply = this.probe(() => this.parseExpr(expr.item, index));
    if (!firstReply.ok) {
      if (expr.min === 1) return firstReply;
      return { ok: true, value: values, next: index };
    }
    values.push(firstReply.value);
    index = firstReply.next;
    for (;;) {
      const separator = this.probe(() => this.parseExpr(expr.separator, index));
      if (!separator.ok) break;
      const item = this.probe(() => this.parseExpr(expr.item, separator.next));
      if (!item.ok) {
        if (expr.trailing) index = separator.next;
        break;
      }
      if (item.next === separator.next) break;
      values.push(item.value);
      index = item.next;
    }
    return { ok: true, value: values, next: index };
  }

  parsePrecedence(expr: Extract<PExpr, { readonly t: "precedence"; }>, pos: number): Reply {
    return this.parsePrecedenceAt(expr, pos, 0);
  }

  parsePrecedenceAt(expr: Extract<PExpr, { readonly t: "precedence"; }>, pos: number, min: number): Reply {
    if (this.depth >= this.maxDepth) {
      const token = this.token(pos);
      this.diagnostics.push(error("Expression is nested too deeply", token.span, { code: "parse/depth" }));
      return FAIL;
    }
    this.depth++;
    try {
      let value: unknown;
      let index: number;
      const prefix = this.matchOperator(expr.levels.filter((level) => level.assoc === "prefix"), pos);
      if (prefix) {
        const operand = this.parsePrecedenceAt(expr, prefix.next, prefix.level.bp);
        if (!operand.ok) return operand;
        value = {
          kind: "prefix",
          operator: this.operatorText(prefix),
          operand: operand.value,
          span: this.span(pos, operand.next),
        };
        index = operand.next;
      } else {
        const atom = this.parseExpr(expr.atom, pos);
        if (!atom.ok) return atom;
        value = atom.value;
        index = atom.next;
      }
      for (;;) {
        const match = this.matchOperator(expr.levels.filter((level) => level.assoc !== "prefix"), index);
        if (!match || match.level.bp < min) return { ok: true, value, next: index };
        if (match.level.assoc === "postfix") {
          value = {
            kind: "postfix",
            operator: this.operatorText(match),
            operand: value,
            span: this.span(pos, match.next),
          };
          index = match.next;
          continue;
        }
        const right = this.parsePrecedenceAt(
          expr,
          match.next,
          match.level.assoc === "right" ? match.level.bp : match.level.bp + 1,
        );
        if (!right.ok) return { ok: false, committed: true };
        value = {
          kind: "binary",
          operator: this.operatorText(match),
          left: value,
          right: right.value,
          span: this.span(pos, right.next),
        };
        index = right.next;
        if (match.level.assoc === "none") {
          const again = this.matchOperator([match.level], index);
          if (again) {
            const token = this.token(index);
            this.diagnostics.push(error(
              `${JSON.stringify(again.text)} cannot be chained; add parentheses`,
              token.span,
              { code: "parse/associativity" },
            ));
            return { ok: false, committed: true };
          }
        }
      }
    } finally {
      this.depth--;
    }
  }

  matchOperator(
    levels: readonly PrecLevel[],
    pos: number,
  ): { level: PrecLevel; value: unknown; next: number; start: number; text: string; span: Span } | undefined {
    let best: { level: PrecLevel; value: unknown; next: number; start: number; text: string; span: Span } | undefined;
    for (const level of levels) {
      for (const operator of level.operators) {
        const reply = this.probe(() => this.parseExpr(operator, pos));
        if (!reply.ok || reply.next === pos) continue;
        const span = this.span(pos, reply.next);
        const asText = this.tokenText(reply.value);
        const text = asText ? asText.text : this.tokens.slice(pos, reply.next).map((entry) => entry.text).join("");
        const match = { level, value: reply.value, next: reply.next, start: pos, text, span };
        if (!best || span.end - span.start > best.span.end - best.span.start) best = match;
      }
    }
    return best;
  }

  operatorText(match: { value: unknown; span: Span; text: string }): unknown {
    return this.tokenText(match.value) ?? { text: match.text, span: match.span };
  }

  tokenText(value: unknown): { text: string; span: Span } | undefined {
    if (
      value !== null && typeof value === "object" && "text" in value && "span" in value
      && typeof value.text === "string"
    ) return value as { text: string; span: Span };
    return undefined;
  }
}

export type ItemRange = {
  readonly values: readonly unknown[];
  readonly diagnostics: readonly Diagnostic[];
  /** Token index the range parse stopped at. */
  readonly next: number;
  /** First-token set of the item rule. */
  readonly first: ReadonlySet<Key>;
};

/**
 * Parse the incremental item rule repeatedly over `[startToken, stopToken)`.
 * This mirrors the root repetition's recovery loop without exposing `Machine`.
 */
export const parseItemRange = (
  spec: GrammarSpec,
  tokens: readonly LexToken[],
  startToken: number,
  stopToken: number,
  options: ParseOptions = {},
): ItemRange => {
  const incremental = spec.incremental;
  if (!incremental || tokens.length === 0) {
    return { values: [], diagnostics: [], next: startToken, first: new Set<Key>() };
  }
  const root = spec.rules[spec.root]?.expr;
  const sequence = root?.t === "alt" && root.alts.length === 1 && root.alts[0]!.t === "seq"
    ? root.alts[0]!
    : null;
  const repetition = sequence?.items
    .map((item) => item.expr)
    .findLast((expr): expr is Extract<PExpr, { readonly t: "star" | "plus"; }> =>
      (expr.t === "star" || expr.t === "plus") && expr.recover
    ) ?? null;
  if (!repetition) {
    return { values: [], diagnostics: [], next: startToken, first: new Set<Key>() };
  }
  const item = repetition.e;
  const machine = new Machine(spec, tokens, options.maxDepth ?? 2048);
  const values: unknown[] = [];
  const stop = Math.max(0, Math.min(stopToken, tokens.length - 1));
  let cursor = Math.max(0, Math.min(startToken, tokens.length - 1));
  while (cursor < stop) {
    const token = machine.token(cursor);
    if (token.kind === "eof") break;
    if (!item.nullable && !matches(item.first, token)) break;
    const before = cursor;
    const reply = machine.parseExpr(item, cursor);
    if (reply.ok) {
      if (reply.next === cursor) break;
      values.push(reply.value);
      cursor = reply.next;
      continue;
    }
    cursor = machine.recover(repetition, cursor);
    if (cursor === before) cursor++;
  }
  for (let index = startToken; index < Math.max(cursor, stop) && index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.kind !== "error") continue;
    if (machine.diagnostics.some((entry) => entry.span.start === token.span.start)) continue;
    machine.diagnostics.push(
      error(`Unexpected character ${JSON.stringify(token.text)}`, token.span, { code: "parse/character" }),
    );
  }
  return { values, diagnostics: machine.diagnostics, next: cursor, first: item.first };
};

export const parseSource = <A = unknown>(
  spec: GrammarSpec,
  source: string,
  options: ParseOptions = {},
): ParseResult<A> => {
  const list: TokenList = lex(spec, source);
  const machine = new Machine(spec, list.tokens, options.maxDepth ?? 2048);
  const reply = machine.parseRoot();
  for (const token of list.tokens) {
    if (token.kind !== "error") continue;
    const existing = machine.diagnostics.find((entry) => entry.span.start === token.span.start);
    if (existing) continue;
    machine.diagnostics.push(
      error(`Unexpected character ${JSON.stringify(token.text)}`, token.span, { code: "parse/character" }),
    );
  }
  const diagnostics = sortDiagnostics(machine.diagnostics);
  return {
    ok: reply.ok && diagnostics.every((entry) => entry.severity !== "error"),
    value: reply.ok ? (reply.value as A) : null,
    tokens: list.tokens,
    trivia: list.trivia,
    diagnostics,
  };
};

export const tokensOf = (spec: GrammarSpec, source: string): readonly LexToken[] => lex(spec, source).tokens;

