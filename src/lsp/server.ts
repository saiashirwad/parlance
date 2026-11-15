import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CompletionItemKind,
  createConnection,
  type Diagnostic as LspDiagnostic,
  DiagnosticSeverity,
  type DocumentSymbol,
  type FoldingRange,
  type InlayHint,
  InlayHintKind,
  MarkupKind,
  PositionEncodingKind,
  CodeActionKind,
  type CodeAction,
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
  inScope,
  referenceAt,
  type Token,
  tokenKinds,
  tokenModifiers,
  typeAt,
} from "../check/index.ts";
import { type Diagnostic, diagnostic, site } from "../diagnostic.ts";
import { diff } from "../source.ts";
import type { Span } from "../source.ts";
import { analyze, extensionMap, type AnyLanguage, type CompletionKind } from "../language.ts";
import { ModuleGraph, type ModuleGraphOptions } from "../modules.ts";
import { reparse, type IncrementalStats } from "../parser/incremental.ts";
import { encodeAnalysis, folding } from "./semantic.ts";

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

const completionKind = (kind: CompletionKind | undefined): CompletionItemKind => {
  switch (kind) {
    case "type":
      return CompletionItemKind.Class;
    case "function":
      return CompletionItemKind.Function;
    case "property":
      return CompletionItemKind.Property;
    case "enumMember":
      return CompletionItemKind.EnumMember;
    case "variable":
      return CompletionItemKind.Variable;
    case "constant":
      return CompletionItemKind.Constant;
    case "keyword":
    case undefined:
      return CompletionItemKind.Keyword;
  }
};

const range = (document: TextDocument, span: Span): Range => ({
  start: document.positionAt(span.start),
  end: document.positionAt(span.end),
});

const lspDiagnostic = (document: TextDocument, entry: Diagnostic): LspDiagnostic | undefined => {
  const location = site(entry, document.uri);
  if (location.uri !== document.uri) return undefined;
  return {
    range: range(document, location.span),
    severity: entry.severity === "error"
      ? DiagnosticSeverity.Error
      : entry.severity === "warning"
      ? DiagnosticSeverity.Warning
      : DiagnosticSeverity.Information,
    source: "parlance",
    message: entry.context?.length ? `${entry.message}\n${entry.context.join(" > ")}` : entry.message,
  };
};

export type ServerOptions = {
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
};

export const serve = (languages: readonly AnyLanguage[], options: Pick<ModuleGraphOptions, "resolve"> = {}): void => {
  const registry = extensionMap(languages);
  const connection = createConnection(process.stdin, process.stdout);
  const documents = new TextDocuments(TextDocument);
  const analyses = new Map<string, ReturnType<ModuleGraph["analyze"]>>();
  /** The last full token array sent per document, for `semanticTokens/full/delta`. */
  const encoded = new Map<string, { readonly analysis: object; readonly resultId: string; readonly data: number[]; }>();
  let resultCounter = 0;
  const graph = new ModuleGraph({
    languages,
    ...options,
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
      completionProvider: { triggerCharacters: ["@"] },
      codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
      inlayHintProvider: true,
      workspaceSymbolProvider: true,
      renameProvider: true,
      semanticTokensProvider: {
        legend: { tokenTypes: [...tokenKinds], tokenModifiers: [...tokenModifiers] },
        full: { delta: true },
        range: true,
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
    void connection.sendDiagnostics({
      uri: document.uri,
      version: document.version,
      diagnostics: analysis.diagnostics.flatMap((entry) => {
        const item = lspDiagnostic(document, entry);
        return item === undefined ? [] : [item];
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
    // The graph may still hold the closed buffer's content. Drop it and
    // re-analyze open importers against the disk source (or a missing file).
    graph.forget(document.uri);
    refreshOpenDependents(document.uri);
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

  connection.onWorkspaceSymbol(({ query }) => {
    const needle = query.toLowerCase();
    const found: SymbolInformation[] = [];
    for (const uri of graph.watched()) {
      const node = graph.node(uri);
      const target = node && documentAt(uri);
      if (!node || !target) continue;
      for (const definition of node.analysis.facts.definitions) {
        if (definition.uri !== undefined && definition.uri !== uri) continue;
        if (definition.kind === "parameter" || definition.kind === "typeParameter") continue;
        if (needle && !definition.name.toLowerCase().includes(needle)) continue;
        found.push({
          name: definition.name,
          kind: symbolKind(definition),
          location: { uri, range: range(target, definition.span) },
          ...(definition.detail ? { containerName: definition.detail } : {}),
        });
        if (found.length >= 200) return found;
      }
    }
    return found;
  });

  connection.onCodeAction(({ textDocument, range: wanted }) => {
    const document = documents.get(textDocument.uri);
    const analysis = analysisFor(textDocument.uri);
    if (!document || !analysis) return [];
    const from = document.offsetAt(wanted.start);
    const to = document.offsetAt(wanted.end);
    const actions: CodeAction[] = [];
    for (const entry of analysis.diagnostics) {
      const { fix } = entry;
      const item = fix && lspDiagnostic(document, entry);
      if (!fix || !item) continue;
      const span = site(entry, document.uri).span;
      if (span.end < from || span.start > to) continue;
      actions.push({
        title: fix.title,
        kind: CodeActionKind.QuickFix,
        diagnostics: [item],
        edit: {
          changes: { [document.uri]: fix.edits.map((edit) => ({ range: range(document, edit.span), newText: edit.newText })) },
        },
      });
    }
    return actions;
  });

  connection.onFoldingRanges(({ textDocument }) => {
    const document = documents.get(textDocument.uri);
    const analysis = analysisFor(textDocument.uri);
    const language = languageFor(textDocument.uri);
    if (!document || !analysis || !language) return [];
    return folding(analysis.lex, document, language.grammar.spec);
  });

  connection.onCompletion(({ textDocument, position }) => {
    const document = documents.get(textDocument.uri);
    const analysis = analysisFor(textDocument.uri);
    const language = languageFor(textDocument.uri);
    if (!document || !analysis || !language) return [];
    const items: {
      label: string;
      kind: CompletionItemKind;
      detail?: string;
      insertText?: string;
      filterText?: string;
      sortText?: string;
    }[] = [];
    const offset = document.offsetAt(position);
    for (const keyword of language.grammar.spec.keywords) {
      items.push({ label: keyword, kind: CompletionItemKind.Keyword, detail: "keyword" });
    }
    for (const completion of language.completions ?? []) {
      items.push({
        label: completion.label,
        kind: completionKind(completion.kind),
        ...(completion.detail === undefined ? {} : { detail: completion.detail }),
        ...(completion.insertText === undefined ? {} : { insertText: completion.insertText }),
        ...(completion.filterText === undefined ? {} : { filterText: completion.filterText }),
      });
    }
    for (const definition of inScope(analysis.facts, offset)) {
      items.push({
        // Names declared before the cursor sort first.
        sortText: `${definition.span.start < offset ? 0 : 1}${definition.name}`,
        label: definition.name,
        kind: definition.kind === "function" || definition.kind === "method"
          ? CompletionItemKind.Function
          : definition.kind === "type"
          ? CompletionItemKind.Interface
          : CompletionItemKind.Variable,
        ...(definition.type === undefined || !language.show ? {} : { detail: language.show(definition.type) }),
      });
    }
    const seen = new Set<string>();
    const unique = items.filter((item) => {
      if (seen.has(item.label)) return false;
      seen.add(item.label);
      return true;
    });
    const linePrefix = document.getText().slice(Math.max(0, offset - 64), offset);
    if (/@[A-Za-z0-9_]*$/.test(linePrefix)) return unique.filter((item) => item.label.startsWith("@"));
    return unique;
  });

  /** Types of variable and constant bindings, from the facts hover uses. Needs `language.show`. */
  connection.languages.inlayHint.on(({ textDocument, range: wanted }) => {
    const document = documents.get(textDocument.uri);
    const analysis = analysisFor(textDocument.uri);
    const language = languageFor(textDocument.uri);
    if (!document || !analysis || !language?.show || language.inlayHints === false) return [];
    const text = document.getText();
    const from = document.offsetAt(wanted.start);
    const to = document.offsetAt(wanted.end);
    const hints: InlayHint[] = [];
    for (const definition of analysis.facts.definitions) {
      if (definition.uri !== undefined && definition.uri !== document.uri) continue;
      if (definition.kind !== "variable" && definition.kind !== "constant") continue;
      if (definition.type === undefined || definition.span.end < from || definition.span.end > to) continue;
      // Skip bindings the author already annotated: `name: Type`.
      if (/^\s*:/.test(text.slice(definition.span.end, definition.span.end + 16))) continue;
      hints.push({
        position: document.positionAt(definition.span.end),
        label: `: ${language.show(definition.type)}`,
        kind: InlayHintKind.Type,
      });
    }
    return hints;
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

  /** The full token array for the current analysis; the previous one stays reachable for deltas. */
  const tokensFor = (document: TextDocument, analysis: NonNullable<ReturnType<typeof analysisFor>>) => {
    const cached = encoded.get(document.uri);
    if (cached?.analysis === analysis) return cached;
    const entry = { analysis, resultId: String(++resultCounter), data: encodeAnalysis(document, analysis) };
    encoded.set(document.uri, entry);
    return entry;
  };

  connection.languages.semanticTokens.on(({ textDocument }) => {
    const document = documents.get(textDocument.uri);
    const analysis = analysisFor(textDocument.uri);
    if (!document || !analysis) return { data: [] };
    const { resultId, data } = tokensFor(document, analysis);
    return { resultId, data };
  });

  connection.languages.semanticTokens.onDelta(({ textDocument, previousResultId }) => {
    const document = documents.get(textDocument.uri);
    const analysis = analysisFor(textDocument.uri);
    if (!document || !analysis) return { edits: [] };
    const previous = encoded.get(textDocument.uri);
    const current = tokensFor(document, analysis);
    if (previous === undefined || previous.resultId !== previousResultId) {
      return { resultId: current.resultId, data: current.data };
    }
    // One edit replacing the span between the common prefix and suffix.
    const before = previous.data;
    const after = current.data;
    let head = 0;
    while (head < before.length && head < after.length && before[head] === after[head]) head++;
    let tail = 0;
    while (tail < before.length - head && tail < after.length - head
      && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
    const deleteCount = before.length - head - tail;
    const data = after.slice(head, after.length - tail);
    return {
      resultId: current.resultId,
      edits: deleteCount === 0 && data.length === 0 ? [] : [{ start: head, deleteCount, data }],
    };
  });

  connection.languages.semanticTokens.onRange(({ textDocument, range: wanted }) => {
    const document = documents.get(textDocument.uri);
    const analysis = analysisFor(textDocument.uri);
    if (!document || !analysis) return { data: [] };
    return {
      data: encodeAnalysis(document, analysis, { start: document.offsetAt(wanted.start), end: document.offsetAt(wanted.end) }),
    };
  });

  documents.listen(connection);
  connection.listen();
};

export const serveLanguage = (language: AnyLanguage): void => serve([language]);
