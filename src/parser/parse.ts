import { type Diagnostic, error, sortDiagnostics } from "../diagnostic.ts";
import { type Span } from "../source.ts";
import { lex } from "./lex.ts";
import type { GrammarSpec, KeyId, PExpr, PrecLevel } from "./spec.ts";
import { EOF, ERROR, SYMBOL, TokenList, type TriviaList, WORD } from "./tokens.ts";

export type { Edit } from "../source.ts";

/**
 * AST values this parser produced. `reparse` trusts their item shape and span
 * order instead of re-scanning every node; foreign results are still checked.
 */
export const trustedAst = new WeakSet<object>();

export type ParseOptions = { readonly maxDepth?: number };

export type ParseResult<A = unknown> = {
  readonly ok: boolean;
  readonly value: A | null;
  readonly tokens: TokenList;
  readonly trivia: TriviaList;
  readonly diagnostics: readonly Diagnostic[];
};

type Reply =
  | { readonly ok: true; readonly value: unknown; readonly next: number; readonly cut?: boolean }
  | { readonly ok: false; readonly committed: boolean };

const FAIL: Reply = { ok: false, committed: false };
const NO_OPERATORS: readonly OperatorEntry[] = [];

type OperatorEntry = { readonly level: PrecLevel; readonly operator: PExpr };
type OperatorIndex = {
  readonly prefix: ReadonlyMap<KeyId, readonly OperatorEntry[]>;
  readonly infix: ReadonlyMap<KeyId, readonly OperatorEntry[]>;
  readonly fallbackPrefix: readonly OperatorEntry[];
  readonly fallbackInfix: readonly OperatorEntry[];
};
const operatorIndexes = new WeakMap<readonly PrecLevel[], OperatorIndex>();

const indexOperators = (levels: readonly PrecLevel[]): OperatorIndex => {
  const prefix = new Map<KeyId, OperatorEntry[]>();
  const infix = new Map<KeyId, OperatorEntry[]>();
  const fallbackPrefix: OperatorEntry[] = [];
  const fallbackInfix: OperatorEntry[] = [];
  for (const level of levels) {
    const target = level.assoc === "prefix" ? prefix : infix;
    const fallback = level.assoc === "prefix" ? fallbackPrefix : fallbackInfix;
    for (const operator of level.operators) {
      const keys = idsOf(operator.first);
      if (keys.length === 0) {
        fallback.push({ level, operator });
        continue;
      }
      for (const key of keys) {
        const list = target.get(key);
        if (list) list.push({ level, operator });
        else target.set(key, [{ level, operator }]);
      }
    }
  }
  return { prefix, infix, fallbackPrefix, fallbackInfix };
};

const idsOf = (bits: Uint8Array): KeyId[] => {
  const ids: KeyId[] = [];
  for (let index = 0; index < bits.length; index++) if (bits[index] === 1) ids.push(index);
  return ids;
};

const terminalKey = (expr: PExpr, wordKeyId: KeyId): KeyId => {
  switch (expr.t) {
    case "lit":
    case "token":
    case "re":
      return expr.keyId;
    case "word":
      return wordKeyId;
    default:
      return 0;
  }
};

const terminalAt = (expr: PExpr, kind: number, keyId: KeyId): boolean => {
  switch (expr.t) {
    case "lit":
    case "token":
    case "re":
      return keyId === expr.keyId;
    case "word":
      return kind === WORD;
    default:
      return false;
  }
};

const describe = (keyId: KeyId, spec: GrammarSpec): string => {
  const key = spec.keyText[keyId] ?? "error";
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

const matches = (first: Uint8Array, kind: number, keyId: KeyId, wordKeyId: KeyId): boolean =>
  first[keyId] === 1 || (kind === WORD && first[wordKeyId] === 1);

class Machine {
  readonly spec: GrammarSpec;
  readonly tokens: TokenList;
  readonly maxDepth: number;
  readonly diagnostics: Diagnostic[] = [];
  farthest = -1;
  expected = new Set<KeyId>();
  depth = 0;
  speculative = 0;

  constructor(spec: GrammarSpec, tokens: TokenList, maxDepth: number) {
    this.spec = spec;
    this.tokens = tokens;
    this.maxDepth = maxDepth;
  }

  leaf(index: number): { text: string; span: Span } {
    const tokens = this.tokens;
    const start = tokens.startAt(index);
    const end = tokens.endAt(index);
    return { text: tokens.source.slice(start, end), span: { start, end } };
  }

  span(start: number, next: number): Span {
    const tokens = this.tokens;
    const from = tokens.startAt(start);
    return next > start ? { start: from, end: tokens.endAt(next - 1) } : { start: from, end: from };
  }

  record(keys: Iterable<KeyId>, at: number): void {
    if (this.speculative > 0) return;
    if (at > this.farthest) {
      this.farthest = at;
      this.expected = new Set(keys);
    } else if (at === this.farthest) {
      for (const key of keys) this.expected.add(key);
    }
  }

  fail(keys: Iterable<KeyId>, at: number, committed = false): Reply {
    this.record(keys, at);
    return { ok: false, committed };
  }

  probe(body: () => Reply): Reply {
    const farthest = this.farthest;
    const expected = this.expected;
    const diagnostics = this.diagnostics.length;
    this.speculative++;
    const reply = body();
    this.speculative--;
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
    if (this.tokens.kindAt(reply.next) !== EOF) {
      const start = this.tokens.startAt(reply.next);
      const end = this.tokens.endAt(reply.next);
      this.diagnostics.push(
        error(`Unexpected ${JSON.stringify(this.tokens.textAt(reply.next))}`, { start, end }, { code: "parse/unexpected" }),
      );
    }
    return reply;
  }

  reportExpected(): void {
    const index = this.farthest < 0 ? 0 : this.farthest;
    const start = this.tokens.startAt(index);
    const end = this.tokens.endAt(index);
    const keys = this.expected.size ? [...this.expected] : idsOf(this.spec.rootFirst);
    const message = keys.length
      ? `Expected ${[...new Set(keys.map((key) => describe(key, this.spec)))].join(" or ")}`
      : "Unexpected token";
    const last = this.diagnostics[this.diagnostics.length - 1];
    if (last && last.span.start === start && last.span.end === end) return;
    this.diagnostics.push(error(message, { start, end }, { code: "parse/expected" }));
  }

  recover(expr: Extract<PExpr, { readonly t: "star" | "plus"; }>, start: number): number {
    const tokens = this.tokens;
    const at = Math.max(this.farthest, start);
    const index = Math.min(at, tokens.length - 1);
    const keys = this.expected.size ? [...this.expected] : idsOf(expr.sync);
    const message = keys.length
      ? `Expected ${[...new Set(keys.map((key) => describe(key, this.spec)))].join(" or ")}`
      : "Unexpected token";
    const start0 = tokens.startAt(index);
    const end0 = tokens.endAt(index);
    const last = this.diagnostics[this.diagnostics.length - 1];
    if (!last || last.span.start !== start0) {
      this.diagnostics.push(error(message, { start: start0, end: end0 }, { code: "parse/recover" }));
    }
    let cursor = start;
    let depth = 0;
    while (cursor < tokens.length && tokens.kindAt(cursor) !== EOF) {
      if (cursor > start && depth === 0 && matches(expr.sync, tokens.kindAt(cursor), tokens.keyAt(cursor), this.spec.wordKeyId)) break;
      if (tokens.kindAt(cursor) === SYMBOL) {
        const text = tokens.textAt(cursor);
        if (text === "{" || text === "(" || text === "[") depth++;
        else if (text === "}" || text === ")" || text === "]") depth = Math.max(0, depth - 1);
      }
      cursor++;
    }
    this.farthest = cursor;
    this.expected.clear();
    return cursor === start ? start + 1 : cursor;
  }

  parseExpr(expr: PExpr, pos: number, capture = true): Reply {
    if (this.depth >= this.maxDepth) {
      const start = this.tokens.startAt(pos);
      const end = this.tokens.endAt(pos);
      this.diagnostics.push(error("Expression is nested too deeply", { start, end }, { code: "parse/depth" }));
      return FAIL;
    }
    this.depth++;
    try {
      switch (expr.t) {
        case "lit":
        case "token":
        case "re": {
          if (this.tokens.keyAt(pos) === expr.keyId) {
            return { ok: true, value: capture ? this.leaf(pos) : null, next: pos + 1 };
          }
          return this.fail([expr.keyId], pos);
        }
        case "word": {
          if (this.tokens.kindAt(pos) !== WORD) return this.fail([this.spec.wordKeyId], pos);
          return { ok: true, value: capture ? this.leaf(pos) : null, next: pos + 1 };
        }
        case "ref":
          return this.parseRule(expr.rule, pos);
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

  parseRule(rule: number, pos: number): Reply {
    const expr = this.spec.rules[rule]!.expr;
    switch (expr.t) {
      case "alt":
        return this.parseAlt(expr, pos);
      case "seq":
        return this.parseSeq(expr, pos);
      default:
        return this.parseExpr(expr, pos);
    }
  }

  parseSeq(expr: Extract<PExpr, { readonly t: "seq"; }>, pos: number): Reply {
    const items = expr.items;
    const tag = expr.tag;
    const node: Record<string, unknown> | null = tag === null ? null : { kind: tag };
    const values: unknown[] | null = tag === null ? [] : null;
    const tokens = this.tokens;
    if (tag === null && items.length === 1) {
      const only = items[0]!;
      const sub = only.expr;
      const t = sub.t;
      if (t === "lit" || t === "word" || t === "token" || t === "re") {
        if (!terminalAt(sub, tokens.kindAt(pos), tokens.keyAt(pos))) {
          return this.fail([terminalKey(sub, this.spec.wordKeyId)], pos);
        }
        return { ok: true, value: only.capture ? this.leaf(pos) : null, next: pos + 1 };
      }
    }
    let index = pos;
    let cut = false;
    for (let at = 0; at < items.length; at++) {
      const item = items[at]!;
      const sub = item.expr;
      let value: unknown;
      let next: number;
      const t = sub.t;
      if (t === "lit" || t === "word" || t === "token" || t === "re") {
        if (!terminalAt(sub, tokens.kindAt(index), tokens.keyAt(index))) {
          return cut ? { ok: false, committed: true } : this.fail([terminalKey(sub, this.spec.wordKeyId)], index);
        }
        value = item.capture ? this.leaf(index) : null;
        next = index + 1;
      } else {
        const reply = this.parseExpr(sub, index, item.capture);
        if (!reply.ok) return reply.committed || cut ? { ok: false, committed: true } : reply;
        value = reply.value;
        next = reply.next;
        cut ||= reply.cut === true;
      }
      if (node !== null) {
        const label = item.label;
        if (label !== null && label !== "_") node[label] = value;
      } else if (item.capture) {
        values!.push(value);
      }
      index = next;
    }
    if (node !== null) {
      node.span = this.span(pos, index);
      return { ok: true, value: node, next: index, ...(cut ? { cut: true } : {}) };
    }
    const captured = values!;
    const value = captured.length === 0 ? null : captured.length === 1 ? captured[0] : captured;
    return { ok: true, value, next: index, ...(cut ? { cut: true } : {}) };
  }

  parseAlt(expr: Extract<PExpr, { readonly t: "alt"; }>, pos: number): Reply {
    const tokens = this.tokens;
    const kind = tokens.kindAt(pos);
    const keyId = tokens.keyAt(pos);
    const alts = expr.alts;
    if (alts.length === 1) {
      const alt = alts[0]!;
      if (!(alt.nullable || matches(alt.first, kind, keyId, this.spec.wordKeyId)) && kind !== ERROR && kind !== EOF) {
        this.record(idsOf(alt.first), pos);
        return FAIL;
      }
      return alt.t === "seq" ? this.parseSeq(alt, pos) : this.parseExpr(alt, pos);
    }
    let tried = false;
    for (const alt of alts) {
      if (!(alt.nullable || matches(alt.first, kind, keyId, this.spec.wordKeyId))) continue;
      tried = true;
      const reply = this.parseExpr(alt, pos);
      if (reply.ok) return reply;
      if (reply.committed) return reply;
    }
    if (!tried) {
      if (kind === ERROR || kind === EOF) {
        for (const alt of expr.alts) {
          const reply = this.parseExpr(alt, pos);
          if (reply.ok) return reply;
          if (reply.committed) return reply;
        }
      } else {
        this.record(idsOf(expr.first), pos);
        return FAIL;
      }
    }
    return FAIL;
  }

  parseRepeat(expr: Extract<PExpr, { readonly t: "star" | "plus"; }>, pos: number): Reply {
    const values: unknown[] = [];
    const tokens = this.tokens;
    let index = pos;
    let first = true;
    const item = expr.e;
    const terminal = item.t === "lit" || item.t === "word" || item.t === "token" || item.t === "re";
    const rule = item.t === "ref" ? item.rule : -1;
    for (;;) {
      const kind = tokens.kindAt(index);
      if (kind === EOF) break;
      const keyId = tokens.keyAt(index);
      const canStart = matches(expr.first, kind, keyId, this.spec.wordKeyId) || item.nullable;
      if (!canStart) break;
      if (terminal) {
        if (!terminalAt(item, kind, keyId)) break;
        values.push(this.leaf(index));
        index++;
        first = false;
        continue;
      }
      const before = index;
      const reply = rule >= 0 ? this.parseRule(rule, index) : this.parseExpr(item, index);
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
    if (first && expr.t === "plus") return this.fail(idsOf(expr.first), pos);
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
      const start = this.tokens.startAt(pos);
      const end = this.tokens.endAt(pos);
      this.diagnostics.push(error("Expression is nested too deeply", { start, end }, { code: "parse/depth" }));
      return FAIL;
    }
    this.depth++;
    try {
      let value: unknown;
      let index: number;
      const prefix = this.matchOperator(expr.levels, pos, "prefix");
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
        const match = this.matchOperator(expr.levels, index, "infix");
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
          const again = this.matchOperator(expr.levels, index, "infix");
          if (again && again.level.bp === match.level.bp) {
            const start = this.tokens.startAt(index);
            const end = this.tokens.endAt(index);
            this.diagnostics.push(error(
              `${JSON.stringify(again.text)} cannot be chained; add parentheses`,
              { start, end },
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
    mode: "prefix" | "infix",
  ): { level: PrecLevel; value: unknown; next: number; start: number; text: string; span: Span } | undefined {
    let best: { level: PrecLevel; value: unknown; next: number; start: number; text: string; span: Span } | undefined;
    let index = operatorIndexes.get(levels);
    if (!index) {
      index = indexOperators(levels);
      operatorIndexes.set(levels, index);
    }
    const tokens = this.tokens;
    const keyId = tokens.keyAt(pos);
    const kind = tokens.kindAt(pos);
    const table = mode === "prefix" ? index.prefix : index.infix;
    const fallback = mode === "prefix" ? index.fallbackPrefix : index.fallbackInfix;
    const tryOperator = (entry: OperatorEntry): void => {
      const fast = this.fastOperator(entry.operator, pos);
      const reply = fast ?? this.probe(() => this.parseExpr(entry.operator, pos));
      if (!reply.ok || reply.next === pos) return;
      const span = this.span(pos, reply.next);
      const asText = this.tokenText(reply.value);
      const text = asText ? asText.text : tokens.textAt(pos);
      const match = { level: entry.level, value: reply.value, next: reply.next, start: pos, text, span };
      if (!best || span.end - span.start > best.span.end - best.span.start) best = match;
    };
    for (const entry of table.get(keyId) ?? NO_OPERATORS) tryOperator(entry);
    if (kind === WORD) for (const entry of table.get(this.spec.wordKeyId) ?? NO_OPERATORS) tryOperator(entry);
    for (const entry of fallback) tryOperator(entry);
    return best;
  }

  fastOperator(operator: PExpr, pos: number): Reply | undefined {
    const tokens = this.tokens;
    switch (operator.t) {
      case "lit":
      case "token":
      case "re":
        return tokens.keyAt(pos) === operator.keyId
          ? { ok: true, value: this.leaf(pos), next: pos + 1 }
          : FAIL;
      case "word":
        return tokens.kindAt(pos) === WORD
          ? { ok: true, value: this.leaf(pos), next: pos + 1 }
          : FAIL;
      default:
        return undefined;
    }
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
  /** First-token set of the item rule, indexed by key id. */
  readonly first: Uint8Array;
};

/**
 * Parse the incremental item rule repeatedly over `[startToken, stopToken)`.
 * This mirrors the root repetition's recovery loop without exposing `Machine`.
 */
export const parseItemRange = (
  spec: GrammarSpec,
  tokens: TokenList,
  startToken: number,
  stopToken: number,
  options: ParseOptions = {},
): ItemRange => {
  const incremental = spec.incremental;
  if (!incremental || tokens.length === 0) {
    return { values: [], diagnostics: [], next: startToken, first: new Uint8Array(0) };
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
    return { values: [], diagnostics: [], next: startToken, first: new Uint8Array(0) };
  }
  const item = repetition.e;
  const machine = new Machine(spec, tokens, options.maxDepth ?? 2048);
  const values: unknown[] = [];
  const stop = Math.max(0, Math.min(stopToken, tokens.length - 1));
  let cursor = Math.max(0, Math.min(startToken, tokens.length - 1));
  while (cursor < stop) {
    const kind = tokens.kindAt(cursor);
    if (kind === EOF) break;
    if (!item.nullable && !matches(item.first, kind, tokens.keyAt(cursor), spec.wordKeyId)) break;
    const before = cursor;
    const reply = item.t === "ref" ? machine.parseRule(item.rule, cursor) : machine.parseExpr(item, cursor);
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
    if (tokens.kindAt(index) !== ERROR) continue;
    const start = tokens.startAt(index);
    if (machine.diagnostics.some((entry) => entry.span.start === start)) continue;
    const end = tokens.endAt(index);
    machine.diagnostics.push(
      error(`Unexpected character ${JSON.stringify(tokens.textAt(index))}`, { start, end }, { code: "parse/character" }),
    );
  }
  return { values, diagnostics: machine.diagnostics, next: cursor, first: item.first };
};

export const parseSource = <A = unknown>(
  spec: GrammarSpec,
  source: string,
  options: ParseOptions = {},
): ParseResult<A> => {
  const list = lex(spec, source);
  const machine = new Machine(spec, list, options.maxDepth ?? 2048);
  const reply = machine.parseRoot();
  for (let index = 0; index < list.length; index++) {
    if (list.kindAt(index) !== ERROR) continue;
    const start = list.startAt(index);
    const existing = machine.diagnostics.find((entry) => entry.span.start === start);
    if (existing) continue;
    const end = list.endAt(index);
    machine.diagnostics.push(
      error(`Unexpected character ${JSON.stringify(list.textAt(index))}`, { start, end }, { code: "parse/character" }),
    );
  }
  const diagnostics = sortDiagnostics(machine.diagnostics);
  const value = reply.ok ? (reply.value as A) : null;
  if (value !== null && typeof value === "object") trustedAst.add(value as object);
  return {
    ok: reply.ok && diagnostics.every((entry) => entry.severity !== "error"),
    value,
    tokens: list,
    trivia: list.trivia,
    diagnostics,
  };
};

export const tokensOf = (spec: GrammarSpec, source: string): TokenList => lex(spec, source);
