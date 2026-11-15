import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { discoverConfig, loadProject } from "../config.ts";
import { type Diagnostic, site } from "../diagnostic.ts";
import { extensionMap, type AnyLanguage } from "../language.ts";
import { ModuleGraph } from "../modules.ts";
import { embedRegistry, embedsExtension, embedTags, hostLocation, stubSnippets } from "./embed.ts";
import { type Mapping } from "./template.ts";

type HostConfig = {
  readonly languages: readonly AnyLanguage[];
};

export type MapperDiagnostic = {
  readonly messageText: string;
  readonly start: number;
  readonly length: number;
  readonly code: number;
};

export type TransformResult = {
  readonly text: string;
  readonly extension: ".ts";
  readonly mappings: readonly Mapping[];
  readonly diagnostics: readonly MapperDiagnostic[];
};

type Project = {
  readonly key: string;
  readonly configPath: string | null;
  readonly languages: readonly AnyLanguage[];
  readonly extensions: ReadonlySet<string>;
  readonly tags: ReadonlyMap<string, AnyLanguage>;
  readonly watchedFiles: readonly string[];
  readonly configIdentity: string;
  readonly error: string | null;
  readonly graph: ModuleGraph;
};

const emptyModule = "export {};\n";

const failed = (message: string): TransformResult => ({
  text: emptyModule,
  extension: ".ts",
  mappings: [],
  diagnostics: [{ messageText: message, start: 0, length: 0, code: 1 }],
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const guestFiles = (directory: string, extensions: ReadonlySet<string>): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
      try {
        return guestFiles(path, extensions);
      } catch {
        return [];
      }
    }
    return entry.isFile() && extensions.has(extname(entry.name)) ? [path] : [];
  });

const contents = (file: string): string => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

/** Guest files count whole; a TypeScript host file counts only its snippets, so other edits keep the project. */
const identity = (
  configPath: string | null,
  files: readonly string[],
  tags: ReadonlyMap<string, AnyLanguage>,
): string => {
  const hash = createHash("sha256");
  if (configPath) hash.update(configPath).update("\0").update(contents(configPath)).update("\0");
  for (const file of files) {
    hash.update(file).update("\0");
    if (!file.endsWith(embedsExtension)) hash.update(contents(file)).update("\0");
    else {
      for (const host of stubSnippets(file, tags)) {
        for (const snippet of host.snippets) hash.update(`${host.path}\0${snippet.tag}\0${snippet.key}\0${snippet.text}\0`);
      }
    }
  }
  return hash.digest("hex");
};

/** Host files a stub reads, so saving one refreshes the registry. */
const hostsOf = (stubs: readonly string[], tags: ReadonlyMap<string, AnyLanguage>): string[] =>
  stubs.flatMap((stub) => stubSnippets(stub, tags).map((host) => host.path));

const buildProject = async (
  key: string,
  configFileName: string | undefined,
  options: Record<string, unknown>,
): Promise<Project> => {
  const base = configFileName ? dirname(resolve(configFileName)) : process.cwd();
  const configured = typeof options.config === "string"
    ? resolve(base, options.config)
    : typeof options.languages === "string"
    ? resolve(base, options.languages)
    : discoverConfig(base);
  try {
    const { languages, resolve: resolver } = configured ? await loadProject(configured) : { languages: [], resolve: undefined };
    const extensions = new Set<string>();
    for (const language of languages) for (const extension of language.extensions) extensions.add(extension);
    const tags = embedTags(languages);
    if (tags.size > 0) extensions.add(embedsExtension);
    const found = configured ? guestFiles(base, extensions).sort() : [];
    const watched = [...new Set([...found, ...hostsOf(found.filter((file) => file.endsWith(embedsExtension)), tags)])].sort();
    return {
      key,
      configPath: configured,
      languages,
      extensions,
      tags,
      watchedFiles: watched,
      configIdentity: identity(configured, found, tags),
      error: null,
      graph: new ModuleGraph({ languages, ...(resolver ? { resolve: resolver } : {}) }),
    };
  } catch (cause) {
    return {
      key,
      configPath: configured,
      languages: [],
      extensions: new Set(),
      tags: new Map(),
      watchedFiles: [],
      configIdentity: `error:${String(cause)}`,
      error: `Cannot load ${configured ?? "language config"}: ${cause instanceof Error ? cause.message : String(cause)}`,
      graph: new ModuleGraph({ languages: [] }),
    };
  }
};

const projectFor = (project: Project, fileName: string): AnyLanguage | undefined => {
  const extension = extname(fileName);
  if (!project.extensions.has(extension)) return undefined;
  return project.languages.find((language) => language.extensions.includes(extension as `.${string}`));
};

const mapperDiagnostic = (diagnostic: Diagnostic, uri: string): MapperDiagnostic | undefined => {
  const location = site(diagnostic, uri);
  if (location.uri !== uri) return undefined;
  return {
    messageText: diagnostic.context?.length
      ? `${diagnostic.message} (${diagnostic.context.join(" > ")})`
      : diagnostic.message,
    start: Math.max(0, location.span.start),
    length: Math.max(0, location.span.end - location.span.start),
    code: 1,
  };
};

/** A `.embeds` stub: the typed tag registry. Snippet problems are reported on the stub, with their host position. */
const registry = (project: Project, fileName: string): TransformResult => {
  const built = embedRegistry(resolve(fileName), project.graph, project.tags);
  const directory = dirname(resolve(fileName));
  return {
    text: built.text,
    extension: ".ts",
    mappings: [],
    diagnostics: built.diagnostics.map(({ file, diagnostic }) => ({
      messageText: `${hostLocation(relative(directory, file.path), file.source, diagnostic.span.start)}: ${diagnostic.message}`,
      start: 0,
      length: 0,
      code: 1,
    })),
  };
};

const transform = (project: Project, fileName: string, content: string): TransformResult => {
  if (project.error) return failed(project.error);
  if (fileName.endsWith(embedsExtension)) {
    try {
      return registry(project, fileName);
    } catch (cause) {
      return failed(cause instanceof Error ? cause.message : String(cause));
    }
  }
  const language = projectFor(project, fileName);
  if (!language) return failed(`No parlance language is registered for ${extname(fileName)} files`);
  try {
    const uri = pathToFileURL(fileName).href;
    const analysis = project.graph.analyze(uri, { source: content });
    const doc = language.typescript && analysis.ir !== null ? language.typescript(analysis.ir) : null;
    return {
      text: doc?.text || emptyModule,
      extension: ".ts",
      mappings: doc?.mappings ?? [],
      diagnostics: analysis.diagnostics.flatMap((diagnostic) => {
        const mapped = mapperDiagnostic(diagnostic, uri);
        return mapped ? [mapped] : [];
      }),
    };
  } catch (cause) {
    return failed(cause instanceof Error ? cause.message : String(cause));
  }
};

type Reply =
  | { readonly result: unknown }
  | { readonly error: { readonly code: number; readonly message: string } };

export type MapperIO = {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
};

/**
 * The TypeScript 7.1 content mapper. One process serves every language in the project's
 * config; `options.config` is resolved relative to the tsconfig that names this package.
 */
export const serveContentMapper = (io: MapperIO = { input: process.stdin, output: process.stdout }): void => {
  const projects = new Map<string, Project>();
  const send = (message: Record<string, unknown>) => {
    const body = JSON.stringify({ jsonrpc: "2.0", ...message });
    io.output.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };

  const answer = async (method: string, params: unknown): Promise<Reply> => {
    const options = isRecord(params) && isRecord(params.options) ? params.options : {};
    switch (method) {
      case "initialize":
        return { result: { positionEncoding: "utf-16", diagnosticSource: "parlance" } };
      case "openProject": {
        if (!isRecord(params)) return { error: { code: -32602, message: "openProject expects an object" } };
        const key = typeof params.projectHandle === "string" ? params.projectHandle : "default";
        const project = await buildProject(
          key,
          typeof params.configFileName === "string" ? params.configFileName : undefined,
          options,
        );
        projects.set(key, project);
        return { result: { watchedFiles: project.watchedFiles, configIdentity: project.configIdentity } };
      }
      case "closeProject": {
        if (isRecord(params) && typeof params.projectHandle === "string") projects.delete(params.projectHandle);
        return { result: null };
      }
      case "transform": {
        if (!isRecord(params) || typeof params.fileName !== "string" || typeof params.content !== "string") {
          return { error: { code: -32602, message: "transform expects { fileName, content, projectHandle }" } };
        }
        const key = typeof params.projectHandle === "string" ? params.projectHandle : "default";
        const project = projects.get(key);
        if (!project) return { error: { code: -32602, message: `No open project ${key}; call openProject first` } };
        return { result: transform(project, params.fileName, params.content) };
      }
      default:
        return { error: { code: -32601, message: `Unsupported method ${method}` } };
    }
  };

  const receive = (body: string) => {
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      send({ id: null, error: { code: -32700, message: "Invalid JSON" } });
      return;
    }
    if (!isRecord(message) || typeof message.method !== "string" || message.id === undefined) return;
    void answer(message.method, message.params).then((reply) => send({ id: message.id, ...reply })).catch((cause) => {
      send({ id: message.id, error: { code: -32603, message: String(cause) } });
    });
  };

  let pending = Buffer.alloc(0);
  io.input.on("data", (chunk: Buffer | string) => {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    for (;;) {
      const end = pending.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = /Content-Length: *(\d+)/i.exec(pending.subarray(0, end).toString())?.[1];
      if (length === undefined) {
        pending = pending.subarray(end + 4);
        continue;
      }
      const stop = end + 4 + Number(length);
      if (pending.length < stop) return;
      const body = pending.subarray(end + 4, stop).toString("utf8");
      pending = pending.subarray(stop);
      receive(body);
    }
  });
};

export { extensionMap };
