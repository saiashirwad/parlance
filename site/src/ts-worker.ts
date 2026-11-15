/**
 * TypeScript for the playground's `.ts` tabs: a language service over in-memory files, in a
 * module worker. A guest import such as `./demo.calc` resolves to `/calc/demo.calc.ts`, the
 * guest file's TypeScript surface, which the page keeps current from the parlance worker, as
 * the content mapper does for tsgo.
 */
import ts from "typescript";
import type { TsRequest, TsResponse } from "./playground/ts-client.ts";

const libLoaders = import.meta.glob<string>("../node_modules/typescript/lib/lib.*.d.ts", { query: "?raw", import: "default" });
const libDirectory = "/lib/";
const libs = new Map<string, string>();

/** Loads a lib file and every lib it references. */
const loadLib = async (name: string): Promise<void> => {
  const path = libDirectory + name;
  if (libs.has(path)) return;
  const loader = Object.entries(libLoaders).find(([key]) => key.endsWith(`/${name}`))?.[1];
  if (!loader) return;
  const text = await loader();
  libs.set(path, text);
  const references = [...text.matchAll(/\/\/\/\s*<reference lib="([^"]+)"/g)].map((match) => `lib.${match[1]!.toLowerCase()}.d.ts`);
  await Promise.all(references.map(loadLib));
};

const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
  strict: true,
  noEmit: true,
  skipLibCheck: true,
};

/** The `playground` module the WebGPU driver imports. */
const playgroundTypes = `declare module "playground" {
  /** Where this run dispatches kernels. */
  export const device: "cpu" | "webgpu";
  type Kernel = { readonly wgsl: string; readonly bindings: object; dispatch(entry: string, workgroups: number | readonly number[], buffers: Record<string, ArrayBuffer | ArrayBufferView>): void };
  /** Runs a shade kernel on the CPU or on WebGPU and writes results back into the buffers. */
  export function dispatch(kernel: Kernel, entry: string, workgroups: number | readonly number[], buffers: Record<string, ArrayBuffer | ArrayBufferView>): Promise<void>;
}
`;

const files = new Map<string, { text: string; version: number }>([["/playground.d.ts", { text: playgroundTypes, version: 0 }]]);

const host: ts.LanguageServiceHost = {
  getCompilationSettings: () => options,
  getScriptFileNames: () => [...files.keys()],
  getScriptVersion: (path) => String(files.get(path)?.version ?? 0),
  getScriptSnapshot: (path) => {
    const text = files.get(path)?.text ?? libs.get(path);
    return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
  },
  getCurrentDirectory: () => "/",
  getDefaultLibFileName: () => `${libDirectory}lib.d.ts`,
  fileExists: (path) => files.has(path) || libs.has(path),
  readFile: (path) => files.get(path)?.text ?? libs.get(path),
  resolveModuleNameLiterals: (literals, containing) =>
    literals.map(({ text }) => {
      const target = text.startsWith(".") ? new URL(text, `file://${containing}`).pathname : text;
      for (const candidate of [`${target}.ts`, target]) {
        if (files.has(candidate) && candidate.endsWith(".ts")) {
          return { resolvedModule: { resolvedFileName: candidate, extension: ts.Extension.Ts, isExternalLibraryImport: false } };
        }
      }
      return { resolvedModule: undefined };
    }),
};

const service = ts.createLanguageService(host, ts.createDocumentRegistry());
const ready = Promise.all(["lib.es2023.d.ts", "lib.dom.d.ts", "lib.d.ts"].map(loadLib));

const flatten = (message: string | ts.DiagnosticMessageChain): string => ts.flattenDiagnosticMessageText(message, "\n");

const handlers = {
  files: ({ files: changed }: { files: Record<string, string | null> }) => {
    for (const [path, text] of Object.entries(changed)) {
      if (text === null) files.delete(path);
      else if (files.get(path)?.text !== text) files.set(path, { text, version: (files.get(path)?.version ?? 0) + 1 });
    }
    return null;
  },
  diagnostics: ({ path }: { path: string }) => {
    if (!files.has(path)) return [];
    return [...service.getSyntacticDiagnostics(path), ...service.getSemanticDiagnostics(path)].map((diagnostic) => ({
      from: diagnostic.start ?? 0,
      to: (diagnostic.start ?? 0) + (diagnostic.length ?? 0),
      severity: diagnostic.category === ts.DiagnosticCategory.Error ? "error" : diagnostic.category === ts.DiagnosticCategory.Warning ? "warning" : "info",
      message: flatten(diagnostic.messageText),
    }));
  },
  hover: ({ path, pos }: { path: string; pos: number }) => {
    const info = service.getQuickInfoAtPosition(path, pos);
    if (!info) return null;
    return {
      from: info.textSpan.start,
      to: info.textSpan.start + info.textSpan.length,
      code: ts.displayPartsToString(info.displayParts),
      docs: ts.displayPartsToString(info.documentation),
    };
  },
  completions: ({ path, pos }: { path: string; pos: number }) => {
    const result = service.getCompletionsAtPosition(path, pos, {});
    if (!result) return null;
    return {
      from: result.optionalReplacementSpan?.start ?? null,
      options: result.entries.slice(0, 300).map((entry) => ({ label: entry.name, kind: entry.kind, sortText: entry.sortText })),
    };
  },
  definition: ({ path, pos }: { path: string; pos: number }) => {
    const found = service.getDefinitionAtPosition(path, pos)?.[0];
    return found ? { path: found.fileName, start: found.textSpan.start, end: found.textSpan.start + found.textSpan.length } : null;
  },
  transpile: ({ path }: { path: string }) =>
    ts.transpileModule(files.get(path)?.text ?? "", {
      fileName: path,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: false },
    }).outputText,
};

export type TsMethods = typeof handlers;

onmessage = async ({ data }: MessageEvent<TsRequest>) => {
  await ready;
  let response: TsResponse;
  try {
    const handler = handlers[data.method] as (params: unknown) => unknown;
    response = { id: data.id, result: handler(data.params) };
  } catch (cause) {
    response = { id: data.id, error: String(cause) };
  }
  postMessage(response);
};
