import { readFileSync } from "node:fs";
import { compileGrammar } from "../../src/grammar/compile.ts";
import { parseGrammar } from "../../src/grammar/parse.ts";
import { defineLanguage, importSpecifier } from "../../src/language.ts";
import type { File } from "./advanced.ast.ts";
import { type AdvancedModule, check, describeBinding } from "./check.ts";
import { runtime } from "./emit.ts";
import { show, type Type } from "./type.ts";
import { typescript } from "./typescript.ts";

const sourceText = readFileSync(new URL("./advanced.parl", import.meta.url), "utf8");
const parsed = parseGrammar(sourceText, "advanced.parl");
if (!parsed.ok) throw new Error(parsed.diagnostics.map((entry) => entry.message).join("\n"));
const grammar = compileGrammar<File>(parsed.file, "advanced.parl");
if (!grammar.valid) throw new Error(grammar.diagnostics.map((entry) => entry.message).join("\n"));

export const advanced = defineLanguage<File, AdvancedModule, Type>({
  name: "advanced",
  extensions: [".advanced"],
  grammar,
  check,
  imports: (file) =>
    file.items.flatMap((item) =>
      item.kind === "import" ? [importSpecifier(item.specifier)] : []
    ),
  exports: (module) => module.exports.map((entry) => entry.binding),
  typescript,
  runtime,
  show: (type) => show(type),
  completions: ["number", "boolean", "string"].map((label) => ({
    label,
    kind: "type" as const,
    detail: "scalar",
  })),
  describe: (binding) => describeBinding(binding),
});
