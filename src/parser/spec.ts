import type { Span } from "../source.ts";
import type { TokenKind } from "../check/facts.ts";

/** A terminal key used by first-set dispatch. */
export type Key =
  | `word:${string}` // a specific word literal
  | "word" // any word
  | `symbol:${string}`
  | `token:${string}`
  | `regex:${number}`
  | "error"
  | "eof";

/** An interned `Key`. First sets are indexed by this. */
export type KeyId = number;

export type SeqItem = {
  readonly label: string | null;
  readonly expr: PExpr;
  readonly capture: boolean;
};

export type PExpr = {
  /** Indexed by `KeyId`. */
  readonly first: Uint8Array;
  readonly nullable: boolean;
} & (
  | { readonly t: "lit"; readonly text: string; readonly word: boolean; readonly keyId: KeyId; readonly span: Span }
  | { readonly t: "word"; readonly span: Span }
  | { readonly t: "token"; readonly name: string; readonly index: number; readonly keyId: KeyId; readonly span: Span }
  | { readonly t: "re"; readonly index: number; readonly keyId: KeyId; readonly span: Span }
  | { readonly t: "ref"; readonly rule: number; readonly span: Span }
  | {
    readonly t: "seq";
    readonly tag: string | null;
    readonly items: readonly SeqItem[];
    readonly captures: number;
    readonly span: Span;
  }
  | {
    readonly t: "alt";
    readonly alts: readonly PExpr[];
    readonly span: Span;
  }
  | {
    readonly t: "star" | "plus";
    readonly e: PExpr;
    readonly recover: boolean;
    readonly sync: Uint8Array;
    readonly span: Span;
  }
  | { readonly t: "opt"; readonly e: PExpr; readonly span: Span }
  | { readonly t: "and" | "not"; readonly e: PExpr; readonly span: Span }
  | {
    readonly t: "sep";
    readonly item: PExpr;
    readonly separator: PExpr;
    readonly min: 0 | 1;
    readonly trailing: boolean;
    readonly span: Span;
  }
  | { readonly t: "cut"; readonly span: Span }
  | {
    readonly t: "precedence";
    readonly levels: readonly PrecLevel[];
    readonly atom: PExpr;
    readonly span: Span;
  }
);

export type PrecLevel = {
  readonly assoc: "left" | "right" | "none" | "prefix" | "postfix";
  readonly bp: number;
  readonly operators: readonly PExpr[];
  readonly first: Uint8Array;
  readonly span: Span;
};

export type ParseRule = {
  readonly name: string;
  readonly expr: PExpr;
  readonly span: Span;
};

export type TokenSpec = {
  readonly name: string;
  readonly source: string;
  readonly regex: RegExp;
  readonly first: Uint8Array | null;
  readonly highlight: TokenKind | null;
  readonly highlightCode: number;
  /** 0 = regex, 1 = digits, 2 = digits with an optional fractional part. */
  readonly fast: number;
  readonly keyId: KeyId;
  readonly span: Span;
};

export type InlineSpec = {
  readonly source: string;
  readonly regex: RegExp;
  readonly keyId: KeyId;
  readonly span: Span;
};

export type SymbolSpec = {
  readonly text: string;
  readonly keyId: KeyId;
};

export type GrammarSpec = {
  readonly name: string;
  readonly skips: readonly RegExp[];
  /** Skips the lexer's fixed scanners do not cover; `skips` minus fast whitespace and comments. */
  readonly slowSkips: readonly RegExp[];
  readonly word: RegExp;
  readonly wordSource: string;
  readonly tokens: readonly TokenSpec[];
  readonly inline: readonly InlineSpec[];
  readonly symbols: readonly string[];
  /** One-character symbols indexed by UTF-16 code unit. */
  readonly singleSymbols: readonly (SymbolSpec | undefined)[];
  /** Longer symbols grouped by first UTF-16 code unit. */
  readonly multiSymbolsByFirst: ReadonlyMap<number, readonly SymbolSpec[]>;
  /** Interned key strings, indexed by `KeyId`. */
  readonly keyText: readonly Key[];
  /** Token or inline-regex rule index for each key id; -1 for other keys. */
  readonly ruleOf: Int32Array;
  readonly wordKeyId: KeyId;
  readonly eofKeyId: KeyId;
  readonly errorKeyId: KeyId;
  /** Keyword text to its specific key id. Other words use `wordKeyId`. */
  readonly keywordIds: ReadonlyMap<string, KeyId>;
  /** Keyword candidates indexed by length, for allocation-free lexing. */
  readonly keywordCandidates: readonly (readonly SymbolSpec[] | undefined)[];
  readonly maxKeywordLength: number;
  readonly wordHighlight: number;
  readonly keywordHighlight: number;
  readonly symbolHighlight: number;
  readonly regexHighlight: number;
  readonly fastWhitespace: boolean;
  readonly fastLineComment: boolean;
  readonly fastBlockComment: boolean;
  readonly asciiWord: boolean;
  readonly keywords: ReadonlySet<string>;
  readonly rules: readonly ParseRule[];
  readonly root: number;
  readonly rootFirst: Uint8Array;
  readonly incremental: IncrementalSpec | null;
};

export type IncrementalSpec = {
  /** The item rule expression repeated by the root. */
  readonly item: PExpr;
  /** How the repeated items are stored in the root value. */
  readonly shape: "array" | "field";
  readonly field: string | null;
  /** First tokens of an item, indexed by key id. */
  readonly sync: Uint8Array;
  /** Minimum number of items the root repetition requires. */
  readonly min: 0 | 1;
  /** Root syntax outside the repetition that is not captured, such as header/footer literals. */
  readonly guarded: boolean;
};

export type LexToken = {
  readonly kind: "word" | "symbol" | "token" | "regex" | "error" | "eof";
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly keyId: KeyId;
  readonly name?: string;
  readonly index?: number;
  readonly highlight: TokenKind | null;
};

export type Trivia = { readonly start: number; readonly end: number; readonly kind: "space" | "comment" };

