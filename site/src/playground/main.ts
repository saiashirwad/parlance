/**
 * The playground page: one editor per file of the chosen example, all open in the language
 * server, and output panels fed by `parlance/emit` and the run worker.
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
import { connect, messageText, type PublishedDiagnostics } from "./lsp.ts";
import type { RunMessage, RunModule, RunRequest } from "./run-worker.ts";
import { readHash, writeHash } from "./share.ts";
import { tsClient } from "./ts-client.ts";
import type { TsDoc } from "../../../src/ts/template.ts";
import { editorTheme, highlight } from "./theme.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const languageSelect = $<HTMLSelectElement>("language");
const runButton = $<HTMLButtonElement>("run");
const gpuButton = $<HTMLButtonElement>("run-gpu");
const statusLine = $("status");
const fileTabs = $("files");
const editors = $("editors");
const consoleView = $("console");
const targetSelect = $<HTMLSelectElement>("target");
const problemList = $("problems");
const problemCount = $("problem-count");

// ---- state -----------------------------------------------------------------------------------

/** Each example's current file texts, kept across language switches. */
const texts = new Map<string, Map<string, string>>(
  examples.map((example) => [example.id, new Map(example.files.map((file) => [file.name, file.text]))]),
);
let example: Example = examples[0]!;
let active = example.files[0]!.name;
const views = new Map<string, EditorView>();
const problems = new Map<string, readonly lsp.Diagnostic[]>();
let emitted: { uri: string; result: EmitResult } | null = null;
/** Each guest file's last TypeScript surface, for mapping TypeScript definitions back. */
const surfaces = new Map<string, TsDoc>();

const setStatus = (state: "starting" | "ready" | "error", text: string) => {
  statusLine.dataset.state = state;
  statusLine.textContent = text;
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
    return views.get(name)!;
  },
  analyzed: ({ uri, diagnostics }: PublishedDiagnostics) => {
    problems.set(uri, diagnostics);
    renderProblems();
    scheduleEmit();
    scheduleSurfaces();
  },
});

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

const focus = (name: string, offset: number) => {
  select(name);
  const view = views.get(name)!;
  view.dispatch({ selection: { anchor: Math.min(offset, view.state.doc.length) }, scrollIntoView: true });
  view.focus();
};

/** Refreshes every guest surface in the TypeScript worker, then re-checks the `.ts` tabs. */
const syncSurfaces = async () => {
  const guests = example.files.filter((file) => !isDriver(file.name)).map((file) => file.name);
  const results = await Promise.all(guests.map((name) => emit(name).catch(() => null)));
  const files: Record<string, string> = {};
  guests.forEach((name, index) => {
    const surface = results[index]?.typescript;
    if (!surface) return;
    surfaces.set(name, surface);
    files[`${tsPath(name)}.ts`] = surface.text;
  });
  await ts.call("files", { files });
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

const runKeys = keymap.of([{ key: "Mod-Enter", run: () => (void run("cpu"), true) }]);

const editorFor = (name: string, text: string): EditorView => {
  const uri = uriOf(example, name);
  return new EditorView({
    parent: editors,
    state: EditorState.create({
      doc: text,
      extensions: [
        runKeys,
        basicSetup,
        EditorView.lineWrapping,
        lintGutter(),
        editorTheme,
        highlight,
        isDriver(name) ? ts.extension(tsPath(name)) : client.plugin(uri, example.id),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          texts.get(example.id)!.set(name, update.state.doc.toString());
          share();
          if (isDriver(name)) scheduleEmit();
        }),
        EditorView.contentAttributes.of({ "aria-label": name }),
      ],
    }),
  });
};

const select = (name: string) => {
  active = name;
  for (const [file, view] of views) {
    view.dom.hidden = file !== name;
    if (file === name) view.requestMeasure();
  }
  for (const tab of fileTabs.querySelectorAll<HTMLElement>(".tab")) {
    tab.setAttribute("aria-selected", String(tab.dataset.file === name));
  }
  scheduleEmit();
};

const load = async (next: Example) => {
  for (const view of views.values()) view.destroy();
  views.clear();
  problems.clear();
  emitted = null;
  example = next;
  languageSelect.value = next.id;
  gpuButton.hidden = !(next.gpu && "gpu" in navigator);
  surfaces.clear();
  runButton.disabled = next.run === "none";
  const files = texts.get(next.id)!;
  // Every file is in memory before any opens, so the first analysis already resolves imports.
  client.notification("parlance/files", {
    files: Object.fromEntries([...files].filter(([name]) => !isDriver(name)).map(([name, text]) => [uriOf(next, name), text])),
  });
  fileTabs.replaceChildren(...[...files.keys()].map((name) => {
    const tab = document.createElement("button");
    tab.className = "tab file-tab";
    tab.role = "tab";
    tab.dataset.file = name;
    tab.textContent = name;
    tab.addEventListener("click", () => select(name));
    return tab;
  }));
  for (const [name, text] of files) views.set(name, editorFor(name, text));
  select(next.files[0]!.name);
  renderProblems();
  consoleView.replaceChildren();
  void run("cpu");
};

// ---- problems --------------------------------------------------------------------------------

const renderProblems = () => {
  const items: HTMLElement[] = [];
  let errors = 0;
  for (const [uri, diagnostics] of problems) {
    const name = nameOf(uri);
    if (name === undefined) continue;
    const tab = fileTabs.querySelector<HTMLElement>(`[data-file="${CSS.escape(name)}"]`);
    const failing = diagnostics.some((item) => (item.severity ?? 1) === 1);
    tab?.querySelector(".dot")?.remove();
    if (failing && tab) tab.append(Object.assign(document.createElement("span"), { className: "dot" }));
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
        select(name);
        const view = views.get(name)!;
        const line = view.state.doc.line(Math.min(item.range.start.line + 1, view.state.doc.lines));
        view.dispatch({ selection: { anchor: Math.min(line.from + item.range.start.character, line.to) }, scrollIntoView: true });
        view.focus();
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
const guestFile = (): string => isDriver(active) ? example.files.find((file) => !isDriver(file.name))!.name : active;

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
  const uri = uriOf(example, name);
  let result: EmitResult;
  try {
    result = await emit(name);
  } catch (cause) {
    return;
  }
  if (uri !== uriOf(example, guestFile())) return;
  emitted = { uri, result };
  $("emit-for").textContent = name;
  $("ts-for").textContent = `${name}, as TypeScript sees it`;
  const failed = result.errors.length > 0 ? `// ${name} has errors; fix them to see output.\n${result.errors.map((error) => `// ${error}`).join("\n")}\n` : null;
  const own = result.modules.find((module) => module.uri === uri)?.code;
  const targets = [...(own ? ["js"] : []), ...Object.keys(result.targets)];
  const chosen = targets.includes(targetSelect.value) ? targetSelect.value : targets.at(-1) ?? "js";
  targetSelect.replaceChildren(...targets.map((target) => new Option(target === "js" ? "JavaScript" : target, target)));
  targetSelect.value = chosen;
  targetSelect.disabled = targets.length < 2;
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

const run = async (device: RunRequest["device"], driver?: string) => {
  running?.terminate();
  running = null;
  showPanel("run");
  consoleView.replaceChildren();
  if (example.run === "none") {
    print("A grammar does not run. Each .parl file compiles to the parser, the lexer, and the highlighting of one language.", "note");
    return;
  }
  const guests = example.files.filter((file) => !isDriver(file.name)).map((file) => file.name);
  const entryName = driver ?? (isDriver(active) ? active : example.entry);
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
    await ts.call("files", { files: { [tsPath(entryName)]: texts.get(example.id)!.get(entryName)! } });
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
      print(`${entryName} · ${device === "webgpu" ? "WebGPU" : "CPU"} · ${data.ms} ms`, "meta");
    }
  });
  worker.addEventListener("error", (event) => {
    clearTimeout(timer);
    print(event.message || "The run failed.", "error");
  });
  worker.postMessage({ modules: [...modules.values()], entry, device } satisfies RunRequest);
};

runButton.addEventListener("click", () => void run("cpu"));
gpuButton.addEventListener("click", () => void run("webgpu", example.gpu));

// ---- output tabs, split, sharing -------------------------------------------------------------

const showPanel = (panel: string) => {
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

let shareTimer = -1;
const share = () => {
  clearTimeout(shareTimer);
  shareTimer = window.setTimeout(() => {
    const files = texts.get(example.id)!;
    const changed = Object.fromEntries(example.files.filter((file) => files.get(file.name) !== file.text)
      .map((file) => [file.name, files.get(file.name)!]));
    void writeHash(example.id, changed);
  }, 400);
};

languageSelect.replaceChildren(...examples.map((entry) => new Option(entry.label, entry.id)));
languageSelect.addEventListener("change", () => {
  const next = examples.find((entry) => entry.id === languageSelect.value)!;
  void load(next).then(share);
});

// ---- start -----------------------------------------------------------------------------------

/** The example the URL names, with its shared edits applied. */
const fromHash = async (): Promise<Example> => {
  const saved = await readHash();
  const found = examples.find((entry) => entry.id === saved?.id) ?? examples[0]!;
  for (const [name, text] of Object.entries(saved?.files ?? {})) {
    if (texts.get(found.id)!.has(name)) texts.get(found.id)!.set(name, text);
  }
  return found;
};

const start = async () => {
  const first = await fromHash();
  await client.initializing;
  setStatus("ready", "language server ready");
  await load(first);
  // A pasted link or the back button; our own updates use replaceState and do not land here.
  window.addEventListener("hashchange", () => void fromHash().then(load));
};

start().catch((cause) => {
  setStatus("error", "failed to start");
  print(String(cause), "error");
});
