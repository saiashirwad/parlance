/**
 * Runs emitted guest modules and a driver in a fresh worker, one worker per run, and reports
 * console output. Imports between guest files become blob URLs; any other import a guest module
 * makes is its language's runtime (a URL that Vite rewrote, maybe to a data: URL), so it becomes
 * the bundled runtime; `playground` is the GPU helper.
 */
import * as machineRuntime from "../../../examples/machine/runtime.ts";
import * as shadeRuntime from "../../../examples/shade/runtime.ts";
import * as playground from "./gpu.ts";

export type RunModule = { readonly uri: string; readonly language: string; readonly code: string };
export type RunRequest = { readonly modules: readonly RunModule[]; readonly entry: string; readonly device: "cpu" | "webgpu" };
export type RunMessage =
  | { readonly kind: "log"; readonly level: "log" | "warn" | "error"; readonly text: string }
  | { readonly kind: "done"; readonly ms: number };

const post = (message: RunMessage) => postMessage(message);

const show = (value: unknown, depth = 0): string => {
  if (typeof value === "string") return depth === 0 ? value : JSON.stringify(value);
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (value === null || typeof value !== "object") return String(value);
  if (depth > 3) return Array.isArray(value) ? "[…]" : "{…}";
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return `${value.constructor.name}(${value.byteLength} bytes)`;
  if (Array.isArray(value)) return `[${value.map((entry) => show(entry, depth + 1)).join(", ")}]`;
  const entries = Object.entries(value).map(([key, entry]) => `${key}: ${show(entry, depth + 1)}`);
  return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
};

for (const level of ["log", "info", "warn", "error"] as const) {
  console[level] = (...values: unknown[]) =>
    post({ kind: "log", level: level === "info" ? "log" : level, text: values.map((value) => show(value)).join(" ") });
}

const globals = globalThis as unknown as { __parlance: Record<string, object> };
globals.__parlance = { machine: machineRuntime, shade: shadeRuntime, playground };

/** A module that re-exports one of the bundled modules above. */
const shim = (name: string): string => {
  const names = Object.keys(globals.__parlance[name]!);
  return `const m = globalThis.__parlance[${JSON.stringify(name)}];\nexport const { ${names.join(", ")} } = m;\n`;
};

const blob = (code: string): string => URL.createObjectURL(new Blob([code], { type: "text/javascript" }));

const specifiers = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;

const link = (modules: readonly RunModule[]): Map<string, string> => {
  const urls = new Map<string, string>();
  const shims = new Map<string, string>();
  const shimFor = (name: string) => shims.get(name) ?? shims.set(name, blob(shim(name))).get(name)!;
  // Imports come first, so every guest specifier a module names is already linked.
  for (const module of modules) {
    const code = module.code.replace(specifiers, (whole, head: string, quote: string, specifier: string) => {
      if (specifier === "playground") return `${head}${quote}${shimFor("playground")}${quote}`;
      const target = urls.get(new URL(specifier, module.uri).href);
      if (target) return `${head}${quote}${target}${quote}`;
      if (module.language in globals.__parlance) return `${head}${quote}${shimFor(module.language)}${quote}`;
      return whole;
    });
    urls.set(module.uri, blob(code));
  }
  return urls;
};

onmessage = async ({ data }: MessageEvent<RunRequest>) => {
  const started = performance.now();
  playground.use(data.device);
  try {
    const urls = link(data.modules);
    await import(/* @vite-ignore */ urls.get(data.entry)!);
  } catch (cause) {
    console.error(cause);
  }
  post({ kind: "done", ms: Math.round(performance.now() - started) });
};
