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
import { diff } from "../source.ts";
import type { Span } from "../source.ts";
import { analyze, extensionMap, type AnyLanguage } from "../language.ts";
import { ModuleGraph } from "../modules.ts";
import { reparse, type IncrementalStats } from "../parser/incremental.ts";
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
  const analyses = new Map<string, ReturnType<ModuleGraph["analyze"]>>();
  const encoded = new Map<string, number[]>();
  const graph = new ModuleGraph({
    languages,
    read: (uri) => {
      const open = documents.get(uri);
      if (open) return open.getText();
      if (!uri.startsWith("file:")) return null;
      try {
        return readFileSync(fileURLToPath(uri), "utf8");
      } catch {
        return null;
      }
    },
  });

  const languageFor = (uri: string): AnyLanguage | undefined => {
    const path = uri.startsWith("file:") ? fileURLToPath(uri) : uri;
    for (const [extension, language] of registry) if (path.endsWith(extension)) return language;
    return undefined;
  };

  const documentAt = (uri: string): TextDocument | undefined => {
    const open = documents.get(uri);
    if (open) return open;
    const source = graph.source(uri);
    return source === undefined ? undefined : TextDocument.create(uri, "guest", 0, source);
  };

  /** References to the same definition across every analyzed document. */
  const referencesTo = (target: Definition, currentUri: string): { uri: string; span: Span; }[] => {
    const targetUri = target.uri ?? currentUri;
    const found: { uri: string; span: Span; }[] = [];
    for (const uri of graph.watched()) {
      const node = graph.node(uri);
      if (!node) continue;
      const definitions = new Map(node.analysis.facts.definitions.map((definition) => [definition.id, definition]));
      for (const reference of node.analysis.facts.references) {
        const definition = definitions.get(reference.id);
        if (!definition) continue;
        const definitionUri = definition.uri ?? uri;
        if (definitionUri !== targetUri) continue;
        if (definition.span.start !== target.span.start || definition.span.end !== target.span.end) continue;
        found.push({ uri, span: reference.span });
      }
    }
    return found;
  };

  const uniqueSpans = (spans: readonly Span[]): Span[] => {
    const seen = new Set<string>();
    return spans.filter((span) => {
      const key = `${span.start}:${span.end}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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

  const update = (document: TextDocument, force = false): void => {
    const language = languageFor(document.uri);
    if (!language) return;
    const previous = analyses.get(document.uri);
    const text = document.getText();
    const edit = previous ? diff(previous.source, text) : null;
    if (previous && edit === null && !force) return;
    let analysis: ReturnType<typeof analyze>;
    try {
      if (previous && edit) {
        const parsed = previous.language.grammar.spec.incremental
          ? reparse(previous.language.grammar.spec, previous.parse, text, edit, { previousSource: previous.source, mutate: true })
          : previous.language.grammar.parse(text);
        const stats = "stats" in parsed ? parsed.stats as IncrementalStats : null;
        analysis = graph.analyze(document.uri, { source: text, parsed, incremental: stats });
      } else {
        analysis = graph.analyze(document.uri, { source: text });
      }
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

  /** Refresh open documents whose graph node was invalidated by another edit. */
  const refreshOpenDependents = (changed: string): void => {
    for (let pass = 0; pass <= documents.all().length; pass++) {
      let updated = false;
      for (const document of documents.all()) {
        if (document.uri === changed) continue;
        const stored = analyses.get(document.uri);
        if (stored === undefined) continue;
        if (graph.node(document.uri)?.analysis === stored) continue;
        update(document, true);
        updated = true;
      }
      if (!updated) return;
    }
  };

  documents.onDidChangeContent(({ document }) => {
    update(document);
    refreshOpenDependents(document.uri);
  });
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
    if (!definition) return null;
    const target = definition.uri ?? document.uri;
    if (target !== document.uri) {
      const other = documentAt(target);
      return other ? { uri: target, range: range(other, definition.span) } : null;
    }
    return { uri: document.uri, range: range(document, definition.span) };
  });

  connection.onReferences(({ textDocument, position, context }) => {
    const document = documents.get(textDocument.uri);
    const analysis = analysisFor(textDocument.uri);
    if (!document || !analysis) return [];
    const definition = definitionAt(analysis.facts, document.offsetAt(position));
    if (!definition) return [];
    const targetUri = definition.uri ?? document.uri;
    const locations: { uri: string; range: Range; }[] = [];
    if (context.includeDeclaration) {
      const target = documentAt(targetUri);
      if (target) locations.push({ uri: targetUri, range: range(target, definition.span) });
    }
    for (const reference of referencesTo(definition, document.uri)) {
      const target = documentAt(reference.uri);
      if (target) locations.push({ uri: reference.uri, range: range(target, reference.span) });
    }
    const seen = new Set<string>();
    return locations.filter((location) => {
      const key = `${location.uri}:${location.range.start.line}:${location.range.start.character}:${location.range.end.line}:${location.range.end.character}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

  connection.onDocumentSymbol(({ textDocument }) => {
    const document = documents.get(textDocument.uri);
    const analysis = analysisFor(textDocument.uri);
    if (!document || !analysis) return [];
    return analysis.facts.definitions
      .filter((definition) => definition.uri === undefined || definition.uri === document.uri)
      .map((definition): SymbolInformation => ({
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
    const targetUri = definition.uri ?? document.uri;
    const byUri = new Map<string, Span[]>();
    const add = (uri: string, span: Span) => {
      const spans = byUri.get(uri);
      if (spans) spans.push(span);
      else byUri.set(uri, [span]);
    };
    add(targetUri, definition.span);
    for (const reference of referencesTo(definition, document.uri)) add(reference.uri, reference.span);
    const changes: NonNullable<WorkspaceEdit["changes"]> = {};
    for (const [uri, spans] of byUri) {
      const target = documentAt(uri);
      if (!target) continue;
      changes[uri] = uniqueSpans(spans).map((span) => ({ range: range(target, span), newText: newName }));
    }
    return { changes };
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
