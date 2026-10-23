import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CompletionItemKind,
  createConnection,
  type Diagnostic as LspDiagnostic,
  DiagnosticSeverity,
  type DocumentSymbol,
  type FoldingRange,
  MarkupKind,
  PositionEncodingKind,
  type Range,
  type SymbolInformation,
  SymbolKind,
  TextDocuments,
  TextDocumentSyncKind,
  type WorkspaceEdit,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  type Definition,
  definitionAt,
  type Facts,
  referenceAt,
  type Token,
  tokenKinds,
  typeAt,
} from "../check/index.ts";
import { diagnostic, site } from "../diagnostic.ts";
import type { Span } from "../source.ts";
import { analyze, extensionMap, type AnyLanguage } from "../language.ts";
import type { LexToken } from "../parser/spec.ts";

const kindIndex = new Map(tokenKinds.map((kind, index) => [kind, index]));

const symbolKind = (definition: Definition): SymbolKind => {
  switch (definition.kind) {
    case "namespace":
      return SymbolKind.Namespace;
    case "type":
    case "typeParameter":
      return SymbolKind.TypeParameter;
    case "class":
      return SymbolKind.Class;
    case "enum":
      return SymbolKind.Enum;
    case "interface":
    case "struct":
      return SymbolKind.Interface;
    case "parameter":
      return SymbolKind.Variable;
    case "property":
      return SymbolKind.Field;
    case "enumMember":
    case "constant":
      return SymbolKind.Constant;
    case "event":
      return SymbolKind.Event;
    case "function":
      return SymbolKind.Function;
    case "method":
      return SymbolKind.Method;
    case "macro":
      return SymbolKind.Function;
    default:
      return SymbolKind.Variable;
  }
};

const range = (document: TextDocument, span: Span): Range => ({
  start: document.positionAt(span.start),
  end: document.positionAt(span.end),
});

const encodeTokens = (document: TextDocument, tokens: readonly Token[]): number[] => {
  const source = document.getText();
  const parts: { line: number; character: number; length: number; type: number; }[] = [];
  for (const token of tokens) {
    const start = Math.max(0, Math.min(source.length, token.span.start));
    const end = Math.max(start, Math.min(source.length, token.span.end));
    for (const match of source.slice(start, end).matchAll(/[^\r\n]+/g)) {
      const position = document.positionAt(start + match.index);
      parts.push({ ...position, length: match[0].length, type: kindIndex.get(token.kind) ?? 0 });
    }
  }
  parts.sort((a, b) => a.line - b.line || a.character - b.character);
  const data: number[] = [];
  let line = 0;
  let character = 0;
  let previousEnd = 0;
  for (const part of parts) {
    if (part.line === line && part.character < previousEnd) continue;
    data.push(
      part.line - line,
      part.line === line ? part.character - character : part.character,
      part.length,
      part.type,
      0,
    );
    line = part.line;
    character = part.character;
    previousEnd = character + part.length;
  }
  return data;
};

const folding = (tokens: readonly LexToken[], document: TextDocument): FoldingRange[] => {
  const stack: { text: string; span: Span; }[] = [];
  const ranges: FoldingRange[] = [];
  const pairs: Record<string, string> = { "}": "{", ")": "(", "]": "[" };
  for (const token of tokens) {
    if (token.kind !== "symbol") continue;
    if (token.text === "{" || token.text === "(" || token.text === "[") {
      stack.push({ text: token.text, span: token.span });
      continue;
    }
    const open = pairs[token.text];
    if (!open) continue;
    for (let index = stack.length - 1; index >= 0; index--) {
      if (stack[index]!.text !== open) continue;
      const found = stack.splice(index, 1)[0]!;
      const start = document.positionAt(found.span.start);
      const end = document.positionAt(token.span.end);
      if (start.line < end.line) ranges.push({ startLine: start.line, endLine: end.line });
      break;
    }
  }
  return ranges;
};

export type ServerOptions = {
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
};

export const serve = (languages: readonly AnyLanguage[]): void => {
  const registry = extensionMap(languages);
  const connection = createConnection(process.stdin, process.stdout);
  const documents = new TextDocuments(TextDocument);
  const analyses = new Map<string, ReturnType<typeof analyze>>();
  const encoded = new Map<string, number[]>();

  const languageFor = (uri: string): AnyLanguage | undefined => {
    const path = uri.startsWith("file:") ? fileURLToPath(uri) : uri;
    for (const [extension, language] of registry) if (path.endsWith(extension)) return language;
    return undefined;
  };

  connection.onInitialize(() => ({
    capabilities: {
      positionEncoding: PositionEncodingKind.UTF16,
      textDocumentSync: TextDocumentSyncKind.Incremental,
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      documentSymbolProvider: true,
      foldingRangeProvider: true,
      completionProvider: { triggerCharacters: [] },
      renameProvider: true,
      semanticTokensProvider: {
        legend: { tokenTypes: [...tokenKinds], tokenModifiers: [] },
        full: true,
      },
    },
  }));

  const update = (document: TextDocument): void => {
    const language = languageFor(document.uri);
    if (!language) return;
    let analysis: ReturnType<typeof analyze>;
    try {
      analysis = analyze(language, document.getText(), document.uri);
    } catch (cause) {
      analysis = {
        ...analyze(language, "", document.uri),
        diagnostics: [diagnostic(`Internal analysis error: ${String(cause)}`, { start: 0, end: 0 })],
      };
    }
    analyses.set(document.uri, analysis);
    encoded.delete(document.uri);
    void connection.sendDiagnostics({
      uri: document.uri,
      version: document.version,
      diagnostics: analysis.diagnostics.flatMap((entry) => {
        const location = site(entry, document.uri);
        if (location.uri !== document.uri) return [];
        const item: LspDiagnostic = {
          range: range(document, location.span),
          severity: entry.severity === "error"
            ? DiagnosticSeverity.Error
            : entry.severity === "warning"
            ? DiagnosticSeverity.Warning
            : DiagnosticSeverity.Information,
          source: "parlance",
          message: entry.context?.length ? `${entry.message}\n${entry.context.join(" > ")}` : entry.message,
        };
        return [item];
      }),
    });
  };

  const analysisFor = (uri: string): ReturnType<typeof analyze> | undefined => analyses.get(uri);

  documents.onDidChangeContent(({ document }) => update(document));
  documents.onDidClose(({ document }) => {
    analyses.delete(document.uri);
    encoded.delete(document.uri);
    void connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
  });

  connection.onHover(({ textDocument, position }) => {
    const document = documents.get(textDocument.uri);
    const analysis = analysisFor(textDocument.uri);
    const language = languageFor(textDocument.uri);
    if (!document || !analysis || !language) return null;
    const offset = document.offsetAt(position);
    const typed = typeAt(analysis.facts, offset);
    const definition = typed ? undefined : definitionAt(analysis.facts, offset);
    const type = typed?.type ?? definition?.type;
    if (type === undefined && !definition) return null;
    const described = definition && language.describe ? language.describe(definition) : undefined;
    const text = described
      ?? (type !== undefined && language.show ? language.show(type) : type === undefined ? undefined : String(type));
    if (text === undefined) return null;
    const span = typed?.span ?? referenceAt(analysis.facts, offset)?.span ?? definition?.span;
    if (!span) return null;
    return { contents: { kind: MarkupKind.Markdown, value: text }, range: range(document, span) };
  });

  connection.onDefinition(({ textDocument, position }) => {
    const document = documents.get(textDocument.uri);
    const analysis = analysisFor(textDocument.uri);
    if (!document || !analysis) return null;
    const definition = definitionAt(analysis.facts, document.offsetAt(position));
    if (!definition || (definition.uri !== undefined && definition.uri !== document.uri)) return null;
    return { uri: document.uri, range: range(document, definition.span) };
  });

  connection.onReferences(({ textDocument, position, context }) => {
    const document = documents.get(textDocument.uri);
    const analysis = analysisFor(textDocument.uri);
    if (!document || !analysis) return [];
    const definition = definitionAt(analysis.facts, document.offsetAt(position));
    if (!definition) return [];
    const locations = analysis.facts.references
      .filter((reference) => reference.id === definition.id)
      .map((reference) => ({ uri: document.uri, range: range(document, reference.span) }));
    if (context.includeDeclaration) locations.unshift({ uri: document.uri, range: range(document, definition.span) });
    return locations;
  });

  connection.onDocumentSymbol(({ textDocument }) => {
    const document = documents.get(textDocument.uri);
    const analysis = analysisFor(textDocument.uri);
    if (!document || !analysis) return [];
    return analysis.facts.definitions.map((definition): SymbolInformation => ({
      name: definition.name,
      kind: symbolKind(definition),
      location: { uri: document.uri, range: range(document, definition.span) },
      ...(definition.detail ? { containerName: definition.detail } : {}),
    }));
  });

  connection.onFoldingRanges(({ textDocument }) => {
    const document = documents.get(textDocument.uri);
    const analysis = analysisFor(textDocument.uri);
    if (!document || !analysis) return [];
    return folding(analysis.lex, document);
  });

  connection.onCompletion(({ textDocument }) => {
    const document = documents.get(textDocument.uri);
    const analysis = analysisFor(textDocument.uri);
    const language = languageFor(textDocument.uri);
    if (!document || !analysis || !language) return [];
    const keywords = [...language.grammar.spec.keywords].map((keyword) => ({
      label: keyword,
      kind: CompletionItemKind.Keyword,
      detail: "keyword",
    }));
    const definitions = analysis.facts.definitions.map((definition) => ({
      label: definition.name,
      kind: definition.kind === "function" || definition.kind === "method" ? CompletionItemKind.Function : definition.kind === "type" ? CompletionItemKind.Interface : CompletionItemKind.Variable,
      ...(definition.type === undefined || !language.show ? {} : { detail: language.show(definition.type) }),
    }));
    const seen = new Set<string>();
    return [...keywords, ...definitions].filter((item) => {
      if (seen.has(item.label)) return false;
      seen.add(item.label);
      return true;
    });
  });

  connection.onRenameRequest(({ textDocument, position, newName }) => {
    const document = documents.get(textDocument.uri);
    const analysis = analysisFor(textDocument.uri);
    if (!document || !analysis) return null;
    const definition = definitionAt(analysis.facts, document.offsetAt(position));
    if (!definition) return null;
    const spans = [
      definition.span,
      ...analysis.facts.references.filter((reference) => reference.id === definition.id).map((reference) => reference.span),
    ].filter((span, index, all) => all.findIndex((other) => other.start === span.start && other.end === span.end) === index);
    const edit: WorkspaceEdit = {
      changes: {
        [document.uri]: spans.map((span) => ({ range: range(document, span), newText: newName })),
      },
    };
    return edit;
  });

  connection.languages.semanticTokens.on(({ textDocument }) => {
    const document = documents.get(textDocument.uri);
    const analysis = analysisFor(textDocument.uri);
    if (!document || !analysis) return { data: [] };
    let data = encoded.get(textDocument.uri);
    if (!data) {
      data = encodeTokens(document, analysis.tokens);
      encoded.set(textDocument.uri, data);
    }
    return { data };
  });

  documents.listen(connection);
  connection.listen();
};

export const serveLanguage = (language: AnyLanguage): void => serve([language]);
