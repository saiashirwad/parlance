import type { ErrorNode, Span, Text } from "../source.ts";

/** The surface AST of a `.parl` grammar file. Every parser produces exactly these shapes. */
export type GrammarFile = {
  readonly kind: "grammar";
  readonly name: Text;
  readonly skips: readonly Skip[];
  readonly word: Word | null;
  readonly tokens: readonly TokenDecl[];
  readonly root: Root | null;
  readonly rules: readonly Rule[];
  readonly bind: Bind | null;
  readonly span: Span;
};

/** A `bind { ... }` block: declarative name binding over tagged nodes. See docs/02-grammar.md. */
export type Bind = { readonly kind: "bind"; readonly entries: readonly BindEntry[]; readonly span: Span };

/** `tag.field`, or a bare `tag` where an entry allows one. */
export type BindPath = { readonly kind: "path"; readonly node: Text; readonly field: Text | null; readonly span: Span };

/** Where a definition is visible: after its node (sequential), or only inside one field. */
export type BindVisibility =
  | { readonly kind: "after"; readonly span: Span }
  | { readonly kind: "in"; readonly target: BindPath; readonly span: Span };

export type BindEntry =
  | { readonly kind: "import" | "scope"; readonly paths: readonly BindPath[]; readonly span: Span }
  | {
    readonly kind: "builtin";
    readonly names: readonly Text[];
    readonly type: Text;
    readonly label: Text | null;
    readonly span: Span;
  }
  | {
    readonly kind: "def";
    readonly exported: Text | null;
    readonly paths: readonly BindPath[];
    readonly type: Text;
    readonly label: Text | null;
    readonly visibility: BindVisibility | null;
    readonly span: Span;
  }
  | {
    readonly kind: "ref";
    readonly paths: readonly BindPath[];
    readonly label: Text;
    readonly noun: Text | null;
    readonly span: Span;
  }
  | {
    readonly kind: "unique";
    readonly paths: readonly BindPath[];
    readonly owners: readonly Text[];
    readonly message: Text | null;
    readonly span: Span;
  };

export type Skip = { readonly kind: "skip"; readonly pattern: Text; readonly span: Span };
export type Word = { readonly kind: "word"; readonly pattern: Text; readonly span: Span };

export type TokenDecl = {
  readonly kind: "token";
  readonly name: Text;
  readonly pattern: Text;
  readonly highlight: Highlight | null;
  readonly span: Span;
};

export type Highlight = { readonly kind: "highlight"; readonly name: Text; readonly span: Span };
export type Root = { readonly kind: "root"; readonly rule: Text; readonly span: Span };

export type Rule = {
  readonly kind: "rule";
  readonly name: Text;
  readonly body: Body;
  readonly span: Span;
};

/** A repair parse leaves an error node for a missing body or operand (`rule A = ;`, `a:&`). */
export type Body = Precedence | Alternatives | ErrorNode;

export type Alternatives = {
  readonly kind: "alternatives";
  readonly alts: readonly Alternative[];
  readonly span: Span;
};

export type Precedence = {
  readonly kind: "precedence";
  readonly levels: readonly Level[];
  readonly atom: readonly Alternative[];
  readonly span: Span;
};

export type Alternative = {
  readonly kind: "alternative";
  readonly tag: Text | null;
  readonly items: readonly Item[];
  readonly span: Span;
};

export type Item = {
  readonly kind: "item";
  readonly label: Text | null;
  readonly expr: Unary;
  readonly span: Span;
};

export type Level = {
  readonly kind: "level";
  readonly assoc: Text;
  readonly operators: readonly Unary[];
  readonly span: Span;
};

export type Unary =
  | { readonly kind: "and" | "not"; readonly expr: Unary; readonly span: Span }
  | { readonly kind: "star" | "plus" | "opt"; readonly expr: Primary; readonly span: Span }
  | Primary
  | ErrorNode;

export type Primary =
  | { readonly kind: "lit"; readonly text: Text; readonly span: Span }
  | { readonly kind: "re"; readonly source: Text; readonly span: Span }
  | { readonly kind: "token"; readonly name: Text; readonly span: Span }
  | { readonly kind: "word"; readonly span: Span }
  | { readonly kind: "cut"; readonly span: Span }
  | { readonly kind: "ref"; readonly name: Text; readonly span: Span }
  | { readonly kind: "group"; readonly alts: readonly Alternative[]; readonly span: Span }
  | {
    readonly kind: "sep" | "sep1" | "sepEnd" | "sepEnd1";
    readonly item: Unary;
    readonly separator: Unary;
    readonly span: Span;
  };

export const assoc = new Set(["left", "right", "none", "prefix", "postfix"]);
export const declarations = new Set(["grammar", "skip", "word", "token", "root", "rule", "bind"]);
export const builtins = new Set(["word"]);

/** Drops spans so a bootstrap parse and a self-hosted parse can be compared structurally. */
export const withoutSpans = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutSpans);
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "span") continue;
    if (key === "text" && typeof entry === "string") {
      result[key] = entry;
      continue;
    }
    result[key] = withoutSpans(entry);
  }
  return result;
};
