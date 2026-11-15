import type { Diagnostic } from "../diagnostic.ts";
import type { Span } from "../source.ts";

/** LSP semantic token types, plus `comment` for lexer trivia. */
export const tokenKinds = [
  "namespace",
  "type",
  "class",
  "enum",
  "interface",
  "struct",
  "typeParameter",
  "parameter",
  "variable",
  "constant",
  "property",
  "enumMember",
  "event",
  "function",
  "method",
  "macro",
  "keyword",
  "modifier",
  "comment",
  "string",
  "number",
  "regexp",
  "operator",
  "decorator",
] as const;

export type TokenKind = (typeof tokenKinds)[number];

export type Token = { readonly span: Span; readonly kind: TokenKind };

/** Definition kinds a language can declare. Contextual kinds are refined by the language. */
export type DefinitionKind = Extract<
  TokenKind,
  | "namespace"
  | "type"
  | "class"
  | "enum"
  | "interface"
  | "struct"
  | "typeParameter"
  | "parameter"
  | "variable"
  | "property"
  | "enumMember"
  | "event"
  | "function"
  | "method"
  | "macro"
  | "constant"
>;

export type Binding<T = unknown> = {
  readonly id: number;
  readonly name: string;
  readonly kind: DefinitionKind;
  readonly span: Span;
  readonly type?: T;
  readonly uri?: string;
  readonly detail?: string;
};

export type Definition<T = unknown> = Binding<T>;

export type Reference = { readonly id: number; readonly span: Span };

export type Typed<T = unknown> = { readonly span: Span; readonly type: T };

/** Where a definition is visible by its bare name: the extent of its scope, from where it starts. */
export type ScopeExtent = { readonly id: number; readonly span: Span };

export type Facts<T = unknown> = {
  readonly uri?: string;
  readonly diagnostics: Diagnostic[];
  readonly definitions: Definition<T>[];
  readonly references: Reference[];
  readonly types: Typed<T>[];
  readonly tokens: Token[];
  /** Visibility extents, where a checker records them (`bind` does); empty otherwise. */
  readonly scopes: ScopeExtent[];
};

export const facts = <T = unknown>(
  diagnostics: Diagnostic[] = [],
  tokens: Token[] = [],
  uri?: string,
): Facts<T> => ({
  ...(uri === undefined ? {} : { uri }),
  diagnostics,
  definitions: [],
  references: [],
  types: [],
  tokens,
  scopes: [],
});

/** Definitions visible at `offset` by the recorded scope extents, innermost first. */
export const visibleAt = <T>(value: Facts<T>, offset: number): Definition<T>[] => {
  const byId = new Map(value.definitions.map((definition) => [definition.id, definition]));
  return value.scopes
    .filter((scope) => scope.span.start <= offset && offset <= scope.span.end)
    .sort((a, b) => (a.span.end - a.span.start) - (b.span.end - b.span.start))
    .flatMap((scope) => byId.get(scope.id) ?? []);
};

/**
 * What completion offers at `offset`: definitions visible there, plus those no scope extent covers
 * (members, properties). Without recorded scopes every definition is offered.
 */
export const inScope = <T>(value: Facts<T>, offset: number): Definition<T>[] => {
  if (value.scopes.length === 0) return value.definitions;
  const scoped = new Set<number>();
  const visible = new Set<number>();
  for (const scope of value.scopes) {
    scoped.add(scope.id);
    if (scope.span.start <= offset && offset <= scope.span.end) visible.add(scope.id);
  }
  return value.definitions.filter((definition) => visible.has(definition.id) || !scoped.has(definition.id));
};

export const contains = (outer: Span, offset: number): boolean => outer.start <= offset && offset < outer.end;

/** The narrowest typed span containing `offset`. */
export const typeAt = <T>(value: Facts<T>, offset: number): Typed<T> | undefined => {
  let found: Typed<T> | undefined;
  for (const typed of value.types) {
    if (!contains(typed.span, offset)) continue;
    if (!found || typed.span.end - typed.span.start < found.span.end - found.span.start) found = typed;
  }
  return found;
};

export const referenceAt = (value: Facts, offset: number): Reference | undefined =>
  value.references.find((reference) => contains(reference.span, offset));

const local = <T>(value: Facts<T>): Definition<T>[] =>
  value.definitions.filter((definition) => definition.uri === undefined || definition.uri === value.uri);

export const definitionAt = <T>(value: Facts<T>, offset: number): Definition<T> | undefined => {
  const reference = referenceAt(value, offset);
  if (reference) return value.definitions.find((definition) => definition.id === reference.id);
  return local(value).find((definition) => contains(definition.span, offset));
};

const refinedCache = new WeakMap<object, Map<number, TokenKind>>();

/** Definition and reference kinds by span start, for refining lexical tokens. */
export const refinedKinds = <T>(value: Facts<T>): Map<number, TokenKind> => {
  const cached = refinedCache.get(value);
  if (cached !== undefined) return cached;
  const byId = new Map<number, DefinitionKind>();
  for (const definition of value.definitions) byId.set(definition.id, definition.kind);
  const exact = new Map<number, TokenKind>();
  for (const definition of local(value)) exact.set(definition.span.start, definition.kind);
  for (const reference of value.references) {
    const kind = byId.get(reference.id);
    if (kind !== undefined) exact.set(reference.span.start, kind);
  }
  refinedCache.set(value, exact);
  return exact;
};

/** LSP semantic token modifiers, as bits: a token's modifier mask is the OR of the bits it has. */
export const tokenModifiers = ["declaration", "readonly"] as const;

const modifiersCache = new WeakMap<object, Map<number, number>>();

/** Modifier masks by span start: `declaration` at a local definition, `readonly` on constants and enum members. */
export const refinedModifiers = <T>(value: Facts<T>): Map<number, number> => {
  const cached = modifiersCache.get(value);
  if (cached !== undefined) return cached;
  const readonly = (kind: DefinitionKind): number => (kind === "constant" || kind === "enumMember" ? 2 : 0);
  const byId = new Map<number, DefinitionKind>();
  for (const definition of value.definitions) byId.set(definition.id, definition.kind);
  const masks = new Map<number, number>();
  for (const definition of local(value)) masks.set(definition.span.start, 1 | readonly(definition.kind));
  for (const reference of value.references) {
    const kind = byId.get(reference.id);
    const mask = kind === undefined ? 0 : readonly(kind);
    if (mask !== 0) masks.set(reference.span.start, mask);
  }
  modifiersCache.set(value, masks);
  return masks;
};

/** Refines lexical tokens with declared/referenced kinds without overlapping ranges. */
export const semanticTokens = <T>(value: Facts<T>): readonly Token[] => {
  const exact = refinedKinds(value);
  return value.tokens.map((token) => {
    const refined = exact.get(token.span.start);
    return refined === undefined || refined === token.kind ? token : { ...token, kind: refined };
  });
};
