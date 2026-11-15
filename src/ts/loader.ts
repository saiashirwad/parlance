import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { render, site } from "../diagnostic.ts";
import { extensionMap, type AnyLanguage } from "../language.ts";
import { ModuleGraph, type ModuleGraphOptions } from "../modules.ts";
import {
  analyzeSnippet,
  embedModule,
  embedsExtension,
  embedTags,
  findSnippets,
  hostLocation,
  hostPath,
  snippetDiagnostics,
  snippetQuery,
  snippetRuntime,
} from "./embed.ts";
import { withSourceMap } from "./sourcemap.ts";

const describe = (diagnostic: Parameters<typeof render>[0], url: string, source: string): string => {
  const location = site(diagnostic, url);
  const rendered = render(location ? { ...diagnostic, span: location.span } : diagnostic, source);
  return location.uri === url ? `${fileURLToPath(url)}: ${rendered}` : `${location.uri}: ${rendered}`;
};

const readSource = (path: string): string => readFileSync(path, "utf8");

/**
 * Installs Node module hooks for every guest extension. Guest imports resolve through one graph.
 * A `.embeds` stub becomes, per importer, a module of tag functions over the importer's snippets;
 * each snippet compiles when the stub loads, from `<importer>?parlance-embed=tag:key`.
 */
export const registerLanguages = (
  languages: readonly AnyLanguage[],
  options: Pick<ModuleGraphOptions, "resolve"> = {},
): void => {
  const registry = extensionMap(languages);
  const graph = new ModuleGraph({ languages, ...options });
  const tags = embedTags(languages);
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (tags.size === 0 || !resolved.url.startsWith("file:") || !context.parentURL?.startsWith("file:")) return resolved;
      const url = new URL(resolved.url);
      if (!url.pathname.endsWith(embedsExtension)) return resolved;
      url.searchParams.set("importer", context.parentURL);
      return { ...resolved, url: url.href, shortCircuit: true };
    },
    load(url, context, nextLoad) {
      if (!url.startsWith("file:")) return nextLoad(url, context);
      const parsed = new URL(url);
      if (tags.size > 0 && parsed.pathname.endsWith(embedsExtension)) {
        const importer = parsed.searchParams.get("importer");
        const source = importer ? embedModule(importer, readSource(hostPath(importer)), tags) : embedModule("file:///", "", tags);
        return { format: "module", source, shortCircuit: true };
      }
      const embedded = parsed.searchParams.get(snippetQuery);
      if (tags.size > 0 && embedded !== null) {
        const path = hostPath(url);
        const host = readSource(path);
        const file = new URL(url);
        file.search = "";
        const snippet = findSnippets(host, file.href, tags).find((entry) => `${entry.tag}:${entry.key}` === embedded);
        if (!snippet) throw new SyntaxError(`${path}: no ${embedded} snippet`);
        const analysis = analyzeSnippet(graph, snippet);
        const problems = snippetDiagnostics(snippet, analysis).filter((entry) => entry.severity === "error");
        if (problems.length > 0 || analysis.ir === null) {
          const messages = problems.map((entry) => `${hostLocation(path, host, entry.span.start)}: ${entry.message}`);
          throw new SyntaxError(messages.join("\n") || `${path}: ${embedded} did not compile`);
        }
        const emitted = snippetRuntime(snippet, analysis);
        return {
          format: "module",
          source: typeof emitted === "string" ? emitted : withSourceMap(emitted, host, file.href),
          shortCircuit: true,
        };
      }
      const path = fileURLToPath(url);
      const language = [...registry].find(([extension]) => path.endsWith(extension))?.[1];
      if (!language) return nextLoad(url, context);
      const source = readFileSync(path, "utf8");
      const analysis = graph.analyze(url, { source });
      if (analysis.diagnostics.length > 0 || analysis.ir === null) {
        const errors = analysis.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
        const messages = (errors.length ? errors : analysis.diagnostics).map((diagnostic) =>
          describe(diagnostic, url, source)
        );
        throw new SyntaxError(messages.join("\n"));
      }
      if (!language.runtime) throw new SyntaxError(`${language.name} has no runtime`);
      const emitted = language.runtime(analysis.ir);
      return {
        format: "module",
        source: typeof emitted === "string" ? emitted : withSourceMap(emitted, source, url),
        shortCircuit: true,
      };
    },
  });
};
