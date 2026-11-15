import type { Diagnostic } from "../../src/diagnostic.ts";
import { compileGrammar } from "../../src/grammar/compile.ts";
import { parseGrammar } from "../../src/grammar/parse.ts";
import { defineLanguage } from "../../src/language.ts";
import { builtinFunctions, signature } from "./builtins.ts";
import { check, type ShadeModule } from "./check.ts";
import { runtime } from "./emit.ts";
import { surface } from "./surface.ts";
import type { File } from "./shade.ast.ts";
import { show, type Ty } from "./types.ts";
import { wgsl } from "./wgsl.ts";
import sourceText from "./shade.parl.ts";

const parsed = parseGrammar(sourceText, "shade.parl");
if (!parsed.ok) throw new Error(parsed.diagnostics.map((entry: Diagnostic) => entry.message).join("\n"));
export const grammar = compileGrammar<File>(parsed.file, "shade.parl");
if (!grammar.valid) throw new Error(grammar.diagnostics.map((entry) => entry.message).join("\n"));

export const shade = defineLanguage<File, ShadeModule, Ty>({
  name: "shade",
  extensions: [".gpu"],
  embed: { tag: "gpu" },
  grammar,
  check: (file, cx) => check(file, cx, grammar.bind!),
  typescript: surface,
  runtime,
  targets: {
    wgsl: (module) => ({ text: wgsl(module), fileName: "shader.wgsl" }),
  },
  // A struct's hover shows its layout.
  show: (type) =>
    type.k === "type" && type.of.k === "struct" ? `struct ${type.of.name} (size ${type.of.size}, align ${type.of.align})` : show(type),
  completions: builtinFunctions.map((name) => ({ label: name, kind: "function" as const, detail: signature(name) })),
  describe: (binding) => {
    const type = binding.type;
    if (type === undefined) return undefined;
    if (type.k === "fn") return `fn ${binding.name}${show(type).slice(2)}`;
    if (type.k === "entry") return `compute ${binding.name}[${type.size.join(", ")}]`;
    if (type.k === "type" && type.of.k === "struct") return `struct ${binding.name} (size ${type.of.size}, align ${type.of.align})`;
    return `${binding.kind === "parameter" ? "param" : binding.detail === "field" ? "field" : binding.kind} ${binding.name}: ${show(type)}`;
  },
});
