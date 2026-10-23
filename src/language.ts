import { type Binding, Checker, type Facts, semanticTokens, type Token } from "./check/index.ts";
import { type Diagnostic, sortDiagnostics } from "./diagnostic.ts";
import type { CompiledGrammar } from "./grammar/compile.ts";
import type { LexToken, Trivia } from "./parser/spec.ts";
import type { TsDoc } from "./ts/index.ts";

export type Artifact = {
  readonly text: string;
  readonly fileName?: string;
};

export type Language<Ast = unknown, Ir = unknown, Type = unknown> = {
  readonly name: string;
  readonly extensions: readonly `.${string}`[];
  readonly grammar: CompiledGrammar<Ast>;
  /** Elaborates a parsed file into checked IR. Errors go through `cx`. */
  readonly check: (file: Ast, cx: Checker<Type>) => Ir;
  /** TypeScript surface, with source mappings where identifiers correspond to guest text. */
  readonly typescript?: (module: Ir) => TsDoc;
  /** ES module source for the Node loader. */
  readonly runtime?: (module: Ir) => string;
  /** Additional emit targets, keyed by name. */
  readonly targets?: Readonly<Record<string, (module: Ir) => Artifact>>;
  /** Hover rendering for a type. */
  readonly show?: (type: Type) => string;
  /** Optional hover text for a definition, before falling back to `show(type)`. */
  readonly describe?: (binding: Binding<Type>) => string | undefined;
  /** Check a tree that has parse errors. Defaults to true so editor facts survive typing. */
  readonly checkPartial?: boolean;
};

export type LanguageOptions<Ast, Ir, Type> = Omit<Language<Ast, Ir, Type>, "checkPartial"> & {
  readonly checkPartial?: boolean;
};

export const defineLanguage = <Ast, Ir, Type = unknown>(
  language: LanguageOptions<Ast, Ir, Type>,
): Language<Ast, Ir, Type> => language;

export type Analysis<Ast = unknown, Ir = unknown, Type = unknown> = {
  readonly language: Language<Ast, Ir, Type>;
  readonly uri: string;
  readonly source: string;
  readonly tree: Ast | null;
  readonly ir: Ir | null;
  readonly tokens: readonly Token[];
  readonly lex: readonly LexToken[];
  readonly trivia: readonly Trivia[];
  readonly diagnostics: readonly Diagnostic[];
  readonly facts: Facts<Type>;
  readonly valid: boolean;
};

const internal = (message: string): Diagnostic => ({
  message,
  severity: "error",
  span: { start: 0, end: 0 },
  code: "internal",
});

/** Parse, check, and collect every fact the editor and hosts need. Never throws on guest input. */
export const analyze = <Ast, Ir, Type>(
  language: Language<Ast, Ir, Type>,
  source: string,
  uri = "memory://input",
): Analysis<Ast, Ir, Type> => {
  const parsed = language.grammar.parse(source);
  const lexical = language.grammar.highlight(source);
  const checker = new Checker<Type>(uri, source, lexical, parsed.diagnostics);
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
  const diagnostics = sortDiagnostics(checker.facts.diagnostics);
  const facts: Facts<Type> = {
    ...checker.facts,
    diagnostics: [...diagnostics],
    tokens: [...semanticTokens({ ...checker.facts, diagnostics: [...diagnostics] })],
  };
  return {
    language,
    uri,
    source,
    tree: parsed.value as Ast | null,
    ir,
    tokens: facts.tokens,
    lex: parsed.tokens,
    trivia: parsed.trivia,
    diagnostics,
    facts,
    valid: diagnostics.every((entry) => entry.severity !== "error"),
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
