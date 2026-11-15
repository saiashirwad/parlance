import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { HostEnv } from "./host-env.ts";
import { isBareSpecifier } from "./language.ts";

const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** File paths and absolute URLs both become absolute URLs, so every node has one identity. */
export const documentUri = (value: string): string =>
  scheme.test(value) ? new URL(value).href : pathToFileURL(resolve(value)).href;

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

/** The filesystem and Node package resolution. */
export const nodeHost: HostEnv = {
  readFile: (uri) => {
    if (!uri.startsWith("file:")) return undefined;
    try {
      return readFileSync(fileURLToPath(uri), "utf8");
    } catch {
      return undefined;
    }
  },
  exists: (uri) => uri.startsWith("file:") && existsSync(fileURLToPath(uri)),
  resolve: defaultResolve,
  uri: documentUri,
};
