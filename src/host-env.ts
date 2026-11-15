import { isBareSpecifier } from "./language.ts";

/**
 * What the core needs from its surroundings: file text, existence, and bare specifier
 * resolution. Nothing here imports `node:*`, so a browser bundle can carry the core.
 * The Node implementation is in `host-node.ts`.
 */
export type HostEnv = {
  /** File text, or undefined when the document does not exist. */
  readonly readFile: (uri: string) => string | undefined;
  readonly exists: (uri: string) => boolean;
  /** Resolves an import specifier. Without it, specifiers resolve as URLs and bare ones do not resolve. */
  readonly resolve?: (specifier: string, from: string) => string | null;
  /** Turns a path that is not a URL into a document URI. Without it, paths are absolute `file:` paths. */
  readonly uri?: (path: string) => string;
};

/** Relative and absolute specifiers resolve as URLs from the importer. Bare specifiers do not resolve. */
export const urlResolve = (specifier: string, from: string): string | null => {
  if (isBareSpecifier(specifier)) return null;
  try {
    return new URL(specifier, from).href;
  } catch {
    return null;
  }
};

/** A document URI's path, decoded. A `file:` URI gives its POSIX path. */
export const uriPath = (uri: string): string => {
  try {
    const url = new URL(uri);
    const path = url.pathname || url.hostname || url.href;
    return url.protocol === "file:" ? decodeURIComponent(path) : path;
  } catch {
    return uri;
  }
};

export type MemoryHost = HostEnv & {
  /** The files, by URI. Change them in place; the graph rereads on the next analysis. */
  readonly files: Map<string, string>;
};

/** A host over an in-memory file map, for the browser playground and tests. */
export const memoryHost = (
  files: Iterable<readonly [string, string]> | Readonly<Record<string, string>> = {},
  options: Pick<HostEnv, "resolve"> = {},
): MemoryHost => {
  const entries = Symbol.iterator in files
    ? [...(files as Iterable<readonly [string, string]>)]
    : Object.entries(files as Readonly<Record<string, string>>);
  const map = new Map(entries.map(([uri, text]) => [new URL(uri, "file:///").href, text]));
  return {
    files: map,
    readFile: (uri) => map.get(uri),
    exists: (uri) => map.has(uri),
    resolve: options.resolve ?? urlResolve,
    uri: (path) => new URL(path, "file:///").href,
  };
};
