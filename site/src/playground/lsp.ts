/**
 * The editor side of the language server: a transport over the worker, a workspace whose files
 * are the open tabs, and the LSP features @codemirror/lsp-client leaves to the host: diagnostics
 * with quick fixes, semantic tokens, and inlay hints.
 */
import { type Action, type Diagnostic, setDiagnostics } from "@codemirror/lint";
import {
  findReferencesKeymap,
  hoverTooltips,
  jumpToDefinition,
  jumpToDefinitionKeymap,
  LSPClient,
  type LSPClientExtension,
  LSPPlugin,
  renameKeymap,
  serverCompletion,
  type Transport,
  Workspace,
  type WorkspaceFile,
} from "@codemirror/lsp-client";
import { type ChangeSet, type ChangeSpec, type Range, RangeSet, StateEffect, StateField, type Text } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import type * as lsp from "vscode-languageserver-protocol";

/** JSON-RPC over a worker's message port. The server side reads and writes plain objects. */
export const workerTransport = (worker: Worker): Transport => {
  const handlers = new Set<(message: string) => void>();
  worker.addEventListener("message", (event: MessageEvent) => {
    const message = JSON.stringify(event.data);
    for (const handler of handlers) handler(message);
  });
  return {
    send: (message) => worker.postMessage(JSON.parse(message)),
    subscribe: (handler) => void handlers.add(handler),
    unsubscribe: (handler) => void handlers.delete(handler),
  };
};

class TabFile implements WorkspaceFile {
  constructor(
    readonly uri: string,
    readonly languageId: string,
    public version: number,
    public doc: Text,
    readonly view: EditorView,
  ) {}
  getView(): EditorView {
    return this.view;
  }
}

/** One editor per file. `display` brings a file's tab to the front for cross-file jumps. */
class TabWorkspace extends Workspace {
  files: TabFile[] = [];
  #versions = new Map<string, number>();

  constructor(client: LSPClient, readonly display: (uri: string) => EditorView | null) {
    super(client);
  }

  #next(uri: string): number {
    const version = (this.#versions.get(uri) ?? -1) + 1;
    this.#versions.set(uri, version);
    return version;
  }

  syncFiles(): ReturnType<Workspace["syncFiles"]> {
    const updates: { file: WorkspaceFile; prevDoc: Text; changes: ChangeSet }[] = [];
    for (const file of this.files) {
      const plugin = LSPPlugin.get(file.view);
      if (!plugin || plugin.unsyncedChanges.empty) continue;
      updates.push({ file, prevDoc: file.doc, changes: plugin.unsyncedChanges });
      file.doc = file.view.state.doc;
      file.version = this.#next(file.uri);
      plugin.clear();
    }
    return updates;
  }

  openFile(uri: string, languageId: string, view: EditorView): void {
    const file = new TabFile(uri, languageId, this.#next(uri), view.state.doc, view);
    this.files.push(file);
    this.client.didOpen(file);
  }

  closeFile(uri: string): void {
    if (!this.getFile(uri)) return;
    this.files = this.files.filter((file) => file.uri !== uri);
    this.client.didClose(uri);
  }

  override async displayFile(uri: string): Promise<EditorView | null> {
    return this.display(uri);
  }
}

// ---- decorations the server computes -------------------------------------------------------

const setTokens = StateEffect.define<DecorationSet>();
const setHints = StateEffect.define<DecorationSet>();

const decorationField = (effect: typeof setTokens) =>
  StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update: (value, transaction) => {
      for (const entry of transaction.effects) if (entry.is(effect)) return entry.value;
      return transaction.docChanged ? value.map(transaction.changes) : value;
    },
    provide: (field) => EditorView.decorations.from(field),
  });

const tokensField = decorationField(setTokens);
const hintsField = decorationField(setHints);

class HintWidget extends WidgetType {
  constructor(readonly label: string) {
    super();
  }
  override eq(other: HintWidget): boolean {
    return other.label === this.label;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-inlay-hint";
    span.textContent = this.label;
    return span;
  }
}

const lspPosition = (doc: Text, position: lsp.Position): number => {
  const line = doc.line(Math.min(position.line + 1, doc.lines));
  return Math.min(line.from + position.character, line.to);
};

/** LSP 3.18 allows Markdown messages; parlance sends plain strings. */
export const messageText = (message: string | lsp.MarkupContent): string => typeof message === "string" ? message : message.value;

const severityOf = (value: lsp.DiagnosticSeverity | undefined): Diagnostic["severity"] =>
  value === 2 ? "warning" : value === 3 ? "info" : value === 4 ? "hint" : "error";

/** Applies a server edit to whichever open files it touches. */
export const applyEdit = (client: LSPClient, edit: lsp.WorkspaceEdit): void => {
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
    const file = client.workspace.getFile(uri);
    const view = file?.getView();
    if (!view) continue;
    const changes: ChangeSpec[] = edits.map((entry) => ({
      from: lspPosition(view.state.doc, entry.range.start),
      to: lspPosition(view.state.doc, entry.range.end),
      insert: entry.newText,
    }));
    view.dispatch({ changes, userEvent: "input.fix" });
  }
};

export type PublishedDiagnostics = { readonly uri: string; readonly diagnostics: readonly lsp.Diagnostic[] };

export type ClientHooks = {
  /** Brings a file's editor to the front. */
  readonly display: (uri: string) => EditorView | null;
  /** The server finished analyzing a file and published its diagnostics. */
  readonly analyzed: (published: PublishedDiagnostics) => void;
};

/** After an analysis: lint diagnostics with quick fixes, semantic tokens, and inlay hints. */
const refresh = async (client: LSPClient, file: WorkspaceFile, published: readonly lsp.Diagnostic[]): Promise<void> => {
  const view = file.getView();
  if (!view) return;
  const version = file.version;
  const doc = file.doc;
  const textDocument = { uri: file.uri };
  const whole = { start: { line: 0, character: 0 }, end: { line: doc.lines, character: 0 } };
  const [actions, tokens, hints] = await Promise.all([
    published.length === 0
      ? Promise.resolve([])
      : client.request<lsp.CodeActionParams, (lsp.CodeAction | lsp.Command)[] | null>("textDocument/codeAction", {
        textDocument,
        range: whole,
        context: { diagnostics: [...published] },
      }).catch(() => null),
    client.request<lsp.SemanticTokensParams, lsp.SemanticTokens | null>("textDocument/semanticTokens/full", { textDocument })
      .catch(() => null),
    client.request<lsp.InlayHintParams, lsp.InlayHint[] | null>("textDocument/inlayHint", { textDocument, range: whole })
      .catch(() => null),
  ]);
  // A newer version is on its way to the server; its own publish will refresh again.
  if (file.version !== version || client.workspace.getFile(file.uri) !== file) return;
  const plugin = LSPPlugin.get(view);
  if (!plugin) return;
  const map = (position: lsp.Position) => plugin.unsyncedChanges.mapPos(lspPosition(doc, position));

  const fixes = (actions ?? []).filter((action): action is lsp.CodeAction => "edit" in action && action.edit !== undefined);
  const diagnostics: Diagnostic[] = published.map((item) => {
    const own = fixes.filter((action) =>
      action.diagnostics?.some((entry) => messageText(entry.message) === messageText(item.message) && sameRange(entry.range, item.range))
    );
    return {
      from: map(item.range.start),
      to: map(item.range.end),
      severity: severityOf(item.severity),
      message: messageText(item.message),
      ...(own.length > 0
        ? { actions: own.map((action): Action => ({ name: action.title, apply: () => applyEdit(client, action.edit!) })) }
        : {}),
    };
  });

  const legend = client.serverCapabilities?.semanticTokensProvider?.legend;
  const marks: Range<Decoration>[] = [];
  if (tokens && legend) {
    let line = 0;
    let character = 0;
    const data = tokens.data;
    for (let index = 0; index + 4 < data.length; index += 5) {
      line += data[index]!;
      character = data[index] === 0 ? character + data[index + 1]! : data[index + 1]!;
      const length = data[index + 2]!;
      const type = legend.tokenTypes[data[index + 3]!];
      const bits = data[index + 4]!;
      if (!type || length === 0) continue;
      const modifiers = legend.tokenModifiers.filter((_, bit) => bits & (1 << bit)).map((name) => ` tk-${name}`).join("");
      const from = map({ line, character });
      const to = map({ line, character: character + length });
      if (to > from) marks.push(Decoration.mark({ class: `tk-${type}${modifiers}` }).range(from, to));
    }
  }
  const widgets = (hints ?? []).map((hint) => {
    const label = typeof hint.label === "string" ? hint.label : hint.label.map((part) => part.value).join("");
    return Decoration.widget({ widget: new HintWidget(label), side: 1 }).range(map(hint.position));
  });
  view.dispatch(setDiagnostics(view.state, diagnostics), {
    effects: [setTokens.of(RangeSet.of(marks, true)), setHints.of(RangeSet.of(widgets, true))],
  });
};

const sameRange = (a: lsp.Range, b: lsp.Range): boolean =>
  a.start.line === b.start.line && a.start.character === b.start.character && a.end.line === b.end.line
  && a.end.character === b.end.character;

/** Sends edits to the server shortly after typing stops. */
const autoSync = ViewPlugin.fromClass(class {
  pending = -1;
  constructor(readonly view: EditorView) {}
  update(update: ViewUpdate) {
    if (!update.docChanged) return;
    clearTimeout(this.pending);
    this.pending = window.setTimeout(() => LSPPlugin.get(this.view)?.client.sync(), 250);
  }
  destroy() {
    clearTimeout(this.pending);
  }
});

/** Cmd-click (Ctrl-click) jumps to a definition, switching tabs when it is in another file. */
const clickToDefinition = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return false;
    view.dispatch({ selection: { anchor: pos } });
    event.preventDefault();
    return jumpToDefinition(view);
  },
});

/** A client connected to the worker, with every feature the playground uses. */
export const connect = (worker: Worker, hooks: ClientHooks): LSPClient => {
  const features: LSPClientExtension = {
    clientCapabilities: {
      textDocument: {
        publishDiagnostics: { versionSupport: true },
        codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ["quickfix"] } } },
        inlayHint: {},
        semanticTokens: { requests: { full: true }, formats: ["relative"], tokenTypes: [], tokenModifiers: [] },
      },
    },
    notificationHandlers: {
      "textDocument/publishDiagnostics": (client, params: lsp.PublishDiagnosticsParams) => {
        const file = client.workspace.getFile(params.uri);
        if (!file || (params.version != null && params.version !== file.version)) return true;
        hooks.analyzed({ uri: params.uri, diagnostics: params.diagnostics });
        void refresh(client, file, params.diagnostics);
        return true;
      },
    },
    editorExtension: [
      tokensField,
      hintsField,
      autoSync,
      clickToDefinition,
      keymap.of([...renameKeymap, ...jumpToDefinitionKeymap, ...findReferencesKeymap]),
    ],
  };
  return new LSPClient({
    rootUri: "file:///",
    timeout: 10_000,
    workspace: (client) => new TabWorkspace(client, hooks.display),
    extensions: [serverCompletion(), hoverTooltips({ hoverTime: 250 }), features],
  }).connect(workerTransport(worker));
};
