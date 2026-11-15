import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Binding, Dependency, ForeignSource } from "./check/index.ts";
import { type Diagnostic, error, route, withDocument } from "./diagnostic.ts";
import {
  type Analysis,
  analyzeParsed,
  type AnyLanguage,
  type Import,
  isBareSpecifier,
} from "./language.ts";
import type { IncrementalStats } from "./parser/incremental.ts";
import type { ParseResult } from "./parser/parse.ts";

export type ResolvedImport = {
  readonly import: Import;
  readonly uri: string | null;
  readonly node: ModuleNode | null;
  /** The target exists but is not a guest document (a `.ts` file, a package). It is not analyzed. */
  readonly external?: boolean;
};

export type ModuleNode = {
  readonly uri: string;
  readonly language: AnyLanguage;
  readonly source: string;
  readonly analysis: Analysis;
  readonly exports: ReadonlyMap<string, Binding>;
  readonly imports: readonly ResolvedImport[];
};

export type ModuleGraphOptions = {
  readonly languages: readonly AnyLanguage[];
  /** Returns file text, or null when the document does not exist. Defaults to the filesystem. */
  readonly read?: (uri: string) => string | null;
  /** Returns the resolved document URI, or null. Defaults to `defaultResolve`. */
  readonly resolve?: (specifier: string, from: string) => string | null;
};

export type AnalyzeOptions = {
  /** Unsaved editor content. Without it the graph reads the file. */
  readonly source?: string;
  /** An already parsed entry document, as the LSP produces after an incremental reparse. */
  readonly parsed?: ParseResult<unknown>;
  readonly incremental?: IncrementalStats | null;
};

const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** File paths and absolute URLs both become absolute URLs, so every node has one identity. */
export const documentUri = (value: string): string =>
  scheme.test(value) ? new URL(value).href : pathToFileURL(resolve(value)).href;

const documentPath = (uri: string): string => {
  if (uri.startsWith("file:")) return fileURLToPath(uri);
  const url = new URL(uri);
  return url.pathname || url.hostname || url.href;
};

const shortName = (uri: string): string => {
  const path = documentPath(uri);
  return path.slice(path.lastIndexOf("/") + 1) || path;
};

const readDisk = (uri: string): string | null => {
  if (!uri.startsWith("file:")) return null;
  try {
    return readFileSync(fileURLToPath(uri), "utf8");
  } catch {
    return null;
  }
};

/**
 * The default resolver. Relative and absolute specifiers resolve as URLs from the importer. A bare
 * specifier goes through Node package resolution from the importer's directory, so `node_modules`
 * and package `exports` apply. Returns null when nothing resolves.
 */
export const defaultResolve = (specifier: string, from: string): string | null => {
  try {
    if (isBareSpecifier(specifier)) return from.startsWith("file:") ? pathToFileURL(createRequire(from).resolve(specifier)).href : null;
    const url = new URL(specifier, from);
    return url.href;
  } catch {
    return null;
  }
};

const existsOnDisk = (uri: string): boolean => uri.startsWith("file:") && existsSync(fileURLToPath(uri));

const languageFor = (languages: readonly AnyLanguage[], uri: string): AnyLanguage | undefined => {
  const path = documentPath(uri);
  return languages.find((language) => language.extensions.some((extension) => path.endsWith(extension)));
};

/**
 * One graph per project root. It owns import resolution, cycle detection, dependency order,
 * and analysis caching. Dependencies are analyzed before dependents; their errors are routed
 * to the import site of the dependent while keeping their origin.
 */
export class ModuleGraph {
  readonly #languages: readonly AnyLanguage[];
  readonly #read: (uri: string) => string | null;
  readonly #resolve: (specifier: string, from: string) => string | null;
  readonly #nodes = new Map<string, ModuleNode>();
  readonly #order: string[] = [];
  readonly #dependents = new Map<string, Set<string>>();

  constructor(options: ModuleGraphOptions) {
    this.#languages = options.languages;
    this.#read = options.read ?? readDisk;
    this.#resolve = options.resolve ?? defaultResolve;
  }

  /** Analyzes an entry and every reachable dependency. Returns the entry's routed view. */
  analyze(uri: string, options: AnalyzeOptions = {}): Analysis {
    const id = documentUri(uri);
    const existing = this.#nodes.get(id);
    const source = options.source ?? this.#read(id);
    if (source === null) throw new Error(`Cannot read ${id}`);
    for (const stale of this.#staleDependencies(id)) this.#invalidate(stale);
    if (existing && (existing.source !== source || options.parsed !== undefined)) this.#invalidate(id);
    return this.#visit(id, source, [], options.incremental ?? null, options.parsed).analysis;
  }

  /** Dependency URIs whose backing source no longer matches the cached node. */
  #staleDependencies(uri: string, seen = new Set<string>()): string[] {
    const node = this.#nodes.get(uri);
    if (!node || seen.has(uri)) return [];
    seen.add(uri);
    const stale: string[] = [];
    for (const edge of node.imports) {
      if (edge.uri === null || edge.external) continue;
      const source = this.#read(edge.uri);
      if (edge.node === null) {
        // A missing import that now exists, or a cycle edge. Rebuild the
        // dependent so both cases get a fresh answer.
        if (source !== null) stale.push(uri);
        continue;
      }
      if (source === null || edge.node.source !== source) {
        stale.push(edge.uri);
        continue;
      }
      stale.push(...this.#staleDependencies(edge.uri, seen));
    }
    return stale;
  }

  node(uri: string): ModuleNode | undefined {
    return this.#nodes.get(documentUri(uri));
  }

  /** Drops a document and every document that transitively imports it. */
  forget(uri: string): void {
    this.#invalidate(documentUri(uri));
  }

  source(uri: string): string | undefined {
    return this.#nodes.get(documentUri(uri))?.source;
  }

  /** Every analyzed document, dependencies before dependents. */
  order(): readonly string[] {
    return [...this.#order];
  }

  /** Every analyzed document. */
  watched(): readonly string[] {
    return [...this.#nodes.keys()].sort();
  }

  #visit(
    uri: string,
    source: string,
    stack: readonly string[],
    incremental: IncrementalStats | null,
    parsed: ParseResult<unknown> | undefined,
  ): ModuleNode {
    const cached = this.#nodes.get(uri);
    if (cached && cached.source === source && parsed === undefined) {
      for (const stale of this.#staleDependencies(uri)) this.#invalidate(stale);
      const fresh = this.#nodes.get(uri);
      if (fresh && fresh.source === source) return fresh;
    }
    // A dependency can change while another entry is being visited. Drop the
    // old node and every dependent before rebuilding it.
    if (this.#nodes.has(uri)) this.#invalidate(uri);

    const language = languageFor(this.#languages, uri);
    if (!language) throw new Error(`No parlance language is registered for ${uri}`);

    const tree = parsed ?? language.grammar.parse(source);
    const imports = tree.value === null ? [] : language.imports?.(tree.value) ?? [];
    const foreignImports = tree.value === null ? [] : language.foreign?.(tree.value) ?? [];
    const diagnostics: Diagnostic[] = [];
    const dependencies: Dependency[] = [];
    const edges: ResolvedImport[] = [];
    const ancestors = [...stack, uri];
    const seen = new Set<string>();

    for (const entry of [...imports, ...foreignImports.map((foreign) => foreign.specifier)]) {
      const target = this.#resolve(entry.specifier, uri);
      if (target === null) {
        diagnostics.push(error(`Cannot resolve import ${JSON.stringify(entry.specifier)}`, entry.span));
        edges.push({ import: entry, uri: null, node: null });
        continue;
      }
      if (ancestors.includes(target)) {
        const start = ancestors.indexOf(target);
        const cycle = [...ancestors.slice(start), target].map(shortName).join(" -> ");
        diagnostics.push(error(`Import cycle: ${cycle}`, entry.span));
        edges.push({ import: entry, uri: target, node: null });
        continue;
      }
      if (foreignImports.some((foreign) => foreign.specifier === entry) && languageFor(this.#languages, target)) {
        diagnostics.push(error(`${JSON.stringify(entry.specifier)} is a guest file; use the language's own import`, entry.span));
        edges.push({ import: entry, uri: target, node: null, external: true });
        continue;
      }
      if (!languageFor(this.#languages, target)) {
        // A non-guest target. The TypeScript surface and the Node loader resolve it themselves.
        const found = this.#read(target) !== null || existsOnDisk(target);
        if (!found) diagnostics.push(error(`Cannot resolve import ${JSON.stringify(entry.specifier)}`, entry.span));
        edges.push({ import: entry, uri: target, node: null, external: found });
        continue;
      }
      const targetSource = this.#read(target);
      if (targetSource === null) {
        diagnostics.push(error(`Cannot resolve import ${JSON.stringify(entry.specifier)}`, entry.span));
        edges.push({ import: entry, uri: target, node: null });
        continue;
      }
      const node = this.#visit(target, targetSource, ancestors, null, undefined);
      let dependents = this.#dependents.get(target);
      if (!dependents) {
        dependents = new Set();
        this.#dependents.set(target, dependents);
      }
      dependents.add(uri);
      for (const diagnostic of node.analysis.diagnostics) {
        if (diagnostic.severity === "info") continue;
        diagnostics.push(route(withDocument(diagnostic, target), { uri, span: entry.span }));
      }
      if (!seen.has(entry.specifier)) {
        seen.add(entry.specifier);
        dependencies.push({
          specifier: entry.specifier,
          span: entry.span,
          uri: target,
          exports: node.exports as ReadonlyMap<string, Binding>,
          module: node.analysis.ir,
        });
      }
      edges.push({ import: entry, uri: target, node });
    }

    const foreign: ForeignSource[] = foreignImports.map((entry) => ({
      specifier: entry.specifier.specifier,
      span: entry.specifier.span,
      uri: edges.find((edge) => edge.import === entry.specifier)?.uri ?? null,
      names: entry.names,
    }));
    const analysis = analyzeParsed(
      language,
      source,
      uri,
      tree,
      incremental,
      { dependencies, diagnostics, foreign },
    );
    let exports: Map<string, Binding> | null = null;
    const node: ModuleNode = {
      uri,
      language,
      source,
      analysis,
      imports: edges,
      get exports() {
        if (exports === null) {
          exports = new Map();
          if (analysis.ir !== null && language.exports) {
            for (const binding of language.exports(analysis.ir)) {
              exports.set(binding.name, binding.uri === undefined ? { ...binding, uri } : binding);
            }
          }
        }
        return exports;
      },
    };
    this.#nodes.set(uri, node);
    if (!this.#order.includes(uri)) this.#order.push(uri);
    return node;
  }

  /** Drops a changed document and every document that transitively imports it. */
  #invalidate(uri: string): void {
    const queue = [uri];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (!this.#nodes.delete(current)) continue;
      const index = this.#order.indexOf(current);
      if (index >= 0) this.#order.splice(index, 1);
      for (const dependent of this.#dependents.get(current) ?? []) queue.push(dependent);
      this.#dependents.delete(current);
    }
  }
}

export { languageFor as languageForUri };
