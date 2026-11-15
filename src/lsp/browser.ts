import { BrowserMessageReader, BrowserMessageWriter, type Connection, createConnection } from "vscode-languageserver/browser";
import type { ModuleGraphOptions } from "../graph.ts";
import { type HostEnv, memoryHost } from "../host-env.ts";
import type { AnyLanguage } from "../language.ts";
import { listen } from "./core.ts";

export type WorkerOptions = Pick<ModuleGraphOptions, "resolve"> & {
  /** Where unopened files come from. Defaults to an in-memory host over `files`. */
  readonly host?: HostEnv;
  /** Files by URI (or absolute path), for the default in-memory host. */
  readonly files?: Readonly<Record<string, string>>;
};

declare global {
  // Named by vscode-jsonrpc's browser types; lib.webworker has the full interface, and this merges with it.
  interface DedicatedWorkerGlobalScope {}
}

type Port = ConstructorParameters<typeof BrowserMessageReader>[0];

/**
 * The language server inside a Web Worker, over the worker's own message port. A page connects
 * with `new Worker(url, { type: "module" })` and a JSON-RPC client such as
 * `@codemirror/lsp-client`. Nothing here imports `node:*`.
 */
export const serveWorker = (
  languages: readonly AnyLanguage[],
  options: WorkerOptions = {},
): { readonly connection: Connection; readonly host: HostEnv } => {
  const scope = globalThis as unknown as Port;
  const host = options.host ?? memoryHost(options.files ?? {});
  const connection = createConnection(new BrowserMessageReader(scope), new BrowserMessageWriter(scope));
  listen(connection, languages, { host, ...(options.resolve ? { resolve: options.resolve } : {}) });
  return { connection, host };
};
