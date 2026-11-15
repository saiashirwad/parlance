import { BrowserMessageReader, BrowserMessageWriter, type Connection, createConnection } from "vscode-languageserver/browser";
import type { ModuleGraphOptions, ModuleNode } from "../graph.ts";
import { type HostEnv, memoryHost } from "../host-env.ts";
import type { AnyLanguage } from "../language.ts";
import type { TsDoc } from "../ts/template.ts";
import { listen } from "./core.ts";

export type WorkerOptions = Pick<ModuleGraphOptions, "resolve"> & {
  /** Where unopened files come from. Defaults to an in-memory host over `files`. */
  readonly host?: HostEnv;
  /** Files by URI (or absolute path), for the default in-memory host. */
  readonly files?: Readonly<Record<string, string>>;
};

/** `parlance/files`: set in-memory files by URI (`null` removes one), then re-check open documents. */
export type FilesParams = { readonly files: Readonly<Record<string, string | null>> };

/** `parlance/emit`: every projection of one document, for a playground. */
export type EmitParams = { readonly uri: string };

export type EmitResult = {
  readonly language: string;
  /** Error messages. When there are any, only the TypeScript surface is emitted. */
  readonly errors: readonly string[];
  /** The TypeScript surface, with mappings to guest spans. Present whenever the checker produced IR. */
  readonly typescript: TsDoc | null;
  /** Each named target's text, or the error it threw. */
  readonly targets: Readonly<Record<string, string>>;
  /** ES modules for the document and its guest imports, imports first. `code` is null without a runtime. */
  readonly modules: readonly { readonly uri: string; readonly language: string; readonly code: string | null }[];
};

declare global {
  // Named by vscode-jsonrpc's browser types; lib.webworker has the full interface, and this merges with it.
  interface DedicatedWorkerGlobalScope {}
}

type Port = ConstructorParameters<typeof BrowserMessageReader>[0];

const text = (value: string | { readonly text: string }): string => typeof value === "string" ? value : value.text;

/** The node and its guest imports, imports first. */
const reachable = (node: ModuleNode, seen = new Set<string>()): ModuleNode[] => {
  if (seen.has(node.uri)) return [];
  seen.add(node.uri);
  const imports = node.imports.flatMap((edge) => edge.node && !edge.external ? reachable(edge.node, seen) : []);
  return [...imports, node];
};

/**
 * The language server inside a Web Worker, over the worker's own message port. A page connects
 * with `new Worker(url, { type: "module" })` and a JSON-RPC client such as
 * `@codemirror/lsp-client`. Nothing here imports `node:*`.
 *
 * Besides LSP it answers `parlance/files` (with the default in-memory host) and `parlance/emit`.
 */
export const serveWorker = (
  languages: readonly AnyLanguage[],
  options: WorkerOptions = {},
): { readonly connection: Connection; readonly host: HostEnv } => {
  const scope = globalThis as unknown as Port;
  const memory = options.host ? null : memoryHost(options.files ?? {});
  const host = options.host ?? memory!;
  const connection = createConnection(new BrowserMessageReader(scope), new BrowserMessageWriter(scope));
  const { graph, changed } = listen(connection, languages, { host, ...(options.resolve ? { resolve: options.resolve } : {}) });

  connection.onNotification("parlance/files", ({ files }: FilesParams) => {
    if (!memory) throw new Error("parlance/files needs the default in-memory host");
    const uris = Object.entries(files).map(([path, source]) => {
      const uri = new URL(path, "file:///").href;
      if (source === null) memory.files.delete(uri);
      else memory.files.set(uri, source);
      return uri;
    });
    changed(uris);
  });

  connection.onRequest("parlance/emit", ({ uri }: EmitParams): EmitResult => {
    const analysis = graph.analyze(uri);
    const language = analysis.language;
    const errors = analysis.diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.message);
    const typescript = language.typescript && analysis.ir !== null ? language.typescript(analysis.ir) : null;
    if (errors.length > 0 || analysis.ir === null) {
      return { language: language.name, errors: errors.length > 0 ? errors : ["Nothing to emit"], typescript, targets: {}, modules: [] };
    }
    const targets: Record<string, string> = {};
    for (const [name, target] of Object.entries(language.targets ?? {})) {
      try {
        targets[name] = target(analysis.ir).text;
      } catch (cause) {
        targets[name] = `// ${name} failed: ${String(cause)}`;
      }
    }
    const node = graph.node(uri);
    return {
      language: language.name,
      errors: [],
      typescript,
      targets,
      modules: (node ? reachable(node) : []).map((entry) => ({
        uri: entry.uri,
        language: entry.language.name,
        code: entry.language.runtime && entry.analysis.ir !== null ? text(entry.language.runtime(entry.analysis.ir)) : null,
      })),
    };
  });

  return { connection, host };
};
