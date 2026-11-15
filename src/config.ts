import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AnyLanguage } from "./language.ts";

export type ProjectConfig = {
  readonly languages: readonly AnyLanguage[];
  /** Replaces import resolution. Call `defaultResolve` from `parlance/modules` to fall back. */
  readonly resolve?: (specifier: string, from: string) => string | null;
};

const names = ["parlance.config.ts", "parlance.config.mts", "parlance.config.js", "parlance.config.mjs"];

export const discoverConfig = (directory: string): string | null => {
  for (const name of names) {
    const path = join(directory, name);
    try {
      statSync(path);
      return path;
    } catch {
      continue;
    }
  }
  return null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Imports a project config. The query string busts Node's module cache when the file changes. */
export const loadProject = async (path: string): Promise<ProjectConfig> => {
  const absolute = resolve(path);
  const url = pathToFileURL(absolute);
  try {
    url.searchParams.set("mtime", String(statSync(absolute).mtimeMs));
  } catch {
    // Let the import produce the useful error.
  }
  const module = await import(url.href) as { default?: unknown; languages?: unknown };
  const value = module.default ?? module;
  if (Array.isArray(value)) return { languages: value as AnyLanguage[] };
  if (isRecord(value) && Array.isArray(value.languages)) {
    if (value.resolve !== undefined && typeof value.resolve !== "function") {
      throw new Error(`${absolute}: resolve must be a function`);
    }
    return {
      languages: value.languages as AnyLanguage[],
      ...(typeof value.resolve === "function" ? { resolve: value.resolve as NonNullable<ProjectConfig["resolve"]> } : {}),
    };
  }
  throw new Error(`${absolute} must export a language list, or { languages, resolve? }`);
};

export const loadLanguages = async (path: string): Promise<readonly AnyLanguage[]> => (await loadProject(path)).languages;

export const configFor = async (configFileName: string | undefined): Promise<ProjectConfig> => {
  const directory = configFileName ? resolve(configFileName, "..") : process.cwd();
  const path = discoverConfig(directory);
  return path ? loadProject(path) : { languages: [] };
};
