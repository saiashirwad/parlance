import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { render, site } from "../diagnostic.ts";
import { analyze, extensionMap, type AnyLanguage } from "../language.ts";

const describe = (diagnostic: Parameters<typeof render>[0], url: string, source: string): string => {
  const location = site(diagnostic, url);
  const rendered = render(location ? { ...diagnostic, span: location.span } : diagnostic, source);
  return location.uri === url ? `${fileURLToPath(url)}: ${rendered}` : `${location.uri}: ${rendered}`;
};

/** Installs Node module hooks for every guest extension. Guest imports resolve recursively. */
export const registerLanguages = (languages: readonly AnyLanguage[]): void => {
  const registry = extensionMap(languages);
  registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith("file:")) return nextLoad(url, context);
      const path = fileURLToPath(url);
      const language = [...registry].find(([extension]) => path.endsWith(extension))?.[1];
      if (!language) return nextLoad(url, context);
      const source = readFileSync(path, "utf8");
      const analysis = analyze(language, source, url);
      if (analysis.diagnostics.length > 0 || analysis.ir === null) {
        const errors = analysis.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
        const messages = (errors.length ? errors : analysis.diagnostics).map((diagnostic) =>
          describe(diagnostic, url, source)
        );
        throw new SyntaxError(messages.join("\n"));
      }
      if (!language.runtime) throw new SyntaxError(`${language.name} has no runtime`);
      return { format: "module", source: language.runtime(analysis.ir), shortCircuit: true };
    },
  });
};
