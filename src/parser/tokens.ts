import { type TokenKind, tokenKinds } from "../check/facts.ts";
import type { GrammarSpec, KeyId, LexToken, Trivia } from "./spec.ts";

export const WORD = 0;
export const SYMBOL = 1;
export const TOKEN = 2;
export const REGEX = 3;
export const ERROR = 4;
export const EOF = 5;

const KIND_NAMES = ["word", "symbol", "token", "regex", "error", "eof"] as const;

const kindCodes = new Map<TokenKind, number>(tokenKinds.map((kind, index) => [kind, index + 1]));

export const highlightCode = (kind: TokenKind | null): number => kind === null ? 0 : kindCodes.get(kind) ?? 0;

/** Growable columnar token storage. One pass writes fields; no per-token objects. */
export class TokenBuilder {
  /** `kind | (highlightCode << 3)`. */
  kind: Uint8Array;
  keyId: Uint32Array;
  start: Uint32Array;
  end: Uint32Array;
  count = 0;

  constructor(capacity: number) {
    const size = Math.max(64, capacity);
    this.kind = new Uint8Array(size);
    this.keyId = new Uint32Array(size);
    this.start = new Uint32Array(size);
    this.end = new Uint32Array(size);
  }

  private ensure(capacity: number): void {
    if (capacity <= this.kind.length) return;
    let size = this.kind.length * 2;
    while (size < capacity) size *= 2;
    const kind = new Uint8Array(size);
    kind.set(this.kind);
    this.kind = kind;
    const keyId = new Uint32Array(size);
    keyId.set(this.keyId);
    this.keyId = keyId;
    const start = new Uint32Array(size);
    start.set(this.start);
    this.start = start;
    const end = new Uint32Array(size);
    end.set(this.end);
    this.end = end;
  }

  push(kind: number, keyId: KeyId, start: number, end: number, highlight: number): void {
    if (this.count === this.kind.length) this.ensure(this.count + 1);
    const at = this.count++;
    this.kind[at] = kind | (highlight << 3);
    this.keyId[at] = keyId;
    this.start[at] = start;
    this.end[at] = end;
  }

  finish(source: string, trivia: TriviaBuilder, spec: GrammarSpec): TokenList {
    return new TokenList(
      source,
      this.kind,
      this.keyId,
      this.start,
      this.end,
      this.count,
      trivia.finish(),
      spec.wordKeyId,
      spec.tokens.map((token) => token.name),
      spec.ruleOf,
    );
  }

  append(tokens: TokenList, from: number, to: number, delta: number): void {
    const count = to - from;
    if (count <= 0) return;
    const at = this.count;
    this.ensure(at + count);
    this.kind.set(tokens.kind.subarray(from, to), at);
    this.keyId.set(tokens.keyId.subarray(from, to), at);
    this.start.set(tokens.start.subarray(from, to), at);
    this.end.set(tokens.end.subarray(from, to), at);
    if (delta !== 0) {
      for (let index = 0; index < count; index++) {
        this.start[at + index] = this.start[at + index]! + delta;
        this.end[at + index] = this.end[at + index]! + delta;
      }
    }
    this.count = at + count;
  }
}

export class TriviaBuilder {
  start: Uint32Array;
  end: Uint32Array;
  kind: Uint8Array;
  count = 0;

  constructor(capacity: number) {
    const size = Math.max(16, capacity);
    this.start = new Uint32Array(size);
    this.end = new Uint32Array(size);
    this.kind = new Uint8Array(size);
  }

  private ensure(capacity: number): void {
    if (capacity <= this.start.length) return;
    let size = this.start.length * 2;
    while (size < capacity) size *= 2;
    const start = new Uint32Array(size);
    start.set(this.start);
    this.start = start;
    const end = new Uint32Array(size);
    end.set(this.end);
    this.end = end;
    const kind = new Uint8Array(size);
    kind.set(this.kind);
    this.kind = kind;
  }

  push(start: number, end: number, comment: boolean): void {
    if (this.count === this.start.length) this.ensure(this.count + 1);
    const at = this.count++;
    this.start[at] = start;
    this.end[at] = end;
    this.kind[at] = comment ? 1 : 0;
  }

  finish(): TriviaList {
    return new TriviaList(this.start, this.end, this.kind, this.count);
  }

  append(trivia: TriviaList, from: number, to: number, delta: number): void {
    const count = to - from;
    if (count <= 0) return;
    const at = this.count;
    this.ensure(at + count);
    this.start.set(trivia.start.subarray(from, to), at);
    this.end.set(trivia.end.subarray(from, to), at);
    this.kind.set(trivia.kind.subarray(from, to), at);
    if (delta !== 0) {
      for (let index = 0; index < count; index++) {
        this.start[at + index] = this.start[at + index]! + delta;
        this.end[at + index] = this.end[at + index]! + delta;
      }
    }
    this.count = at + count;
  }
}

export class TriviaList {
  readonly length: number;
  readonly start: Uint32Array;
  readonly end: Uint32Array;
  readonly kind: Uint8Array;

  constructor(start: Uint32Array, end: Uint32Array, kind: Uint8Array, length: number) {
    this.start = start;
    this.end = end;
    this.kind = kind;
    this.length = length;
  }

  at(index: number): Trivia {
    return {
      start: this.start[index]!,
      end: this.end[index]!,
      kind: this.kind[index] === 1 ? "comment" : "space",
    };
  }

  toArray(): Trivia[] {
    const result = new Array<Trivia>(this.length);
    for (let index = 0; index < this.length; index++) result[index] = this.at(index);
    return result;
  }

  *[Symbol.iterator](): IterableIterator<Trivia> {
    for (let index = 0; index < this.length; index++) yield this.at(index);
  }
}

export class TokenList {
  readonly source: string;
  readonly length: number;
  /** `kind | (highlightCode << 3)`. Use `kindAt` and `highlightAt` to read it. */
  readonly kind: Uint8Array;
  readonly keyId: Uint32Array;
  readonly start: Uint32Array;
  readonly end: Uint32Array;
  readonly trivia: TriviaList;
  readonly wordKeyId: KeyId;
  readonly tokenNames: readonly string[];
  readonly ruleOf: Int32Array;

  constructor(
    source: string,
    kind: Uint8Array,
    keyId: Uint32Array,
    start: Uint32Array,
    end: Uint32Array,
    length: number,
    trivia: TriviaList,
    wordKeyId: KeyId,
    tokenNames: readonly string[],
    ruleOf: Int32Array,
  ) {
    this.source = source;
    this.kind = kind;
    this.keyId = keyId;
    this.start = start;
    this.end = end;
    this.length = length;
    this.trivia = trivia;
    this.wordKeyId = wordKeyId;
    this.tokenNames = tokenNames;
    this.ruleOf = ruleOf;
  }

  kindAt(index: number): number {
    return this.kind[index < this.length ? index : this.length - 1]! & 7;
  }

  highlightAt(index: number): number {
    return this.kind[index < this.length ? index : this.length - 1]! >> 3;
  }

  keyAt(index: number): KeyId {
    return this.keyId[index < this.length ? index : this.length - 1]!;
  }

  startAt(index: number): number {
    return this.start[index < this.length ? index : this.length - 1]!;
  }

  endAt(index: number): number {
    return this.end[index < this.length ? index : this.length - 1]!;
  }

  textAt(index: number): string {
    const at = index < this.length ? index : this.length - 1;
    return this.source.slice(this.start[at]!, this.end[at]!);
  }

  at(index: number): LexToken {
    const packed = this.kind[index]!;
    const kind = packed & 7;
    const start = this.start[index]!;
    const end = this.end[index]!;
    const keyId = this.keyId[index]!;
    const highlight = packed >> 3;
    const token: {
      kind: LexToken["kind"];
      text: string;
      start: number;
      end: number;
      keyId: KeyId;
      name?: string;
      index?: number;
      highlight: TokenKind | null;
    } = {
      kind: KIND_NAMES[kind]!,
      text: start === end ? "" : this.source.slice(start, end),
      start,
      end,
      keyId,
      highlight: highlight === 0 ? null : tokenKinds[highlight - 1]!,
    };
    if (kind === TOKEN) {
      const rule = this.ruleOf[keyId] ?? -1;
      token.name = this.tokenNames[rule] ?? "";
      token.index = rule;
    } else if (kind === REGEX) {
      token.index = this.ruleOf[keyId] ?? -1;
    }
    return token as LexToken;
  }

  toArray(): LexToken[] {
    const result = new Array<LexToken>(this.length);
    for (let index = 0; index < this.length; index++) result[index] = this.at(index);
    return result;
  }

  *[Symbol.iterator](): IterableIterator<LexToken> {
    for (let index = 0; index < this.length; index++) yield this.at(index);
  }
}
