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
import { type Analysis, analyze, extensionMap, type AnyLanguage, type CompletionKind } from "../language.ts";
import { ModuleGraph, type ModuleGraphOptions } from "../modules.ts";
import { reparse, type IncrementalStats } from "../parser/incremental.ts";
import {
  analyzeSnippet,
  duplicateKeys,
  embedTags,
  findSnippets,
  type HostDiagnostic,
  hostSpan,
  isHostFile,
  isSnippetUri,
  type Snippet,
  snippetDiagnostics,
  snippetSignature,
  stubsFor,
  toSnippet,
  touchStamp,
} from "../ts/embed.ts";
import { encodeAnalysis, encodeEmbedded, folding } from "./semantic.ts";

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

const severity = (entry: { readonly severity: Diagnostic["severity"] }): DiagnosticSeverity =>
  entry.severity === "error"
    ? DiagnosticSeverity.Error
    : entry.severity === "warning"
    ? DiagnosticSeverity.Warning
    : DiagnosticSeverity.Information;

const lspDiagnostic = (document: TextDocument, entry: Diagnostic): LspDiagnostic | undefined => {
  const location = site(entry, document.uri);
  if (location.uri !== document.uri) return undefined;
  return {
    range: range(document, location.span),
    severity: severity(entry),
    source: "parlance",
    message: entry.context?.length ? `${entry.message}\n${entry.context.join(" > ")}` : entry.message,
  };
};

/** A snippet in an open TypeScript buffer and its current analysis. */
type Region = { readonly snippet: Snippet; readonly analysis: Analysis };

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
  const tags = embedTags(languages);
  /** Snippets in open TypeScript buffers, in document order. */
  const embedded = new Map<string, readonly Region[]>();
  /** The snippets each open TypeScript file has on disk, as of open or the last save. */
  const saved = new Map<string, string>();
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
      if (!node || isSnippetUri(uri)) continue;
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
      textDocumentSync: { openClose: true, change: TextDocumentSyncKind.Incremental, save: true },
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

  /** Finds and analyzes the snippets in a TypeScript buffer, and publishes their diagnostics. */
  const updateEmbedded = (document: TextDocument): void => {
    if (tags.size === 0 || !document.uri.startsWith("file:") || !isHostFile(fileURLToPath(document.uri))) return;
    const previous = embedded.get(document.uri) ?? [];
    const snippets = findSnippets(document.getText(), document.uri, tags);
    const regions = snippets.map((snippet): Region => {
      try {
        return { snippet, analysis: analyzeSnippet(graph, snippet) };
      } catch (cause) {
        const failed = analyze(snippet.language, "", snippet.uri);
        return { snippet, analysis: { ...failed, diagnostics: [diagnostic(`Internal analysis error: ${String(cause)}`, { start: 0, end: 0 })] } };
      }
    });
    const kept = new Set(snippets.map((snippet) => snippet.uri));
    for (const old of previous) if (!kept.has(old.snippet.uri)) graph.forget(old.snippet.uri);
    if (!saved.has(document.uri)) saved.set(document.uri, snippetSignature(snippets));
    if (regions.length === 0 && previous.length === 0) return;
    embedded.set(document.uri, regions);
    const problems: HostDiagnostic[] = [
      ...duplicateKeys(snippets),
      ...regions.flatMap(({ snippet, analysis }) => snippetDiagnostics(snippet, analysis)),
    ];
    void connection.sendDiagnostics({
      uri: document.uri,
      version: document.version,
      diagnostics: problems.map((entry) => ({
        range: range(document, entry.span),
        severity: severity(entry),
        source: "parlance",
        message: entry.source?.context?.length ? `${entry.message}\n${entry.source.context.join(" > ")}` : entry.message,
      })),
    });
  };

  /** The snippet under a position in a TypeScript buffer, with the position in snippet offsets. */
  const regionAt = (uri: string, position: { line: number; character: number }) => {
    const document = documents.get(uri);
    const regions = embedded.get(uri);
    if (!document || !regions) return undefined;
    const host = document.offsetAt(position);
    for (const region of regions) {
      const local = toSnippet(region.snippet, host);
      if (local !== undefined) {
        const rangeOf = (span: Span): Range => range(document, hostSpan(region.snippet, span));
        return { document, region, local, rangeOf };
      }
    }
    return undefined;
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
      for (const [uri, regions] of embedded) {
        const document = documents.get(uri);
        if (!document || regions.every((region) => graph.node(region.snippet.uri)?.analysis === region.analysis)) continue;
        updateEmbedded(document);
        updated = true;
      }
      if (!updated) return;
    }
  };

  documents.onDidChangeContent(({ document }) => {
    update(document);
    updateEmbedded(document);
    refreshOpenDependents(document.uri);
  });
  // tsgo does not reload types for a file open in the editor; a stamp file tells it to.
  documents.onDidSave(({ document }) => {
    const before = saved.get(document.uri);
    if (before === undefined) return;
    const after = snippetSignature((embedded.get(document.uri) ?? []).map((region) => region.snippet));
    if (after === before) return;
    saved.set(document.uri, after);
    for (const stub of stubsFor(fileURLToPath(document.uri))) touchStamp(stub);
  });
  documents.onDidClose(({ document }) => {
    saved.delete(document.uri);
    for (const region of embedded.get(document.uri) ?? []) graph.forget(region.snippet.uri);
    embedded.delete(document.uri);
    analyses.delete(document.uri);
    encoded.delete(document.uri);
    // The graph may still hold the closed buffer's content. Drop it and
    // re-analyze open importers against the disk source (or a missing file).
    graph.forget(document.uri);
    refreshOpenDependents(document.uri);
    void connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
  });

  connection.onHover(({ textDocument, position }) => {
    const inside = regionAt(textDocument.uri, position);
    if (inside) {
      const found = hoverAt(inside.region.analysis, inside.region.snippet.language, inside.local);
      return found && { contents: { kind: MarkupKind.Markdown, value: found.text }, range: inside.rangeOf(found.span) };
    }
    const document = documents.get(textDocument.uri);
    const analysis = analysisFor(textDocument.uri);
    const language = languageFor(textDocument.uri);
    if (!document || !analysis || !language) return null;
    const found = hoverAt(analysis, language, document.offsetAt(position));
    return found && { contents: { kind: MarkupKind.Markdown, value: found.text }, range: range(document, found.span) };
  });

  /** Hover text and the span it describes, from the facts at one offset. */
  const hoverAt = (analysis: Analysis, language: AnyLanguage, offset: number): { text: string; span: Span } | null => {
    const typed = typeAt(analysis.facts, offset);
    const definition = typed ? undefined : definitionAt(analysis.facts, offset);
    const type = typed?.type ?? definition?.type;
    if (type === undefined && !definition) return null;
    const described = definition && language.describe ? language.describe(definition) : undefined;
    const text = described
      ?? (type !== undefined && language.show ? language.show(type) : type === undefined ? undefined : String(type));
    if (text === undefined) return null;
    const span = typed?.span ?? referenceAt(analysis.facts, offset)?.span ?? definition?.span;
    return span ? { text, span } : null;
  };

  connection.onDefinition(({ textDocument, position }) => {
    const inside = regionAt(textDocument.uri, position);
    if (inside) {
      const definition = definitionAt(inside.region.analysis.facts, inside.local);
      const target = definition?.uri ?? inside.region.snippet.uri;
      if (!definition) return null;
      if (target === inside.region.snippet.uri) return { uri: textDocument.uri, range: inside.rangeOf(definition.span) };
      const other = isSnippetUri(target) ? undefined : documentAt(target);
      return other ? { uri: target, range: range(other, definition.span) } : null;
    }
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
      const target = node && !isSnippetUri(uri) && documentAt(uri);
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
    const inside = regionAt(textDocument.uri, position);
    if (inside) return completionsAt(inside.region.analysis, inside.region.snippet.language, inside.local, inside.region.snippet.text);
    const document = documents.get(textDocument.uri);
    const analysis = analysisFor(textDocument.uri);
    const language = languageFor(textDocument.uri);
    if (!document || !analysis || !language) return [];
    return completionsAt(analysis, language, document.offsetAt(position), document.getText());
  });

  const completionsAt = (analysis: Analysis, language: AnyLanguage, offset: number, text: string) => {
    const items: {
      label: string;
      kind: CompletionItemKind;
      detail?: string;
      insertText?: string;
      filterText?: string;
      sortText?: string;
    }[] = [];
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
    const linePrefix = text.slice(Math.max(0, offset - 64), offset);
    if (/@[A-Za-z0-9_]*$/.test(linePrefix)) return unique.filter((item) => item.label.startsWith("@"));
    return unique;
  };

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

  /** Tokens for the snippets in a TypeScript buffer; nothing outside them. */
  const embeddedTokens = (uri: string, within?: Span): number[] | undefined => {
    const document = documents.get(uri);
    const regions = embedded.get(uri);
    if (!document || !regions) return undefined;
    return encodeEmbedded(
      document,
      regions.map(({ snippet, analysis }) => ({ analysis, map: (start: number, end: number) => hostSpan(snippet, { start, end }) })),
      within,
    );
  };

  connection.languages.semanticTokens.on(({ textDocument }) => {
    const tokens = embeddedTokens(textDocument.uri);
    if (tokens) return { resultId: String(++resultCounter), data: tokens };
    const document = documents.get(textDocument.uri);
    const analysis = analysisFor(textDocument.uri);
    if (!document || !analysis) return { data: [] };
    const { resultId, data } = tokensFor(document, analysis);
    return { resultId, data };
  });

  connection.languages.semanticTokens.onDelta(({ textDocument, previousResultId }) => {
    const tokens = embeddedTokens(textDocument.uri);
    if (tokens) return { resultId: String(++resultCounter), data: tokens };
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
    const host = documents.get(textDocument.uri);
    const tokens = host && embeddedTokens(textDocument.uri, { start: host.offsetAt(wanted.start), end: host.offsetAt(wanted.end) });
    if (tokens) return { data: tokens };
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