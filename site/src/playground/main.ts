/**
 * The playground page: one editor per file of the chosen example's workspace, all open in the
 * language server, and output panels fed by `parlance/emit` and the run worker. The URL names the
 * language, the file, and the linked lines (see `share.ts`); the workspace persists per example.
 */
import { javascript } from "@codemirror/lang-javascript";
import { sql } from "@codemirror/lang-sql";
import { lintGutter } from "@codemirror/lint";
import type { LSPClient } from "@codemirror/lsp-client";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import type * as lsp from "vscode-languageserver-protocol";
import type { EmitResult } from "../../../src/lsp/browser.ts";
import { type Example, examples, isDriver, uriOf } from "./examples.ts";
import { linkedLines, linkedRange, selectionPosition, showLinked } from "./lines.ts";
import { connect, messageText, type PublishedDiagnostics } from "./lsp.ts";
import type { RunMessage, RunModule, RunRequest } from "./run-worker.ts";
import { decodeFiles, decodeLegacy, encodeFiles, type Files, formatPlace, type Place, parsePlace, type Position } from "./share.ts";
import { tsClient } from "./ts-client.ts";
import type { TsDoc } from "../../../src/ts/template.ts";
import { editorTheme, highlight } from "./theme.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const languageSelect = $<HTMLSelectElement>("language");
const runButton = $<HTMLButtonElement>("run");
const statusLine = $("status");
const fileTabs = $("files");
const editors = $("editors");
const consoleView = $("console");
const targetSelect = $<HTMLSelectElement>("target");
const targetPicker = targetSelect.parentElement!;
const problemList = $("problems");
const problemCount = $("problem-count");

// ---- state -----------------------------------------------------------------------------------

const base = import.meta.env.BASE_URL;
/** What a file name may end with: a registered guest extension, or `.ts`. */
const extensions = [...(document.body.dataset.extensions ?? "").split(" ").filter(Boolean), ".ts"];

/** An example's files as they ship. */
const original = (entry: Example): Map<string, string> => new Map(entry.files.map((file) => [file.name, file.text]));
const storageKey = (entry: Example) => `parlance:workspace:${entry.id}`;

/** The workspace saved for an example, if any. */
const stored = (entry: Example): Map<string, string> | null => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey(entry)) ?? "null");
    if (!Array.isArray(value)) return null;
    const pairs = value.filter((pair): pair is [string, string] => typeof pair?.[0] === "string" && typeof pair?.[1] === "string");
    return pairs.length > 0 ? new Map(pairs) : null;
  } catch {
    return null;
  }
};

/** Each example's workspace, in tab order. Views write into these maps; they are never replaced. */
const workspaces = new Map(examples.map((entry) => [entry.id, stored(entry) ?? original(entry)]));
/** Each modified workspace, encoded for the URL. */
const encoded = new Map<string, string>();
let example: Example = examples[0]!;
let active = example.files[0]!.name;
/** The lines the URL links in the active file. */
let linked: Position | null = null;
/** Where a shift-click range starts. */
let anchorLine: number | null = null;
const views = new Map<string, EditorView>();
const problems = new Map<string, readonly lsp.Diagnostic[]>();
let emitted: { uri: string; result: EmitResult } | null = null;
/** Each guest file's last TypeScript surface, for mapping TypeScript definitions back. */
const surfaces = new Map<string, TsDoc>();
/** Every URI in the language server's in-memory host, to clear when a workspace reloads. */
const hosted = new Set<string>();

const files = (): Map<string, string> => workspaces.get(example.id)!;
const names = (): string[] => [...files().keys()];

const modified = (entry: Example): boolean => {
  const workspace = [...workspaces.get(entry.id)!];
  return workspace.length !== entry.files.length
    || workspace.some(([name, text], index) => entry.files[index]?.name !== name || entry.files[index]?.text !== text);
};

/** Shown while the language server starts, briefly for a note, and when something fails. */
const setStatus = (state: "starting" | "ready" | "note" | "error", text: string) => {
  statusLine.dataset.state = state;
  statusLine.textContent = text;
};

let noteTimer = -1;
const note = (text: string) => {
  if (statusLine.dataset.state === "error" || statusLine.dataset.state === "starting") return;
  setStatus("note", text);
  clearTimeout(noteTimer);
  noteTimer = window.setTimeout(() => setStatus("ready", ""), 2500);
};

// ---- language server -------------------------------------------------------------------------

const lspWorker = new Worker(new URL("../lsp-worker.ts", import.meta.url), { type: "module" });
lspWorker.addEventListener("error", () => setStatus("error", "language server failed"));

const nameOf = (uri: string): string | undefined =>
  uri.startsWith(`file:///${example.id}/`) ? uri.slice(`file:///${example.id}/`.length) : undefined;

const client: LSPClient = connect(lspWorker, {
  display: (uri) => {
    const name = nameOf(uri);
    if (name === undefined || !views.has(name)) return null;
    select(name);
    // The client moves the selection once the view is shown; link the line it lands on.
    window.setTimeout(() => {
      if (active === name) link(lineOf(views.get(name)!), "push");
    });
    return views.get(name)!;
  },
  analyzed: ({ uri, diagnostics }: PublishedDiagnostics) => {
    problems.set(uri, diagnostics);
    renderProblems();
    scheduleEmit();
    scheduleSurfaces();
  },
});

/** Sets files in the language server's in-memory host (null removes one); open files re-check. */
const host = (changed: Readonly<Record<string, string | null>>) => {
  const entries = Object.entries(changed).map(([name, text]) => [uriOf(example, name), text] as const);
  for (const [uri, text] of entries) {
    if (text === null) hosted.delete(uri);
    else hosted.add(uri);
  }
  client.notification("parlance/files", { files: Object.fromEntries(entries) });
};

// ---- TypeScript ------------------------------------------------------------------------------

/** A tab's path in the TypeScript worker; a guest file's surface is its path plus `.ts`. */
const tsPath = (name: string): string => `/${example.id}/${name}`;

const ts = tsClient({
  jump: (path, offset) => {
    const prefix = `/${example.id}/`;
    if (!path.startsWith(prefix)) return;
    const file = path.slice(prefix.length);
    const guest = file.replace(/\.ts$/, "");
    if (views.has(guest) && !isDriver(guest)) {
      // A surface offset maps back to the guest span it came from, as the content mapper does.
      const mapping = surfaces.get(guest)?.mappings.find(([start, length]) => offset >= start && offset < start + length);
      const target = mapping ? mapping[2] + Math.min(offset - mapping[0], Math.max(mapping[3] - 1, 0)) : 0;
      return focus(guest, target);
    }
    if (views.has(file)) focus(file, offset);
  },
});

/** Jumps to an offset in another tab and links its line. */
const focus = (name: string, offset: number) => {
  select(name);
  const view = views.get(name)!;
  view.dispatch({ selection: { anchor: Math.min(offset, view.state.doc.length) }, scrollIntoView: true });
  view.focus();
  link(lineOf(view), "push");
};

/** Refreshes every guest surface in the TypeScript worker, then re-checks the `.ts` tabs. */
const syncSurfaces = async () => {
  const guests = names().filter((name) => !isDriver(name));
  const results = await Promise.all(guests.map((name) => emit(name).catch(() => null)));
  const changed: Record<string, string | null> = {};
  // A deleted or renamed guest file's surface goes, so what imported it no longer resolves.
  for (const name of [...surfaces.keys()]) {
    if (guests.includes(name)) continue;
    surfaces.delete(name);
    changed[`${tsPath(name)}.ts`] = null;
  }
  guests.forEach((name, index) => {
    const surface = results[index]?.typescript;
    if (!surface) return;
    surfaces.set(name, surface);
    changed[`${tsPath(name)}.ts`] = surface.text;
  });
  await ts.call("files", { files: changed });
  ts.recheck();
};

let surfaceTimer = -1;
const scheduleSurfaces = () => {
  clearTimeout(surfaceTimer);
  surfaceTimer = window.setTimeout(() => void syncSurfaces(), 150);
};

// ---- editors ---------------------------------------------------------------------------------

const readOnly = (extensions: Extension[]): Extension[] => [
  basicSetup,
  EditorView.lineWrapping,
  editorTheme,
  highlight,
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
  ...extensions,
];

const emitView = new EditorView({ parent: $("emit-view"), extensions: readOnly([]) });
const tsView = new EditorView({ parent: $("ts-view"), extensions: readOnly([javascript({ typescript: true })]) });
const languageExtension = new Map<string, Extension>();

const setText = (view: EditorView, text: string, language: Extension = []) => {
  view.setState(EditorState.create({ doc: text, extensions: readOnly([language]) }));
};

const runKeys = keymap.of([{ key: "Mod-Enter", run: () => (void run(), true) }]);

const editorFor = (name: string, text: string): EditorView => {
  const uri = uriOf(example, name);
  return new EditorView({
    parent: editors,
    state: EditorState.create({
      doc: text,
      extensions: [
        runKeys,
        linkedLines({
          pick: (line, extend) => {
            const from = extend ? anchorLine ?? linked?.line ?? line : line;
            if (!extend) anchorLine = line;
            link({ line: Math.min(from, line), endLine: Math.max(from, line) }, "replace");
          },
          copy: (line) => {
            const range = linkedRange(views.get(name)!);
            if (!range || line < range.line || line > range.endLine) link({ line, endLine: line }, "replace");
            copyLink();
          },
        }),
        basicSetup,
        EditorView.lineWrapping,
        lintGutter(),
        editorTheme,
        highlight,
        isDriver(name) ? ts.extension(tsPath(name)) : client.plugin(uri, name.slice(name.lastIndexOf(".") + 1)),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          files().set(name, update.state.doc.toString());
          save();
          if (isDriver(name)) scheduleEmit();
        }),
        EditorView.contentAttributes.of({ "aria-label": name }),
      ],
    }),
  });
};

/** Shows a file, highlighting `position` and scrolling to it. Does not touch the URL. */
const select = (name: string, position: Position | null = null) => {
  const previous = views.get(active);
  if (previous && active !== name) showLinked(previous, null);
  active = name;
  linked = position;
  anchorLine = position?.line ?? null;
  for (const [file, view] of views) {
    view.dom.hidden = file !== name;
    if (file === name) view.requestMeasure();
  }
  for (const tab of fileTabs.querySelectorAll<HTMLElement>(".file-tab")) {
    tab.setAttribute("aria-selected", String(tab.dataset.file === name));
  }
  const view = views.get(name);
  if (view) showLinked(view, position, true);
  scheduleEmit();
};

/** Opens an example's workspace at a file (else the first) and a position. */
const load = async (next: Example, file: string | null = null, position: Position | null = null) => {
  for (const view of views.values()) view.destroy();
  views.clear();
  problems.clear();
  emitted = null;
  example = next;
  renderLanguages();
  surfaces.clear();
  runButton.hidden = next.run === "none";
  const workspace = files();
  // Every file is in memory before any opens, so the first analysis already resolves imports.
  // TypeScript files are there too, for guest files that import names from them.
  const gone = [...hosted].filter((uri) => uri.startsWith(`file:///${next.id}/`) && !workspace.has(uri.slice(`file:///${next.id}/`.length)));
  host({ ...Object.fromEntries(gone.map((uri) => [uri.slice(`file:///${next.id}/`.length), null])), ...Object.fromEntries(workspace) });
  void ts.call("clear", { prefix: `/${next.id}/` });
  renderTabs();
  for (const [name, text] of workspace) views.set(name, editorFor(name, text));
  select(file !== null && workspace.has(file) ? file : names()[0]!, file !== null && workspace.has(file) ? position : null);
  renderProblems();
  consoleView.replaceChildren();
  void run();
};

// ---- links -----------------------------------------------------------------------------------

/** The current place: language, file, linked lines, and the workspace when it is modified. */
const place = (): Place => ({ language: example.id, file: active, position: linked, data: encoded.get(example.id) ?? null });

/** Writes the current place to the URL: a new history entry for navigation, else in place. */
const writeUrl = (how: "push" | "replace") => {
  const url = formatPlace(place(), base);
  if (how === "push" && url === location.pathname + location.hash) return;
  history[how === "push" ? "pushState" : "replaceState"]({ playground: true }, "", url);
};

/** Links lines in the active file. */
const link = (position: Position | null, how: "push" | "replace") => {
  linked = position;
  const view = views.get(active);
  if (view) showLinked(view, position);
  writeUrl(how);
};

/** Navigates to a file and position: what a tab, a problem, or a definition does. */
const go = (name: string, position: Position | null = null) => {
  select(name, position);
  writeUrl("push");
};

/** The line a view's cursor is on. */
const lineOf = (view: EditorView): Position => {
  const { line } = selectionPosition(view);
  return { line, endLine: line };
};

const copyLink = () => {
  writeUrl("replace");
  navigator.clipboard.writeText(location.href).then(() => note("Link copied"), () => note("Copy the link from the address bar"));
};

// Cmd-Shift-C (Ctrl-Shift-C) copies a link to the selection, or to the linked lines.
document.addEventListener("keydown", (event) => {
  if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLowerCase() !== "c") return;
  const view = views.get(active);
  if (!view) return;
  event.preventDefault();
  if (view.hasFocus || !linked) link(selectionPosition(view), "replace");
  copyLink();
}, { capture: true });

// ---- files -----------------------------------------------------------------------------------

const problemWithName = (name: string, current?: string): string | null => {
  if (!/^[\w.-]+$/.test(name)) return "A file name has letters, digits, dots, dashes, and underscores.";
  if (!extensions.some((extension) => name.endsWith(extension) && name.length > extension.length)) {
    return `A file name ends with ${extensions.join(", ")}.`;
  }
  if (name !== current && files().has(name)) return `${name} already exists.`;
  return null;
};

/** An inline name field: Enter or leaving it commits, Escape cancels. */
const nameField = (initial: string, label: string, commit: (name: string) => string | null, done: () => void) => {
  const input = Object.assign(document.createElement("input"), {
    className: "tab-input",
    value: initial,
    spellcheck: false,
    placeholder: `name${guestExtension()}`,
  });
  input.setAttribute("aria-label", label);
  input.size = Math.max(initial.length, 10);
  let finished = false;
  /** Leaving the field with a bad name cancels; Enter keeps it open with the problem shown. */
  const finish = (save: boolean, leaving = false) => {
    if (finished) return;
    finished = true;
    const name = input.value.trim();
    const problem = save && name !== "" && name !== initial ? commit(name) : null;
    if (problem && !leaving) {
      finished = false;
      input.setAttribute("aria-invalid", "true");
      note(problem);
      return;
    }
    done();
  };
  input.addEventListener("input", () => {
    input.removeAttribute("aria-invalid");
    input.size = Math.max(input.value.length, 10);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== "Escape") return;
    // The editor may take focus while this runs; the key must not reach it.
    event.preventDefault();
    finish(event.key === "Enter");
  });
  input.addEventListener("blur", () => finish(true, true));
  return input;
};

/** The extension a new file defaults to: the guest language of this example. */
const guestExtension = (): string => {
  const guest = names().find((name) => !isDriver(name)) ?? example.files[0]!.name;
  return guest.slice(guest.lastIndexOf("."));
};

const tabFor = (name: string): HTMLElement => {
  const tab = document.createElement("div");
  tab.className = "tab file-tab";
  tab.role = "tab";
  tab.tabIndex = 0;
  tab.dataset.file = name;
  tab.title = "Double-click to rename";
  const label = Object.assign(document.createElement("span"), { className: "name", textContent: name });
  const close = Object.assign(document.createElement("button"), { className: "close", type: "button", tabIndex: -1, textContent: "×" });
  close.setAttribute("aria-label", `Delete ${name}`);
  close.title = "Delete";
  tab.append(label, close);
  tab.addEventListener("click", (event) => {
    if (event.target === close || tab.querySelector("input")) return;
    if (active !== name) go(name);
  });
  tab.addEventListener("keydown", (event) => {
    if (event.target === tab && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      go(name);
    }
    if (event.target === tab && event.key === "F2") startRename(tab, name);
  });
  tab.addEventListener("dblclick", (event) => {
    if (event.target !== close) startRename(tab, name);
  });
  close.addEventListener("click", () => removeFile(name));
  return tab;
};

const startRename = (tab: HTMLElement, name: string) => {
  const label = tab.querySelector<HTMLElement>(".name");
  if (!label) return;
  const input = nameField(name, `Rename ${name}`, (next) => problemWithName(next, name) ?? (renameFile(name, next), null), () => {
    if (input.isConnected) input.replaceWith(label);
  });
  label.replaceWith(input);
  input.focus();
  input.setSelectionRange(0, name.lastIndexOf("."));
};

const addButton = (): HTMLElement => {
  const add = Object.assign(document.createElement("button"), { className: "tab add", type: "button", textContent: "+" });
  add.setAttribute("aria-label", "New file");
  add.title = "New file";
  add.addEventListener("click", () => {
    const input = nameField("", "New file name", (name) => problemWithName(name) ?? (createFile(name), null), () => {
      input.remove();
      add.hidden = false;
    });
    add.before(input);
    add.hidden = true;
    input.focus();
  });
  return add;
};

const renderTabs = () => {
  fileTabs.replaceChildren(...names().map(tabFor), addButton());
  fileTabs.dataset.single = String(files().size === 1);
  for (const tab of fileTabs.querySelectorAll<HTMLElement>(".file-tab")) {
    tab.setAttribute("aria-selected", String(tab.dataset.file === active));
  }
  renderProblems();
};

const createFile = (name: string) => {
  files().set(name, "");
  host({ [name]: "" });
  views.set(name, editorFor(name, ""));
  renderTabs();
  go(name);
  save();
  views.get(name)!.focus();
};

const renameFile = (from: string, to: string) => {
  const workspace = files();
  const entries = [...workspace].map(([name, text]): [string, string] => [name === from ? to : name, text]);
  workspace.clear();
  for (const [name, text] of entries) workspace.set(name, text);
  forget(from);
  host({ [from]: null, [to]: workspace.get(to)! });
  views.set(to, editorFor(to, workspace.get(to)!));
  renderTabs();
  select(active === from ? to : active, linked);
  writeUrl("replace");
  scheduleSurfaces();
  save();
};

const removeFile = (name: string) => {
  const workspace = files();
  if (workspace.size === 1) return;
  if (workspace.get(name)!.trim() !== "" && !confirm(`Delete ${name}?`)) return;
  const order = names();
  workspace.delete(name);
  forget(name);
  host({ [name]: null });
  renderTabs();
  if (active === name) select(order[order.indexOf(name) + 1] ?? order[order.indexOf(name) - 1]!);
  else select(active, linked);
  writeUrl("replace");
  scheduleSurfaces();
  save();
};

/** Closes a file's editor and drops what the page and the TypeScript worker knew about it. */
const forget = (name: string) => {
  views.get(name)?.destroy();
  views.delete(name);
  problems.delete(uriOf(example, name));
  if (isDriver(name)) void ts.call("files", { files: { [tsPath(name)]: null } });
};

// ---- problems --------------------------------------------------------------------------------

const renderProblems = () => {
  const items: HTMLElement[] = [];
  let errors = 0;
  for (const [uri, diagnostics] of problems) {
    const name = nameOf(uri);
    if (name === undefined || !views.has(name)) continue;
    const tab = fileTabs.querySelector<HTMLElement>(`[data-file="${CSS.escape(name)}"]`);
    const failing = diagnostics.some((item) => (item.severity ?? 1) === 1);
    tab?.querySelector(".dot")?.remove();
    if (failing && tab) tab.querySelector(".close")!.before(Object.assign(document.createElement("span"), { className: "dot" }));
    for (const item of diagnostics) {
      const severity = item.severity === 2 ? "warning" : item.severity === 3 || item.severity === 4 ? "info" : "error";
      if (severity === "error") errors++;
      const button = document.createElement("button");
      button.className = severity;
      button.append(
        Object.assign(document.createElement("span"), {
          className: "where",
          textContent: `${name}:${item.range.start.line + 1}:${item.range.start.character + 1}`,
        }),
        Object.assign(document.createElement("span"), { className: "message", textContent: messageText(item.message) }),
      );
      button.addEventListener("click", () => {
        const line = item.range.start.line + 1;
        go(name, { line, column: item.range.start.character + 1, endLine: line });
        views.get(name)!.focus();
      });
      const entry = document.createElement("li");
      entry.append(button);
      items.push(entry);
    }
  }
  if (items.length === 0) {
    items.push(Object.assign(document.createElement("li"), { className: "empty", textContent: "No problems." }));
  }
  problemList.replaceChildren(...items);
  problemCount.hidden = errors === 0;
  problemCount.textContent = String(errors);
};

// ---- emit ------------------------------------------------------------------------------------

/** The guest file the output panels describe: the active tab, or the first guest file. */
const guestFile = (): string | undefined => isDriver(active) ? names().find((name) => !isDriver(name)) : active;

const emit = async (name: string): Promise<EmitResult> => {
  client.sync();
  return client.request<{ uri: string }, EmitResult>("parlance/emit", { uri: uriOf(example, name) });
};

let emitTimer = -1;
const scheduleEmit = () => {
  clearTimeout(emitTimer);
  emitTimer = window.setTimeout(() => void refreshOutputs(), 150);
};

const targetLanguage = (target: string): Extension => {
  const make = target === "sql" ? () => sql() : target === "wgsl" ? () => [] : () => javascript({ typescript: target !== "js" });
  if (!languageExtension.has(target)) languageExtension.set(target, make());
  return languageExtension.get(target)!;
};

const refreshOutputs = async () => {
  const name = guestFile();
  if (name === undefined) {
    emitted = null;
    targetSelect.dataset.choices = "0";
    showTarget();
    setText(emitView, "// No guest file to emit.\n");
    setText(tsView, "// No guest file to emit.\n");
    return;
  }
  const uri = uriOf(example, name);
  let result: EmitResult;
  try {
    result = await emit(name);
  } catch (cause) {
    return;
  }
  if (name !== guestFile()) return;
  emitted = { uri, result };
  const failed = result.errors.length > 0 ? `// ${name} has errors; fix them to see output.\n${result.errors.map((error) => `// ${error}`).join("\n")}\n` : null;
  const own = result.modules.find((module) => module.uri === uri)?.code;
  const targets = [...(own ? ["js"] : []), ...Object.keys(result.targets)];
  const chosen = targets.includes(targetSelect.value) ? targetSelect.value : targets.at(-1) ?? "js";
  targetSelect.replaceChildren(...targets.map((target) => new Option(target === "js" ? "JavaScript" : target, target)));
  targetSelect.value = chosen;
  targetSelect.dataset.choices = String(targets.length);
  showTarget();
  renderEmit(failed);
  setText(tsView, result.typescript?.text ?? failed ?? `// ${example.label} has no TypeScript surface.\n`, javascript({ typescript: true }));
};

const renderEmit = (failed: string | null = null) => {
  const result = emitted?.result;
  const target = targetSelect.value;
  if (failed || !result) return setText(emitView, failed ?? "", []);
  const text = target === "js" ? result.modules.find((module) => module.uri === emitted!.uri)?.code : result.targets[target];
  setText(emitView, text ?? `// ${example.label} emits nothing for this file.\n`, targetLanguage(target));
};

targetSelect.addEventListener("change", () => renderEmit());

// ---- run -------------------------------------------------------------------------------------

const print = (text: string, className = "line") => {
  const line = document.createElement("span");
  line.className = className;
  line.textContent = text;
  consoleView.append(line);
  return line;
};

let running: Worker | null = null;

/** Shade kernels dispatch on WebGPU where the browser has it, and on the CPU otherwise. */
const device: RunRequest["device"] = "gpu" in navigator ? "webgpu" : "cpu";

const run = async () => {
  running?.terminate();
  running = null;
  showPanel("run");
  consoleView.replaceChildren();
  if (example.run === "none") {
    print("A grammar does not run. Each .parl file compiles to the parser, the lexer, and the highlighting of one language.", "note");
    return;
  }
  const guests = names().filter((name) => !isDriver(name));
  const entryName = isDriver(active) ? active : files().has(example.entry) ? example.entry : names().find(isDriver) ?? active;
  const results = await Promise.all((isDriver(entryName) ? guests : [entryName]).map(emit)).catch((cause) => {
    print(String(cause), "error");
    return null;
  });
  if (!results) return;
  const errors = results.flatMap((result) => result.errors);
  if (errors.length > 0) {
    for (const error of errors) print(error, "error");
    print("Fix the errors to run.", "meta");
    return;
  }
  if (example.run === "node") {
    print("schema runs under Node only: its runtime opens a node:sqlite database. This is the SQL it creates:", "note");
    const pre = document.createElement("pre");
    pre.textContent = results[0]!.targets.sql ?? "";
    consoleView.append(pre);
    return;
  }
  const modules = new Map<string, RunModule>();
  for (const result of results) {
    for (const module of result.modules) if (module.code !== null) modules.set(module.uri, { ...module, code: module.code });
  }
  const entry = uriOf(example, entryName);
  if (isDriver(entryName)) {
    await ts.call("files", { files: { [tsPath(entryName)]: files().get(entryName)! } });
    modules.set(entry, { uri: entry, language: "js", code: await ts.call("transpile", { path: tsPath(entryName) }) });
  }
  const worker = new Worker(new URL("./run-worker.ts", import.meta.url), { type: "module" });
  running = worker;
  const timer = window.setTimeout(() => {
    worker.terminate();
    print("Stopped after 5 seconds.", "error");
  }, 5000);
  worker.addEventListener("message", ({ data }: MessageEvent<RunMessage>) => {
    if (data.kind === "log") print(data.text, data.level === "log" ? "line" : data.level);
    else {
      clearTimeout(timer);
      worker.terminate();
      if (consoleView.childElementCount === 0) print("(no output)", "note");
    }
  });
  worker.addEventListener("error", (event) => {
    clearTimeout(timer);
    print(event.message || "The run failed.", "error");
  });
  worker.postMessage({ modules: [...modules.values()], entry, device } satisfies RunRequest);
};

runButton.addEventListener("click", () => void run());

// ---- output tabs, split ---------------------------------------------------------------------

let panel = "run";

/** The emit target picker, on the Emit tab when there is more than one target. */
const showTarget = () => {
  targetPicker.hidden = panel !== "emit" || Number(targetSelect.dataset.choices ?? 0) < 2;
};

const showPanel = (next: string) => {
  panel = next;
  showTarget();
  for (const tab of $("outputs").querySelectorAll<HTMLElement>(".tab")) {
    tab.setAttribute("aria-selected", String(tab.dataset.panel === panel));
  }
  for (const element of document.querySelectorAll<HTMLElement>(".panel")) element.hidden = element.dataset.panel !== panel;
  (panel === "emit" ? emitView : panel === "ts" ? tsView : null)?.requestMeasure();
};

for (const tab of $("outputs").querySelectorAll<HTMLElement>(".tab")) {
  tab.addEventListener("click", () => showPanel(tab.dataset.panel!));
}

const split = $("split");
const divider = $("divider");
const resize = (percent: number) => split.style.setProperty("--left", `${Math.min(80, Math.max(25, percent))}%`);
divider.addEventListener("pointerdown", (event) => {
  divider.setPointerCapture(event.pointerId);
  divider.classList.add("dragging");
  const move = (moved: PointerEvent) => {
    const box = split.getBoundingClientRect();
    resize(((moved.clientX - box.left) / box.width) * 100);
  };
  divider.addEventListener("pointermove", move);
  divider.addEventListener("pointerup", () => {
    divider.classList.remove("dragging");
    divider.removeEventListener("pointermove", move);
  }, { once: true });
});
divider.addEventListener("keydown", (event) => {
  const current = parseFloat(split.style.getPropertyValue("--left") || "56");
  if (event.key === "ArrowLeft") resize(current - 2);
  if (event.key === "ArrowRight") resize(current + 2);
});

// ---- saving and sharing ----------------------------------------------------------------------

/** Saves an example's workspace to localStorage and the URL, or forgets it when it is the example. */
const persist = async (entry: Example) => {
  const workspace = [...workspaces.get(entry.id)!];
  const changed = modified(entry);
  try {
    if (changed) localStorage.setItem(storageKey(entry), JSON.stringify(workspace));
    else localStorage.removeItem(storageKey(entry));
  } catch {
    // Storage is full or off; the URL still carries the workspace.
  }
  if (changed) encoded.set(entry.id, await encodeFiles(workspace));
  else encoded.delete(entry.id);
  if (entry === example) {
    renderLanguages();
    writeUrl("replace");
  }
};

let saveTimer = -1;
const save = () => {
  const entry = example;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void persist(entry), 400);
};

/** The language menu, with a quiet way back to the example once the workspace is edited. */
const renderLanguages = () => {
  const options: HTMLElement[] = examples.map((entry) => new Option(entry.label, entry.id));
  if (modified(example)) options.push(document.createElement("hr"), new Option("Reset to example", "reset"));
  languageSelect.replaceChildren(...options);
  languageSelect.value = example.id;
};

languageSelect.addEventListener("change", () => {
  if (languageSelect.value === "reset") {
    languageSelect.value = example.id;
    if (!confirm(`Reset ${example.label} to the example? Your changes to it are lost.`)) return;
    const workspace = files();
    workspace.clear();
    for (const [name, text] of original(example)) workspace.set(name, text);
    const file = workspace.has(active) ? active : null;
    clearTimeout(saveTimer);
    void persist(example).then(() => load(example, file)).then(() => writeUrl("replace"));
    return;
  }
  const next = examples.find((entry) => entry.id === languageSelect.value)!;
  void load(next).then(() => writeUrl("push"));
});

/** Replaces an example's workspace with one a link carries. */
const adopt = async (entry: Example, workspace: Files) => {
  const current = workspaces.get(entry.id)!;
  current.clear();
  for (const [name, text] of workspace) current.set(name, text);
  await persist(entry);
};

/** The example a URL names, with the workspace it carries (if `shared`) applied. */
const resolve = async (place: Place, shared: boolean): Promise<Example> => {
  const found = examples.find((entry) => entry.id === place.language) ?? examples[0]!;
  if (shared && place.legacy !== undefined) {
    const changed = await decodeLegacy(place.legacy);
    await adopt(found, [...original(found)].map(([name, text]) => [name, changed[name] ?? text]));
  }
  const workspace = shared && place.data ? await decodeFiles(place.data) : null;
  if (workspace && workspace.length > 0) await adopt(found, workspace);
  return found;
};

/**
 * Follows the URL after back, forward, or a pasted link. Entries the page wrote carry state; their
 * workspace is history, so only a link from outside replaces the workspace.
 */
const follow = async (outside: boolean) => {
  const target = parsePlace(new URL(location.href), base);
  const shared = outside && (target.data !== null || target.legacy !== undefined);
  const next = await resolve(target, outside);
  if (next !== example || shared) await load(next, target.file, target.position);
  else select(target.file !== null && files().has(target.file) ? target.file : names()[0]!, target.position);
  if (outside) writeUrl("replace");
};

// ---- start -----------------------------------------------------------------------------------

const start = async () => {
  await Promise.all(examples.filter(modified).map(async (entry) => {
    encoded.set(entry.id, await encodeFiles([...workspaces.get(entry.id)!]));
  }));
  const target = parsePlace(new URL(location.href), base);
  const first = await resolve(target, true);
  await client.initializing;
  setStatus("ready", "");
  await load(first, target.file, target.position);
  writeUrl("replace");
  window.addEventListener("popstate", (event) => void follow(event.state?.playground !== true));
};

start().catch((cause) => {
  setStatus("error", "failed to start");
  print(String(cause), "error");
});
