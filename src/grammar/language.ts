import { readFileSync } from "node:fs";
import { type Binding, type Checker } from "../check/index.ts";
import { defineLanguage } from "../language.ts";
import type { Text } from "../source.ts";
import type {
  Alternative,
  Body,
  GrammarFile,
  Primary,
  Rule,
  Unary,
} from "./ast.ts";
import { compileGrammar } from "./compile.ts";
import { parseGrammar } from "./parse.ts";

export type GrammarType =
  | { readonly kind: "grammar"; readonly name: string }
  | { readonly kind: "rule"; readonly name: string }
  | { readonly kind: "token"; readonly name: string }
  | { readonly kind: "field"; readonly name: string }
  | { readonly kind: "tag"; readonly name: string };

const typeOf = (kind: GrammarType["kind"], name: string): GrammarType => ({ kind, name });
const typeText = (type: GrammarType): string => `${type.kind} ${type.name}`;

export type GrammarModule = {
  readonly name: Text;
  readonly valid: boolean;
  readonly rules: number;
  readonly tokens: number;
};

const sourceText = readFileSync(new URL("./grammar.parl", import.meta.url), "utf8");
const bootstrap = parseGrammar(sourceText, "src/grammar/grammar.parl");
if (!bootstrap.ok) {
  throw new Error(bootstrap.diagnostics.map((entry) => entry.message).join("\n"));
}
const grammar = compileGrammar<GrammarFile>(bootstrap.file, "src/grammar/grammar.parl");
if (!grammar.valid) {
  throw new Error(grammar.diagnostics.map((entry) => entry.message).join("\n"));
}

const check = (file: GrammarFile, cx: Checker<GrammarType>): GrammarModule => {
  const compiled = compileGrammar(file, cx.uri);
  for (const diagnostic of compiled.diagnostics) cx.facts.diagnostics.push(diagnostic);

  const grammarBinding = cx.declare(file.name.text, file.name.span, "namespace", typeOf("grammar", file.name.text));
  cx.bind(grammarBinding);
  cx.typed(file.name, grammarBinding.type!);

  const ruleBindings = new Map<string, Binding<GrammarType>>();
  const tokenBindings = new Map<string, Binding<GrammarType>>();
  for (const token of file.tokens) {
    const type = typeOf("token", token.name.text);
    const binding = cx.declare(token.name.text, token.name.span, "constant", type, { detail: "token" });
    cx.bind(binding);
    tokenBindings.set(token.name.text, binding);
    cx.typed(token.name, type);
  }
  for (const rule of file.rules) {
    const type = typeOf("rule", rule.name.text);
    const binding = cx.declare(rule.name.text, rule.name.span, "function", type, { detail: "rule" });
    cx.bind(binding);
    ruleBindings.set(rule.name.text, binding);
    cx.typed(rule.name, type);
  }

  const reference = (kind: "rule" | "token", name: Text): void => {
    const binding = (kind === "rule" ? ruleBindings : tokenBindings).get(name.text);
    if (!binding) return;
    cx.reference(binding, name);
    cx.typed(name, binding.type ?? typeOf(kind, name.text));
  };

  if (file.root) reference("rule", file.root.rule);

  const walkUnary = (unary: Unary): void => {
    switch (unary.kind) {
      case "and":
      case "not":
        walkUnary(unary.expr);
        return;
      case "star":
      case "plus":
      case "opt":
        walkPrimary(unary.expr);
        return;
      case "error":
        return;
      default:
        walkPrimary(unary);
    }
  };

  const walkPrimary = (primary: Primary): void => {
    switch (primary.kind) {
      case "token":
        reference("token", primary.name);
        return;
      case "ref":
        reference("rule", primary.name);
        return;
      case "group":
        walkAlternatives(primary.alts);
        return;
      case "sep":
      case "sep1":
      case "sepEnd":
      case "sepEnd1":
        walkUnary(primary.item);
        walkUnary(primary.separator);
        return;
      case "lit":
      case "re":
      case "word":
      case "cut":
        return;
    }
  };

  const walkAlternatives = (alternatives: readonly Alternative[]): void => {
    for (const alternative of alternatives) {
      if (alternative.tag) cx.typed(alternative.tag, typeOf("tag", alternative.tag.text));
      for (const item of alternative.items) {
        if (item.label) cx.typed(item.label, typeOf("field", item.label.text));
        walkUnary(item.expr);
      }
    }
  };

  const walkBody = (body: Body): void => {
    if (body.kind === "alternatives") {
      walkAlternatives(body.alts);
      return;
    }
    if (body.kind === "error") return;
    for (const level of body.levels) for (const operator of level.operators) walkUnary(operator);
    walkAlternatives(body.atom);
  };

  for (const rule of file.rules as readonly Rule[]) walkBody(rule.body);

  return {
    name: file.name,
    valid: compiled.valid,
    rules: file.rules.length,
    tokens: file.tokens.length,
  };
};

export const grammarLanguage = defineLanguage<GrammarFile, GrammarModule, GrammarType>({
  name: "grammar",
  extensions: [".parl"],
  grammar,
  check,
  checkPartial: false,
  show: typeText,
  describe: (binding) => binding.type === undefined ? undefined : typeText(binding.type),
});
