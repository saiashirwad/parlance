import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AnyLanguage } from "../language.ts";
import type { ModuleGraph } from "../modules.ts";
import {
  analyzeSnippet,
  duplicateKeys,
  embedsExtension,
  findSnippets,
  type HostDiagnostic,
  isHostFile,
  type Snippet,
  snippetDiagnostics,
} from "./snippets.ts";

/** Snippet finding and mapping, which need no filesystem, live in `snippets.ts`. */
export * from "./snippets.ts";

/** TypeScript files under a directory, skipping `node_modules` and dot directories. */
export const hostFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
      try {
        return hostFiles(path);
      } catch {
        return [];
      }
    }
    return entry.isFile() && isHostFile(entry.name) ? [path] : [];
  }).sort();

const read = (path: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

/** Stubs covering a host file: `.embeds` files in its directory and each ancestor. */
export const stubsFor = (path: string): string[] => {
  const found: string[] = [];
  for (let directory = dirname(resolve(path)); ; directory = dirname(directory)) {
    try {
      for (const name of readdirSync(directory)) if (name.endsWith(embedsExtension)) found.push(join(directory, name));
    } catch {
      // An unreadable directory has no stubs.
    }
    if (dirname(directory) === directory) return found;
  }
};

/**
 * A file outside the project that the content mapper watches for a stub. tsgo ignores disk events
 * for files open in the editor, so saving a snippet in an open file would not refresh its types;
 * the LSP writes this file instead, which makes tsgo reopen the project and rebuild the registry.
 */
export const embedStamp = (stub: string): string =>
  join(tmpdir(), "parlance-embeds", `${createHash("sha256").update(resolve(stub)).digest("hex").slice(0, 16)}.stamp`);

export const touchStamp = (stub: string, onlyIfMissing = false): void => {
  const path = embedStamp(stub);
  if (onlyIfMissing && existsSync(path)) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${Date.now()}\n`);
  } catch {
    // Types then refresh on the next project reload.
  }
};

export type HostFile = { readonly path: string; readonly source: string; readonly snippets: readonly Snippet[] };

/** The snippets a stub covers: every TypeScript file under its directory, read from disk. */
export const stubSnippets = (stub: string, tags: ReadonlyMap<string, AnyLanguage>): HostFile[] =>
  tags.size === 0 ? [] : hostFiles(dirname(stub)).flatMap((path) => {
    const source = read(path);
    if (![...tags.keys()].some((tag) => source.includes(tag))) return [];
    const snippets = findSnippets(source, pathToFileURL(path).href, tags);
    return snippets.length === 0 ? [] : [{ path, source, snippets }];
  });

const interfaceName = (tag: string): string => `${tag[0]!.toUpperCase()}${tag.slice(1)}Embeds`;

const importLine = /^import\s+(type\s+)?(.+?)\s+from\s+(["'])([^"']*)\3\s*;?\s*$/;

const rebase = (specifier: string, from: string, to: string): string => {
  if (!specifier.startsWith(".")) return specifier;
  const path = relative(to, resolve(from, specifier)).replaceAll("\\", "/");
  return path.startsWith(".") ? path : `./${path}`;
};

/**
 * A module-shaped declaration file as the body of an ambient namespace. Each import becomes a
 * hoisted namespace import with aliases inside, so snippets cannot collide; a default import is
 * hoisted under its own name. Relative specifiers move from the host's directory to the stub's.
 */
const namespaced = (text: string, from: string, to: string, counter: { next: number }): { hoisted: string[]; body: string } => {
  const hoisted: string[] = [];
  const body: string[] = [];
  for (const line of text.split("\n")) {
    const found = importLine.exec(line);
    if (found) {
      const type = found[1] ?? "";
      const clause = found[2]!;
      const specifier = JSON.stringify(rebase(found[4]!, from, to));
      const alias = `__import${counter.next++}`;
      hoisted.push(`import ${type}* as ${alias} from ${specifier};`);
      const named = /\{([^}]*)\}/.exec(clause)?.[1];
      const star = /\*\s+as\s+([\w$]+)/.exec(clause)?.[1];
      const fallback = /^([\w$]+)\s*(,|$)/.exec(clause)?.[1];
      if (fallback) hoisted.push(`import ${type}${fallback} from ${specifier};`);
      if (star) body.push(`  import ${star} = ${alias};`);
      for (const part of (named ?? "").split(",").map((entry) => entry.trim()).filter(Boolean)) {
        const [name, local = name] = part.replace(/^type\s+/, "").split(/\s+as\s+/) as [string, string?];
        body.push(`  import ${local} = ${alias}.${name};`);
      }
      continue;
    }
    if (/^import\s+["']/.test(line)) continue;
    const exported = /^export\s+default\s+([\w$]+)\s*;\s*$/.exec(line);
    if (exported) body.push(`  export { ${exported[1]} as default };`);
    else body.push(line === "" ? "" : `  ${line.replace(/^(\s*)(export\s+)?declare\s+/, "$1$2")}`);
  }
  return { hoisted, body: body.join("\n").trimEnd() };
};

export type Registry = {
  readonly text: string;
  readonly diagnostics: readonly { readonly file: HostFile; readonly diagnostic: HostDiagnostic }[];
  readonly files: readonly HostFile[];
};

/**
 * The typed tag functions for one stub: a namespace per snippet holding the language's TypeScript
 * surface, an interface per tag keyed by snippet key, and a tag function over those keys.
 */
export const embedRegistry = (stub: string, graph: ModuleGraph, tags: ReadonlyMap<string, AnyLanguage>): Registry => {
  const directory = dirname(stub);
  const hoisted: string[] = [];
  const namespaces: string[] = [];
  const entries = new Map<string, string[]>([...tags.keys()].map((tag) => [tag, []]));
  const diagnostics: { file: HostFile; diagnostic: HostDiagnostic }[] = [];
  const counter = { next: 0 };
  const seen = new Map<string, Snippet>();
  const files = stubSnippets(stub, tags);
  for (const file of files) {
    for (const diagnostic of duplicateKeys(file.snippets, seen)) diagnostics.push({ file, diagnostic });
    for (const snippet of file.snippets) {
      if (seen.get(`${snippet.tag}:${snippet.key}`) !== snippet) continue;
      const analysis = analyzeSnippet(graph, snippet);
      for (const diagnostic of snippetDiagnostics(snippet, analysis)) diagnostics.push({ file, diagnostic });
      const doc = snippet.language.typescript && analysis.ir !== null ? snippet.language.typescript(analysis.ir) : null;
      const name = `__${snippet.tag}${namespaces.length}`;
      const wrapped = namespaced(doc?.text ?? "", dirname(file.path), directory, counter);
      hoisted.push(...wrapped.hoisted);
      namespaces.push(`/** ${snippet.tag}(${JSON.stringify(snippet.key)}) in ${relative(directory, file.path)} */\ndeclare namespace ${name} {\n${wrapped.body}\n}\n`);
      entries.get(snippet.tag)!.push(`  readonly ${JSON.stringify(snippet.key)}: typeof ${name};`);
    }
  }
  const tagged = [...entries].map(([tag, list]) => {
    const name = interfaceName(tag);
    return `export interface ${name} {\n${list.map((entry) => `${entry}\n`).join("")}}\n`
      + `export declare function ${tag}<K extends keyof ${name}>(key: K): (strings: TemplateStringsArray, ...holes: unknown[]) => ${name}[K];\n`;
  });
  const text = [...hoisted, ...(hoisted.length ? [""] : []), ...namespaces, ...tagged].join("\n");
  return { text: text || "export {};\n", diagnostics, files };
};

/** A host file's path from a snippet URI or a loader URL with a query. */
export const hostPath = (uri: string): string => fileURLToPath(uri.replace(/[?#].*$/, ""));
