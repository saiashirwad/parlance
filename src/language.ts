import {
  type Binding,
  boundImports,
  Checker,
  type DefinitionKind,
  type Dependency,
  type Facts,
  type ForeignSource,
  semanticTokens,
  type Token,
} from "./check/index.ts";
import { type Diagnostic, sortDiagnostics } from "./diagnostic.ts";
import type { CompiledGrammar } from "./grammar/compile.ts";
import type { IncrementalStats } from "./parser/incremental.ts";
import type { ParseResult } from "./parser/parse.ts";
import type { TokenList, TriviaList } from "./parser/tokens.ts";
import type { Span } from "./source.ts";
import type { TsDoc } from "./ts/index.ts";

/** One import declaration, resolved by the module graph. `span` covers the specifier text. */
export type Import = { readonly specifier: string; readonly span: Span };

/** A quoted guest string literal as an import. The span excludes the quotes. */
export const importSpecifier = (literal: { readonly text: string; readonly span: Span }): Import => {
  const quoted = literal.text.length >= 2 && literal.text.startsWith("\"") && literal.text.endsWith("\"");
  if (!quoted) return { specifier: literal.text, span: literal.span };
  let value = literal.text.slice(1, -1);
  try {
    value = JSON.parse(literal.text);
  } catch {
    // Keep the unescaped text; the graph will report a missing file.
  }
  return { specifier: value, span: { start: literal.span.start + 1, end: literal.span.end - 1 } };
};

/** True for a package specifier (`left-pad`, `@scope/pkg/x`), false for a relative path, absolute path, or URL. */
export const isBareSpecifier = (specifier: string): boolean => !/^(\.{0,2}\/|[A-Za-z][A-Za-z0-9+.-]*:)/.test(specifier);

/** A guest import of names from a non-guest module, such as a `.ts` file or a package. */
export type ForeignImport = {
  readonly specifier: Import;
  /** The imported names and where each is written in the guest file. */
  readonly names: readonly { readonly name: string; readonly span: Span }[];
};

export type Artifact = {
  readonly text: string;
  readonly fileName?: string;
};

export type CompletionKind =
  | "keyword"
  | "type"
  | "variable"
  | "function"
  | "property"
  | "enumMember"
  | "constant";

/** A language-owned completion item, for words the grammar does not lex as keywords. */
export type Completion = {
  readonly label: string;
  readonly kind?: CompletionKind;
  readonly detail?: string;
  readonly insertText?: string;
  readonly filterText?: string;
};

export type Language<Ast = unknown, Ir = unknown, Type = unknown> = {
  readonly name: string;
  readonly extensions: readonly `.${string}`[];
  readonly grammar: CompiledGrammar<Ast>;
  /** Elaborates a parsed file into checked IR. Errors go through `cx`. */
  readonly check: (file: Ast, cx: Checker<Type>) => Ir;
  /** Declares the file's imports. The module graph parses, resolves, and analyzes them. */
  readonly imports?: (file: Ast) => readonly Import[];
  /**
   * Declares names imported from non-guest modules. The graph resolves each specifier (a missing
   * file or unknown package is reported at the specifier) and the checker declares the names with
   * `cx.foreign(type)`. `foreignImports` and `foreignRuntime` from `parlance/ts` emit them.
   */
  readonly foreign?: (file: Ast) => readonly ForeignImport[];
  /** The bindings this module exposes to importers. */
  readonly exports?: (module: Ir) => readonly Binding<Type>[];
  /** TypeScript surface, with source mappings where identifiers correspond to guest text. */
  readonly typescript?: (module: Ir) => TsDoc;
  /**
   * ES module source for the Node loader. A `TsDoc` carries mappings to guest spans; the loader turns
   * them into an inline source map so `node --enable-source-maps` shows guest positions in stacks.
   */
  readonly runtime?: (module: Ir) => string | TsDoc;
  /** Additional emit targets, keyed by name. */
  readonly targets?: Readonly<Record<string, (module: Ir) => Artifact>>;
  /** Hover rendering for a type. */
  readonly show?: (type: Type) => string;
  /** Extra completion items beyond grammar keywords and check facts. */
  readonly completions?: readonly Completion[];
  /** Optional hover text for a definition, before falling back to `show(type)`. */
  readonly describe?: (binding: Binding<Type>) => string | undefined;
  /** Show binding types as inlay hints (needs `show`). Defaults to true. */
  readonly inlayHints?: boolean;
  /** Check a tree that has parse errors. Defaults to true so editor facts survive typing. */
  readonly checkPartial?: boolean;
};

export type AnyLanguage = Language<any, any, any>;

export type LanguageOptions<Ast, Ir, Type> = Omit<Language<Ast, Ir, Type>, "checkPartial"> & {
  readonly checkPartial?: boolean;
};

const completionOf = (kind: DefinitionKind): CompletionKind => {
  switch (kind) {
    case "function":
    case "method":
    case "macro":
      return "function";
    case "variable":
    case "parameter":
      return "variable";
    case "property":
    case "enumMember":
      return kind;
    case "constant":
    case "namespace":
    case "event":
      return "constant";
    default:
      return "type";
  }
};

/**
 * A grammar's `bind` block supplies defaults: `import` lines become `imports` and `builtin` names
 * become completions. An explicit `imports` wins; explicit completions come first.
 */
export const defineLanguage = <Ast, Ir, Type = unknown>(
  language: LanguageOptions<Ast, Ir, Type>,
): Language<Ast, Ir, Type> => {
  const spec = language.grammar.bind;
  if (!spec) return language;
  const explicit = new Set((language.completions ?? []).map((completion) => completion.label));
  const builtins = spec.builtins.filter((entry) => !explicit.has(entry.name)).map((entry): Completion => ({
    label: entry.name,
    kind: completionOf(entry.kind),
    detail: entry.label,
  }));
  return {
    ...language,
    ...(language.imports !== undefined || spec.imports.length === 0
      ? {}
      : { imports: (file: Ast) => boundImports(file, spec).map(importSpecifier) }),
    ...(builtins.length === 0 ? {} : { completions: [...(language.completions ?? []), ...builtins] }),
  };
};

export type Analysis<Ast = unknown, Ir = unknown, Type = unknown> = {
  readonly language: Language<Ast, Ir, Type>;
  readonly uri: string;
  readonly source: string;
  readonly tree: Ast | null;
  readonly ir: Ir | null;
  readonly tokens: readonly Token[];
  readonly lex: TokenList;
  readonly trivia: TriviaList;
  readonly diagnostics: readonly Diagnostic[];
  readonly facts: Facts<Type>;
  readonly valid: boolean;
  readonly parse: ParseResult<Ast>;
  readonly incremental: IncrementalStats | null;
};

/** Extra analysis input supplied by the module graph. */
export type AnalysisContext<Type = unknown> = {
  /** Resolved direct dependencies, in import order. */
  readonly dependencies?: readonly Dependency<Type>[];
  /** Diagnostics produced before checking, such as unresolved imports or cycles. */
  readonly diagnostics?: readonly Diagnostic[];
  /** Resolved non-guest imports, for `Checker.foreign`. */
  readonly foreign?: readonly ForeignSource[];
};

/** Parse, check, and collect every fact the editor and hosts need. Never throws on guest input. */
export const analyze = <Ast, Ir, Type>(
  language: Language<Ast, Ir, Type>,
  source: string,
  uri = "memory://input",
  context: AnalysisContext<Type> = {},
): Analysis<Ast, Ir, Type> =>
  analyzeParsed(language, source, uri, language.grammar.parse(source), null, context);

/** Analyze an already parsed file. The LSP uses this after an incremental reparse. */
export const analyzeParsed = <Ast, Ir, Type>(
  language: Language<Ast, Ir, Type>,
  source: string,
  uri: string,
  parsed: ParseResult<Ast>,
  incremental: IncrementalStats | null = null,
  context: AnalysisContext<Type> = {},
): Analysis<Ast, Ir, Type> => {
  const checker = new Checker<Type>(
    uri,
    source,
    [],
    [...parsed.diagnostics, ...(context.diagnostics ?? [])],
    context.dependencies ?? [],
    context.foreign ?? [],
  );
  let ir: Ir | null = null;
  if (parsed.value !== null && (parsed.ok || language.checkPartial !== false)) {
    try {
      ir = checker.check(() => language.check(parsed.value as Ast, checker)) ?? null;
    } catch (cause) {
      checker.error(`Internal analysis error: ${cause instanceof Error ? cause.message : String(cause)}`, {
        start: 0,
        end: 0,
      });
      ir = null;
    }
  }
  checker.seal();
  const diagnostics = sortDiagnostics(checker.facts.diagnostics);
  let tokenCache: Token[] | null = null;
  const tokens = (): Token[] => {
    if (tokenCache === null) {
      const lexical = language.grammar.highlightTokens(parsed.tokens);
      tokenCache = [...semanticTokens({ ...checker.facts, diagnostics: [...diagnostics], tokens: lexical })];
    }
    return tokenCache;
  };
  const facts: Facts<Type> = {
    ...checker.facts,
    diagnostics: [...diagnostics],
    get tokens() {
      return tokens();
    },
  };
  return {
    language,
    uri,
    source,
    tree: parsed.value as Ast | null,
    ir,
    get tokens() {
      return facts.tokens;
    },
    lex: parsed.tokens,
    trivia: parsed.trivia,
    diagnostics,
    facts,
    valid: diagnostics.every((entry) => entry.severity !== "error"),
    parse: parsed,
    incremental,
  };
};

export const extensionMap = <Ast, Ir, Type>(
  languages: readonly Language<Ast, Ir, Type>[],
): ReadonlyMap<string, Language<Ast, Ir, Type>> => {
  const map = new Map<string, Language<Ast, Ir, Type>>();
  for (const language of languages) {
    for (const extension of language.extensions) {
      if (!extension.startsWith(".")) throw new Error(`Extension ${extension} must start with a dot`);
      const existing = map.get(extension);
      if (existing) throw new Error(`${extension} is registered by both ${existing.name} and ${language.name}`);
      map.set(extension, language);
    }
  }
  return map;
};

export const languageFor = <Ast, Ir, Type>(
  languages: readonly Language<Ast, Ir, Type>[],
  fileName: string,
): Language<Ast, Ir, Type> | undefined => {
  const map = extensionMap(languages);
  for (const [extension, language] of map) {
    if (fileName.endsWith(extension)) return language;
  }
  return undefined;
};
