/**
 * The language server runs in a browser Web Worker. The worker entry bundles for the browser
 * with every Node built-in refused, and the bundle, run behind a worker-scope shim, answers
 * diagnostics and hover for calc and shade over messages, reading imports from memory.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { build, type Metafile, type Plugin } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

/** Fails the build on any Node built-in, naming the importer. */
const noNode: Plugin = {
  name: "no-node-builtins",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) =>
      builtins.has(args.path) || args.path.startsWith("node:")
        ? { errors: [{ text: `${args.path} is a Node built-in, imported by ${args.importer}` }] }
        : undefined);
  },
};

const bundle = async (entry: string, contents?: string): Promise<{ text: string; metafile: Metafile }> => {
  const result = await build({
    ...(contents === undefined
      ? { entryPoints: [entry] }
      : { stdin: { contents, resolveDir: root, sourcefile: entry, loader: "ts" as const } }),
    absWorkingDir: root,
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
    plugins: [noNode],
  });
  return { text: result.outputFiles[0]!.text, metafile: result.metafile };
};

test("the worker entry bundles for the browser without Node built-ins or the schema runtime", async () => {
  const { metafile } = await bundle("examples/worker.ts");
  const inputs = Object.keys(metafile.inputs);
  for (const path of ["src/lsp/core.ts", "src/graph.ts", "examples/calc/calc.ts", "examples/shade/shade.ts", "examples/schema/schema.ts"]) {
    assert.ok(inputs.includes(path), `${path} is not in the bundle`);
  }
  // Analyzing and emitting schema never loads its node:sqlite runtime.
  assert.ok(!inputs.includes("examples/schema/runtime.ts"));
});

/** A minimal JSON-RPC client over a Node worker that runs the bundle. */
const client = (worker: Worker) => {
  let next = 0;
  const pending = new Map<number, (result: unknown) => void>();
  const published = new Map<string, ((diagnostics: { message: string; severity: number }[]) => void)[]>();
  worker.on("message", (message: { id?: number; method?: string; params?: any; result?: unknown; error?: unknown }) => {
    if (message.id !== undefined && message.method === undefined) {
      pending.get(message.id)?.(message.error ? Promise.reject(message.error) : message.result);
      pending.delete(message.id);
    } else if (message.method === "textDocument/publishDiagnostics") {
      for (const resolve of published.get(message.params.uri)?.splice(0) ?? []) resolve(message.params.diagnostics);
    }
  });
  const notify = (method: string, params: unknown) => worker.postMessage({ jsonrpc: "2.0", method, params });
  /** The next diagnostics published for `uri`. */
  const nextDiagnostics = (uri: string) =>
    new Promise<{ message: string; severity: number }[]>((resolve) => {
      published.set(uri, [...(published.get(uri) ?? []), resolve]);
    });
  return {
    next: nextDiagnostics,
    request: (method: string, params: unknown) =>
      new Promise<any>((resolve) => {
        const id = ++next;
        pending.set(id, resolve);
        worker.postMessage({ jsonrpc: "2.0", id, method, params });
      }),
    notify,
    /** Opens a document and waits for its first diagnostics. */
    open: (uri: string, languageId: string, text: string) =>
      new Promise<{ message: string; severity: number }[]>((resolve) => {
        published.set(uri, [...(published.get(uri) ?? []), resolve]);
        notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } });
      }),
  };
};

/** Where `needle` starts in `text`, as an LSP position. */
const at = (text: string, needle: string, skip = 0) => {
  const offset = text.indexOf(needle) + skip;
  assert.ok(offset >= skip, `${needle} is not in the text`);
  const before = text.slice(0, offset).split("\n");
  return { line: before.length - 1, character: before.at(-1)!.length };
};

/** Bundles a worker entry and runs it in a Node worker behind a worker-scope shim. */
const boot = async (t: TestContext, entry: string) => {
  const { text } = await bundle("worker-test.ts", entry);
  const directory = mkdtempSync(join(tmpdir(), "parlance-browser-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "worker.mjs"), text);
  // What a DedicatedWorkerGlobalScope gives the reader and writer: postMessage, onmessage, addEventListener.
  writeFileSync(join(directory, "scope.mjs"), [
    'import { parentPort } from "node:worker_threads";',
    "globalThis.self = globalThis;",
    "globalThis.postMessage = (message) => parentPort.postMessage(message);",
    "globalThis.addEventListener = () => {};",
    'Object.defineProperty(globalThis, "onmessage", { set: (listener) => parentPort.on("message", (data) => listener({ data })) });',
    'await import("./worker.mjs");',
  ].join("\n"));
  const worker = new Worker(join(directory, "scope.mjs"));
  t.after(() => worker.terminate());
  const lsp = client(worker);
  return lsp;
};

test("the bundled worker serves calc and shade over messages, reading imports from memory", async (t) => {
  const entry = [
    'import config from "./parlance.config.ts";',
    'import { serveWorker } from "./src/lsp/browser.ts";',
    `serveWorker(config.languages, { files: { "file:///play/lib.calc": ${JSON.stringify("let base = 85 + 40;\n")} } });`,
  ].join("\n");
  const lsp = await boot(t, entry);

  const init = await lsp.request("initialize", { processId: null, rootUri: null, capabilities: {} });
  assert.equal(init.capabilities.hoverProvider, true);
  lsp.notify("initialized", {});

  const main = 'use "./lib.calc";\nlet total = base * 2;\nshow total;\n';
  assert.deepEqual(await lsp.open("file:///play/main.calc", "calc", main), []);
  const hover = await lsp.request("textDocument/hover", {
    textDocument: { uri: "file:///play/main.calc" },
    position: at(main, "base"),
  });
  assert.equal(hover.contents.value, "number");
  const definition = await lsp.request("textDocument/definition", {
    textDocument: { uri: "file:///play/main.calc" },
    position: at(main, "base"),
  });
  assert.equal(definition.uri, "file:///play/lib.calc");

  const broken = "let x = 1 + true;\nshow y;\n";
  const problems = await lsp.open("file:///play/broken.calc", "calc", broken);
  assert.ok(problems.some((entry) => /Expected number/.test(entry.message)), JSON.stringify(problems));
  assert.ok(problems.some((entry) => /y/.test(entry.message)), JSON.stringify(problems));

  const particles = readFileSync(join(root, "examples/shade/particles.gpu"), "utf8");
  assert.deepEqual(await lsp.open("file:///play/particles.gpu", "shade", particles), []);
  const struct = await lsp.request("textDocument/hover", {
    textDocument: { uri: "file:///play/particles.gpu" },
    position: at(particles, "struct Particle", "struct ".length),
  });
  assert.match(struct.contents.value, /^struct Particle \(size 64, align 16\)$/);

  const wrong = particles.replace("return clamp(1.0 - age / params.lifetime, 0.0, 1.0);", "return 1u;");
  const errors = await lsp.open("file:///play/wrong.gpu", "shade", wrong);
  assert.ok(errors.length > 0 && errors.every((entry) => entry.severity === 1), JSON.stringify(errors));
});

test("the worker takes in-memory files and emits a document's projections", async (t) => {
  const entry = [
    'import config from "./parlance.config.ts";',
    'import { serveWorker } from "./src/lsp/browser.ts";',
    `serveWorker(config.languages, { files: { "file:///play/lib.calc": ${JSON.stringify("let base = 85 + 40;\n")} } });`,
  ].join("\n");
  const lsp = await boot(t, entry);
  await lsp.request("initialize", { processId: null, rootUri: null, capabilities: {} });
  lsp.notify("initialized", {});

  const main = 'use "./lib.calc";\nlet total = base * 2;\nshow total;\n';
  assert.deepEqual(await lsp.open("file:///play/main.calc", "calc", main), []);
  const emitted = await lsp.request("parlance/emit", { uri: "file:///play/main.calc" });
  assert.deepEqual(emitted.errors, []);
  assert.deepEqual(emitted.modules.map((module: { uri: string }) => module.uri), ["file:///play/lib.calc", "file:///play/main.calc"]);
  assert.match(emitted.modules[1].code, /from "\.\/lib\.calc"/);
  assert.match(emitted.typescript.text, /total/);
  assert.ok(emitted.typescript.mappings.length > 0);

  // A changed import re-checks the open importer.
  const rechecked = lsp.next("file:///play/main.calc");
  lsp.notify("parlance/files", { files: { "/play/lib.calc": "let base = true;\n" } });
  assert.ok((await rechecked).some((entry) => /number/.test(entry.message)));
  const failed = await lsp.request("parlance/emit", { uri: "file:///play/main.calc" });
  assert.ok(failed.errors.length > 0 && failed.modules.length === 0);

  const particles = readFileSync(join(root, "examples/shade/particles.gpu"), "utf8");
  await lsp.open("file:///play/particles.gpu", "shade", particles);
  const shade = await lsp.request("parlance/emit", { uri: "file:///play/particles.gpu" });
  assert.match(shade.targets.wgsl, /@compute @workgroup_size\(64, 1, 1\)/);
});
