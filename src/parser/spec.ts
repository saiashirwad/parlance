import type { Span } from "../source.ts";
import type { TokenKind } from "../check/facts.ts";

/** A terminal key used by first-set dispatch. */
export type Key =
  | `word:${string}` // a specific word literal
  | "word" // any word
  | `symbol:${string}`
  | `token:${string}`
  | `regex:${number}`
  | "eof";

export type SeqItem = {
  readonly label: string | null;
  readonly expr: PExpr;
  readonly capture: boolean;
};

export type PExpr = {
  readonly first: ReadonlySet<Key>;
  readonly nullable: boolean;
} & (
  | { readonly t: "lit"; readonly text: string; readonly word: boolean; readonly key: Key; readonly span: Span }
  | { readonly t: "word"; readonly span: Span }
  | { readonly t: "token"; readonly name: string; readonly index: number; readonly span: Span }
  | { readonly t: "re"; readonly index: number; readonly span: Span }
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
    readonly sync: ReadonlySet<Key>;
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
  readonly first: ReadonlySet<Key>;
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
  readonly span: Span;
};

export type InlineSpec = {
  readonly source: string;
  readonly regex: RegExp;
  readonly span: Span;
};

export type GrammarSpec = {
  readonly name: string;
  readonly skips: readonly RegExp[];
  readonly word: RegExp;
  readonly wordSource: string;
  readonly tokens: readonly TokenSpec[];
  readonly inline: readonly InlineSpec[];
  readonly symbols: readonly string[];
  readonly symbolsByFirst: ReadonlyMap<string, readonly string[]>;
  readonly fastWhitespace: boolean;
  readonly fastLineComment: boolean;
  readonly fastBlockComment: boolean;
  readonly asciiWord: boolean;
  readonly keywords: ReadonlySet<string>;
  readonly rules: readonly ParseRule[];
  readonly root: number;
  readonly rootFirst: ReadonlySet<Key>;
  readonly incremental: IncrementalSpec | null;
};

export type IncrementalSpec = {
  /** The item rule expression repeated by the root. */
  readonly item: PExpr;
  /** How the repeated items are stored in the root value. */
  readonly shape: "array" | "field";
  readonly field: string | null;
  /** First tokens of an item. */
  readonly sync: ReadonlySet<Key>;
};

export type LexToken = {
  readonly kind: "word" | "symbol" | "token" | "regex" | "error" | "eof";
  readonly text: string;
  readonly span: Span;
  readonly key: Key;
  readonly name?: string;
  readonly index?: number;
  readonly highlight: TokenKind | null;
};

export type Trivia = { readonly span: Span; readonly kind: "space" | "comment" };

export type TokenList = {
  readonly tokens: readonly LexToken[];
  readonly trivia: readonly Trivia[];
};
