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

/**
 * Root values with an item whose parse read past its neighbour, or that a
 * repair rolled back over. `reparse` falls back to a full parse for them.
 */
export const fragileAst = new WeakSet<object>();

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

type Success = Extract<Reply, { readonly ok: true; }>;

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

type SeqExpr = Extract<PExpr, { readonly t: "seq"; }>;
type RepeatExpr = Extract<PExpr, { readonly t: "star" | "plus"; }>;

const isTerminal = (expr: PExpr): boolean => expr.t === "lit" || expr.t === "word" || expr.t === "token" || expr.t === "re";

/** Keys an expression can start with. Terminals carry no first set of their own. */
const firstKeys = (expr: PExpr, wordKeyId: KeyId): KeyId[] =>
  isTerminal(expr) ? [terminalKey(expr, wordKeyId)] : idsOf(expr.first);

/** What repair needs to know about one sequence. */
type SeqRepair = {
  /** A matched literal commits the sequence: no later sibling alternative starts the same way. */
  readonly commits: boolean;
  /** Per item: keys that end a skip while the item is repaired (the items after it, and its own list). */
  readonly follow: readonly Int32Array[];
  /** Per item: literals the sequence still waits for after it. */
  readonly awaits: readonly Int32Array[];
};

type GrammarRepair = {
  readonly seqs: Map<SeqExpr, SeqRepair>;
  /** Sequences a later sibling alternative can also start, through a different path. */
  readonly shared: ReadonlySet<SeqExpr>;
};

const grammarRepairs = new WeakMap<GrammarSpec, GrammarRepair>();

/** Sequences that can begin an expression: the ones whose commit would decide an enclosing choice. */
const headSeqs = (spec: GrammarSpec, expr: PExpr, out: Set<SeqExpr>, seen: Set<PExpr>): Set<SeqExpr> => {
  if (seen.has(expr)) return out;
  seen.add(expr);
  switch (expr.t) {
    case "seq":
      out.add(expr);
      for (const item of expr.items) {
        headSeqs(spec, item.expr, out, seen);
        if (!item.expr.nullable) break;
      }
      break;
    case "alt":
      for (const alt of expr.alts) headSeqs(spec, alt, out, seen);
      break;
    case "ref":
      headSeqs(spec, spec.rules[expr.rule]!.expr, out, seen);
      break;
    case "star":
    case "plus":
    case "opt":
      headSeqs(spec, expr.e, out, seen);
      break;
    case "precedence":
      headSeqs(spec, expr.atom, out, seen);
      break;
  }
  return out;
};

/**
 * The spans of sequences whose matched literal does not commit them in repair,
 * because a later sibling alternative can start the same way. The type
 * generator uses it to place error nodes exactly.
 */
export const sharedSequenceSpans = (spec: GrammarSpec): ReadonlySet<string> =>
  new Set([...repairOf(spec).shared].map((seq) => `${seq.span.start}:${seq.span.end}`));

const repairOf = (spec: GrammarSpec): GrammarRepair => {
  const found = grammarRepairs.get(spec);
  if (found) return found;
  const shared = new Set<SeqExpr>();
  const seen = new Set<PExpr>();
  const walk = (expr: PExpr): void => {
    if (seen.has(expr)) return;
    seen.add(expr);
    switch (expr.t) {
      case "alt":
        expr.alts.forEach((alt, at) => {
          walk(alt);
          const heads = headSeqs(spec, alt, new Set(), new Set());
          for (let later = at + 1; later < expr.alts.length; later++) {
            const other = expr.alts[later]!;
            const otherHeads = headSeqs(spec, other, new Set(), new Set());
            const keys = firstKeys(other, spec.wordKeyId);
            for (const head of heads) {
              // `Postfix | Base` where Postfix starts with Base: both paths reach the same sequence.
              if (otherHeads.has(head)) continue;
              if (keys.some((key) => head.first[key] === 1)) shared.add(head);
            }
          }
        });
        return;
      case "seq":
        for (const item of expr.items) walk(item.expr);
        return;
      case "star":
      case "plus":
      case "opt":
      case "and":
      case "not":
        walk(expr.e);
        return;
      case "sep":
        walk(expr.item);
        walk(expr.separator);
        return;
      case "precedence":
        walk(expr.atom);
        for (const level of expr.levels) for (const operator of level.operators) walk(operator);
        return;
      default:
        return;
    }
  };
  for (const rule of spec.rules) walk(rule.expr);
  const repair = { seqs: new Map(), shared };
  grammarRepairs.set(spec, repair);
  return repair;
};

const seqRepairOf = (spec: GrammarSpec, expr: SeqExpr): SeqRepair => {
  const grammar = repairOf(spec);
  const found = grammar.seqs.get(expr);
  if (found) return found;
  const follow: Int32Array[] = [];
  const awaits: Int32Array[] = [];
  for (let at = 0; at < expr.items.length; at++) {
    const own = expr.items[at]!.expr;
    const keys = new Set<KeyId>();
    const literals = new Set<KeyId>();
    if (own.t === "star" || own.t === "plus") for (const key of idsOf(own.first)) keys.add(key);
    if (own.t === "sep") {
      for (const key of idsOf(own.first)) keys.add(key);
      for (const key of firstKeys(own.separator, spec.wordKeyId)) keys.add(key);
    }
    for (let later = at + 1; later < expr.items.length; later++) {
      const next = expr.items[later]!.expr;
      for (const key of firstKeys(next, spec.wordKeyId)) keys.add(key);
      if (next.t === "lit") literals.add(next.keyId);
    }
    follow.push(Int32Array.from(keys));
    awaits.push(Int32Array.from(literals));
  }
  const repair = { commits: !grammar.shared.has(expr), follow, awaits };
  grammar.seqs.set(expr, repair);
  return repair;
};

const COMMITTED: Reply = { ok: false, committed: true };

class Machine {
  readonly spec: GrammarSpec;
  readonly tokens: TokenList;
  readonly maxDepth: number;
  readonly diagnostics: Diagnostic[] = [];
  farthest = -1;
  expected = new Set<KeyId>();
  depth = 0;
  speculative = 0;
  /** Farthest token a terminal failed at since the current root item started. */
  high = -1;
  /** Repair mode: a committed sequence fills in what is missing instead of failing. */
  resilient = false;
  /** Inside a predicate or an operator probe, where a repair would change what matched. */
  noRecover = 0;
  /** Repair parses so far; memo entries of one repair are not reused by another. */
  repairs = 0;
  /** An item read past its neighbour or a rollback happened; see `fragileAst`. */
  fragile = false;
  /** Set by `parseItem`: the farthest token the last item looked at, and whether it was repaired. */
  itemHigh = -1;
  itemRepaired = false;
  /** Counted stacks: keys that end a skip, and literals an enclosing sequence still waits for. */
  sync: Int32Array | null = null;
  awaited: Int32Array | null = null;
  /** Keywords a root item can start with; a skipped bracket group never runs past one. */
  rootStarts: Uint8Array | null = null;
  /** One memo entry per rule: the token position, mode, reply, diagnostics and reach of its latest parse. */
  readonly memoAt: Int32Array;
  readonly memoMode: Int32Array;
  readonly memoHigh: Int32Array;
  readonly memoReply: (Reply | undefined)[];
  readonly memoDiagnostics: (Diagnostic[] | null)[];

  constructor(spec: GrammarSpec, tokens: TokenList, maxDepth: number) {
    this.memoAt = new Int32Array(spec.rules.length).fill(-1);
    this.memoMode = new Int32Array(spec.rules.length);
    this.memoHigh = new Int32Array(spec.rules.length);
    this.memoReply = new Array(spec.rules.length);
    this.memoDiagnostics = new Array(spec.rules.length).fill(null);
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
    if (at > this.high) this.high = at;
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
          // In repair, a name does not swallow a keyword an enclosing sequence waits for (`let x = in`).
          if (this.resilient && this.noRecover === 0 && this.awaited![this.tokens.keyAt(pos)]! > 0) {
            return this.fail([this.spec.wordKeyId], pos);
          }
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
          this.noRecover++;
          const reply = this.probe(() => this.parseExpr(expr.e, pos));
          this.noRecover--;
          return reply.ok ? { ok: true, value: null, next: pos } : { ok: false, committed: false };
        }
        case "not": {
          this.noRecover++;
          const reply = this.probe(() => this.parseExpr(expr.e, pos));
          this.noRecover--;
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

  /**
   * Alternatives that share a prefix ("Base | Postfix") reparse the same rule at
   * the same token. Remembering the latest reply per rule makes that linear.
   * Failures are only kept outside probes, which do not record what they expected.
   * Repair replies depend on the enclosing sync sets, so each repair keeps its own.
   */
  parseRule(rule: number, pos: number): Reply {
    const mode = this.resilient ? this.repairs * 2 + (this.noRecover > 0 ? 1 : 0) : 0;
    if (this.memoAt[rule] === pos && this.memoMode[rule] === mode) {
      const diagnostics = this.memoDiagnostics[rule];
      if (diagnostics) for (const entry of diagnostics) this.diagnostics.push(entry);
      const high = this.memoHigh[rule]!;
      if (high > this.high) this.high = high;
      return this.memoReply[rule]!;
    }
    const mark = this.diagnostics.length;
    const outer = this.high;
    this.high = -1;
    const expr = this.spec.rules[rule]!.expr;
    let reply: Reply;
    switch (expr.t) {
      case "alt":
        reply = this.parseAlt(expr, pos);
        break;
      case "seq":
        reply = this.parseSeq(expr, pos);
        break;
      default:
        reply = this.parseExpr(expr, pos);
    }
    const high = this.high;
    if (outer > high) this.high = outer;
    if (reply.ok || this.speculative === 0) {
      this.memoAt[rule] = pos;
      this.memoMode[rule] = mode;
      this.memoHigh[rule] = high;
      this.memoReply[rule] = reply;
      this.memoDiagnostics[rule] = this.diagnostics.length > mark ? this.diagnostics.slice(mark) : null;
    }
    return reply;
  }

  parseSeq(expr: SeqExpr, pos: number): Reply {
    if (this.resilient) return this.parseSeqRepair(expr, pos);
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
          if (index > this.high) this.high = index;
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

  /** Zero-width offset for a synthesized node: just after the last consumed token. */
  gap(index: number): number {
    return index > 0 ? this.tokens.endAt(index - 1) : this.tokens.startAt(index);
  }

  errorNode(index: number): { kind: "error"; span: Span } {
    const at = this.gap(index);
    return { kind: "error", span: { start: at, end: at } };
  }

  /** The value a failed expression stands in for, shaped like what its rule would have produced. */
  missing(expr: PExpr, index: number, depth = 0): unknown {
    if (depth > 32) return this.errorNode(index);
    switch (expr.t) {
      case "lit":
      case "word":
      case "token":
      case "re": {
        const at = this.gap(index);
        return { text: "", span: { start: at, end: at }, missing: true };
      }
      case "ref":
        return this.missing(this.spec.rules[expr.rule]!.expr, index, depth + 1);
      case "seq": {
        if (expr.tag !== null) return this.errorNode(index);
        const captured = expr.items.filter((item) => item.capture);
        if (captured.length === 0) return null;
        if (captured.length === 1) return this.missing(captured[0]!.expr, index, depth + 1);
        return captured.map((item) => this.missing(item.expr, index, depth + 1));
      }
      case "alt": {
        if (expr.alts.length === 1) return this.missing(expr.alts[0]!, index, depth + 1);
        // Alternatives of one shape (all tokens, all lists, all empty) keep it; mixed ones become an error node.
        const shapes = expr.alts.map((alt) => this.missing(alt, index, depth + 1));
        const token = (value: unknown): boolean =>
          value !== null && typeof value === "object" && (value as { missing?: boolean }).missing === true;
        if (shapes.every(token)) return shapes[0];
        if (shapes.every((value) => Array.isArray(value) && value.length === 0)) return [];
        if (shapes.every((value) => value === null)) return null;
        return this.errorNode(index);
      }
      case "star":
      case "plus":
      case "sep":
        return [];
      case "opt":
      case "and":
      case "not":
      case "cut":
        return null;
      case "precedence":
        return this.errorNode(index);
    }
  }

  /**
   * Report a missing expression. The span is the last character before the gap,
   * so the diagnostic stays inside the item that owns it (incremental reparse
   * keeps diagnostics by span).
   */
  expect(keys: readonly KeyId[], index: number): void {
    const tokens = this.tokens;
    const at = Math.min(index, tokens.length - 1);
    const end = at > 0 ? tokens.endAt(at - 1) : tokens.endAt(at);
    const start = at > 0 ? Math.max(tokens.startAt(at - 1), end - 1) : tokens.startAt(at);
    const last = this.diagnostics[this.diagnostics.length - 1];
    if (last && last.code === "parse/missing" && last.span.start === start) return;
    const names = [...new Set(keys.map((key) => describe(key, this.spec)))];
    const message = names.length ? `Expected ${names.join(" or ")}` : "Unexpected token";
    this.diagnostics.push(error(message, { start, end }, { code: "parse/missing" }));
  }

  pushSync(follow: Int32Array, awaits: Int32Array, by: 1 | -1): void {
    const sync = this.sync!;
    const awaited = this.awaited!;
    for (let index = 0; index < follow.length; index++) sync[follow[index]!]! += by;
    for (let index = 0; index < awaits.length; index++) awaited[awaits[index]!]! += by;
  }

  inSync(kind: number, keyId: KeyId): boolean {
    const sync = this.sync!;
    return sync[keyId]! > 0 || (kind === WORD && sync[this.spec.wordKeyId]! > 0);
  }

  /** Skip one token, or a whole bracket group when it closes before anything an enclosing rule waits for. */
  skipOne(index: number): number {
    const tokens = this.tokens;
    if (tokens.kindAt(index) !== SYMBOL) return index + 1;
    const open = tokens.textAt(index);
    if (open !== "(" && open !== "[" && open !== "{") return index + 1;
    const awaited = this.awaited!;
    const starts = this.rootStarts!;
    let depth = 0;
    for (let cursor = index; cursor < tokens.length && tokens.kindAt(cursor) !== EOF; cursor++) {
      if (cursor > this.high) this.high = cursor;
      const keyId = tokens.keyAt(cursor);
      if (cursor > index && (awaited[keyId]! > 0 || starts[keyId] === 1)) break;
      if (tokens.kindAt(cursor) !== SYMBOL) continue;
      const text = tokens.textAt(cursor);
      if (text === "(" || text === "[" || text === "{") depth++;
      else if (text === ")" || text === "]" || text === "}") {
        depth--;
        if (depth === 0) return cursor + 1;
      }
    }
    return index + 1;
  }

  /**
   * `parseSeq` in repair mode. Until the sequence commits (after `~`, or after a
   * literal no later sibling alternative shares) a failure fails as usual. After
   * it, a failed item skips tokens until one it can start with or one in the
   * sync stack, and is either parsed there or left as a placeholder.
   */
  parseSeqRepair(expr: SeqExpr, pos: number): Reply {
    const items = expr.items;
    const tag = expr.tag;
    const node: Record<string, unknown> | null = tag === null ? null : { kind: tag };
    const values: unknown[] | null = tag === null ? [] : null;
    const repair = seqRepairOf(this.spec, expr);
    const tokens = this.tokens;
    const wordKeyId = this.spec.wordKeyId;
    const mark = this.diagnostics.length;
    let index = pos;
    let cut = false;
    let committed = false;
    // The list item just before, so a skip can resume it: `{ id: Int ) name: String }`.
    let list: unknown[] | null = null;
    let listExpr: RepeatExpr | null = null;
    for (let at = 0; at < items.length; at++) {
      const item = items[at]!;
      const sub = item.expr;
      const follow = repair.follow[at]!;
      const awaits = repair.awaits[at]!;
      this.pushSync(follow, awaits, 1);
      let reply = this.parseExpr(sub, index, item.capture);
      let value: unknown;
      let next: number;
      if (reply.ok) {
        value = reply.value;
        next = reply.next;
        if (reply.cut === true) cut = committed = true;
        if (sub.t === "lit" && repair.commits) committed = true;
      } else {
        if (!committed || this.noRecover > 0) {
          this.pushSync(follow, awaits, -1);
          this.diagnostics.length = mark;
          return reply.committed || cut ? COMMITTED : reply;
        }
        const from = index;
        let found = false;
        for (;;) {
          const kind = tokens.kindAt(index);
          if (kind === EOF) break;
          const keyId = tokens.keyAt(index);
          if (index > from) {
            if (listExpr !== null && matches(listExpr.first, kind, keyId, wordKeyId)) {
              const more = this.parseExpr(listExpr, index);
              if (more.ok && more.next > index) {
                for (const entry of more.value as unknown[]) list!.push(entry);
                index = more.next;
                continue;
              }
            }
            reply = this.parseExpr(sub, index, item.capture);
            if (reply.ok && reply.next > index) {
              found = true;
              break;
            }
          }
          if (this.inSync(kind, keyId)) break;
          const after = this.skipOne(index);
          const start = tokens.startAt(index);
          const last = this.diagnostics[this.diagnostics.length - 1];
          if (!last || last.span.start !== start) {
            this.diagnostics.push(error(
              `Unexpected ${JSON.stringify(tokens.textAt(index))}`,
              { start, end: tokens.endAt(after - 1) },
              { code: "parse/skipped" },
            ));
          }
          index = after;
        }
        if (found && reply.ok) {
          value = reply.value;
          next = reply.next;
        } else {
          this.expect(firstKeys(sub, wordKeyId), index);
          value = item.capture ? this.missing(sub, index) : null;
          next = index;
        }
      }
      this.pushSync(follow, awaits, -1);
      if ((sub.t === "star" || sub.t === "plus") && Array.isArray(value)) {
        list = value;
        listExpr = sub;
      } else if (next > index || sub.t !== "cut") {
        list = null;
        listExpr = null;
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

  /** Parse one root item in repair mode. Null when it still fails or consumes nothing. */
  parseRepair(expr: RepeatExpr, pos: number): Success | null {
    const keys = this.spec.keyText.length;
    const base = expr.sync;
    if (this.sync === null) {
      this.sync = new Int32Array(keys);
      this.awaited = new Int32Array(keys);
      const starts = new Uint8Array(keys);
      for (let key = 0; key < base.length; key++) {
        if (base[key] === 1 && this.spec.keyText[key]!.startsWith("word:")) starts[key] = 1;
      }
      this.rootStarts = starts;
    }
    const sync = this.sync;
    for (let key = 0; key < base.length; key++) if (base[key] === 1) sync[key]!++;
    const mark = this.diagnostics.length;
    const { farthest, expected, depth, speculative } = this;
    const item = expr.e;
    this.resilient = true;
    this.repairs++;
    let reply: Reply;
    try {
      reply = item.t === "ref" ? this.parseRule(item.rule, pos) : this.parseExpr(item, pos);
    } catch (cause) {
      // Repair frames are larger than strict ones; on a stack overflow the item is skipped as before.
      if (!(cause instanceof RangeError)) throw cause;
      reply = FAIL;
      this.depth = depth;
      this.speculative = speculative;
      this.noRecover = 0;
      sync.fill(0);
      this.awaited!.fill(0);
      for (let key = 0; key < base.length; key++) if (base[key] === 1) sync[key]!++;
    }
    this.resilient = false;
    for (let key = 0; key < base.length; key++) if (base[key] === 1) sync[key]!--;
    this.farthest = farthest;
    this.expected = expected;
    if (!reply.ok || reply.next === pos) {
      this.diagnostics.length = mark;
      return null;
    }
    return reply;
  }

  /**
   * One root item: the strict parse, then a repair parse if it fails. Sets
   * `itemHigh` to the farthest token either looked at and `itemRepaired`.
   */
  parseItem(expr: RepeatExpr, pos: number): Reply {
    const item = expr.e;
    this.high = -1;
    this.itemRepaired = false;
    const reply = item.t === "ref" ? this.parseRule(item.rule, pos) : this.parseExpr(item, pos);
    if (!reply.ok) {
      const repaired = this.parseRepair(expr, pos);
      if (repaired) {
        this.itemRepaired = true;
        this.itemHigh = this.high;
        return repaired;
      }
    }
    this.itemHigh = this.high;
    return reply;
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

  parseRepeat(expr: RepeatExpr, pos: number): Reply {
    const item = expr.e;
    const terminal = isTerminal(item);
    if (expr.recover && !terminal && !this.resilient) return this.parseItems(expr, pos);
    const values: unknown[] = [];
    const tokens = this.tokens;
    let index = pos;
    let first = true;
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

  /**
   * The root item repetition. A failed item is reparsed in repair mode, and
   * skipped only when that fails too. When the loop is stuck on a token no item
   * starts with, the earliest accepted item that looked at or past that token
   * (it likely settled for a shorter alternative) is reparsed in repair mode.
   */
  parseItems(expr: RepeatExpr, pos: number): Reply {
    const values: unknown[] = [];
    const tokens = this.tokens;
    const item = expr.e;
    // Per accepted item: start token, farthest token it looked at (-1 once
    // repaired), and the diagnostics count before it.
    const starts: number[] = [];
    const highs: number[] = [];
    const marks: number[] = [];
    let index = pos;
    let first = true;
    let floor = pos;
    let reach = -1;
    for (;;) {
      const kind = tokens.kindAt(index);
      if (kind === EOF) break;
      if (!(matches(expr.first, kind, tokens.keyAt(index), this.spec.wordKeyId) || item.nullable)) {
        let back = -1;
        for (let at = 0; at < starts.length; at++) {
          if (starts[at]! >= floor && highs[at]! >= index) {
            back = at;
            break;
          }
        }
        if (back < 0) break;
        // Which item a rollback picks depends on tokens far from it.
        this.fragile = true;
        const from = starts[back]!;
        const mark = marks[back]!;
        const later = this.diagnostics.slice(mark);
        this.diagnostics.length = mark;
        const repaired = this.parseRepair(expr, from);
        floor = from + 1;
        if (repaired && repaired.next > index) {
          values.length = starts.length = highs.length = marks.length = back;
          values.push(repaired.value);
          starts.push(from);
          highs.push(-1);
          marks.push(mark);
          index = repaired.next;
          continue;
        }
        this.diagnostics.length = mark;
        for (const entry of later) this.diagnostics.push(entry);
        continue;
      }
      const before = index;
      const mark = this.diagnostics.length;
      const reply = this.parseItem(expr, index);
      if (reply.ok) {
        if (reply.next === index) break;
        // `reparse` re-reads one neighbour on each side of an edit.
        if (reach >= reply.next) this.fragile = true;
        reach = this.itemHigh;
        values.push(reply.value);
        starts.push(index);
        highs.push(this.itemRepaired ? -1 : this.itemHigh);
        marks.push(mark);
        index = reply.next;
        first = false;
        continue;
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
    const repair = this.resilient && this.noRecover === 0;
    const firstReply = this.probe(() => this.parseExpr(expr.item, index));
    if (firstReply.ok) {
      values.push(firstReply.value);
      index = firstReply.next;
    } else {
      // In repair, a separator where the first item belongs means the item is
      // missing: `f(, a)`. It is reported and left out of the list.
      if (!repair || !this.probe(() => this.parseExpr(expr.separator, index)).ok) {
        if (expr.min === 1) return firstReply;
        return { ok: true, value: values, next: index };
      }
      this.expect(firstKeys(expr.item, this.spec.wordKeyId), index);
    }
    for (;;) {
      const separator = this.probe(() => this.parseExpr(expr.separator, index));
      if (!separator.ok) break;
      const item = this.probe(() => this.parseExpr(expr.item, separator.next));
      if (!item.ok) {
        if (expr.trailing) index = separator.next;
        else if (repair) {
          this.expect(firstKeys(expr.item, this.spec.wordKeyId), separator.next);
          index = separator.next;
          continue;
        }
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
        let operand = this.parsePrecedenceAt(expr, prefix.next, prefix.level.bp);
        if (!operand.ok) {
          // In repair, an operator commits: a missing operand becomes an error node.
          if (!this.resilient || this.noRecover > 0) return operand;
          this.expect(idsOf(expr.first), prefix.next);
          operand = { ok: true, value: this.errorNode(prefix.next), next: prefix.next };
        }
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
        let right = this.parsePrecedenceAt(
          expr,
          match.next,
          match.level.assoc === "right" ? match.level.bp : match.level.bp + 1,
        );
        if (!right.ok) {
          if (!this.resilient || this.noRecover > 0) return COMMITTED;
          this.expect(idsOf(expr.first), match.next);
          right = { ok: true, value: this.errorNode(match.next), next: match.next };
        }
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
      let reply = fast;
      if (!reply) {
        this.noRecover++;
        reply = this.probe(() => this.parseExpr(entry.operator, pos));
        this.noRecover--;
      }
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
  /**
   * Farthest token the last parsed item looked at, or `Number.MAX_SAFE_INTEGER`
   * when an item looked past its neighbour (a full parse marks that fragile).
   */
  readonly reach: number;
  /** Farthest token any parsed item looked at. */
  readonly high: number;
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
    return { values: [], diagnostics: [], next: startToken, first: new Uint8Array(0), reach: -1, high: -1 };
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
    return { values: [], diagnostics: [], next: startToken, first: new Uint8Array(0), reach: -1, high: -1 };
  }
  const item = repetition.e;
  const machine = new Machine(spec, tokens, options.maxDepth ?? 2048);
  const values: unknown[] = [];
  const stop = Math.max(0, Math.min(stopToken, tokens.length - 1));
  let reach = -1;
  let high = -1;
  let cursor = Math.max(0, Math.min(startToken, tokens.length - 1));
  while (cursor < stop) {
    const kind = tokens.kindAt(cursor);
    if (kind === EOF) break;
    if (!item.nullable && !matches(item.first, kind, tokens.keyAt(cursor), spec.wordKeyId)) break;
    const before = cursor;
    const reply = machine.parseItem(repetition, cursor);
    if (machine.itemHigh > high) high = machine.itemHigh;
    if (reply.ok) {
      if (reply.next === cursor) break;
      if (reach >= reply.next) machine.fragile = true;
      reach = machine.itemHigh;
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
  return {
    values,
    diagnostics: machine.diagnostics,
    next: cursor,
    first: item.first,
    reach: machine.fragile ? Number.MAX_SAFE_INTEGER : reach,
    high,
  };
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
  if (value !== null && typeof value === "object") {
    trustedAst.add(value as object);
    if (machine.fragile) fragileAst.add(value as object);
  }
  return {
    ok: reply.ok && diagnostics.every((entry) => entry.severity !== "error"),
    value,
    tokens: list,
    trivia: list.trivia,
    diagnostics,
  };
};

export const tokensOf = (spec: GrammarSpec, source: string): TokenList => lex(spec, source);
