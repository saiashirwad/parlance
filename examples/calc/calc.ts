import { readFileSync } from "node:fs";
import { type Binding, type Checker } from "../../src/check/index.ts";
import { type Diagnostic, error } from "../../src/diagnostic.ts";
import { compileGrammar } from "../../src/grammar/compile.ts";
import { parseGrammar } from "../../src/grammar/parse.ts";
import { defineLanguage, importSpecifier } from "../../src/language.ts";
import type { Span, Text } from "../../src/source.ts";
import { source, ts } from "../../src/ts/index.ts";
import { TypeStore, type Type } from "../../src/types/index.ts";
import type { BooleanLit, Decl, Expr, File, Name } from "./calc.ast.ts";

const sourceText = readFileSync(new URL("./calc.parl", import.meta.url), "utf8");
const parsed = parseGrammar(sourceText, "calc.parl");
if (!parsed.ok) throw new Error(parsed.diagnostics.map((entry: Diagnostic) => entry.message).join("\n"));
const grammar = compileGrammar<File>(parsed.file, "calc.parl");
if (!grammar.valid) throw new Error(grammar.diagnostics.map((entry) => entry.message).join("\n"));

const reserved = new Set(
  ("break case catch class const continue debugger default delete do else enum export extends false finally for "
    + "function if import in instanceof new null return super switch this throw true try typeof var void while with "
    + "yield let static implements interface package private protected public await").split(" "),
);

type CalcExpr =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "name"; readonly binding: Binding<Type> }
  | { readonly kind: "binary"; readonly operator: string; readonly left: CalcExpr; readonly right: CalcExpr }
  | { readonly kind: "prefix"; readonly operator: string; readonly operand: CalcExpr };

type CalcDecl =
  | { readonly kind: "let"; readonly name: Text; readonly binding: Binding<Type>; readonly value: CalcExpr }
  | { readonly kind: "show"; readonly value: CalcExpr };

type CalcImport = {
  readonly specifier: string;
  readonly bindings: readonly { readonly exported: string; readonly binding: Binding<Type> }[];
};

export type CalcModule = {
  readonly declarations: readonly CalcDecl[];
  readonly imports: readonly CalcImport[];
  readonly result: CalcExpr | null;
  readonly resultType: Type | null;
};

const num = (store: TypeStore): Type => store.number();
const boolean = (store: TypeStore): Type => store.boolean();

const display = (store: TypeStore, type: Type): string => {
  const value = store.prune(type);
  if (value.kind === "literal") return typeof value.value;
  if (value.kind === "variable") return "unknown";
  return store.show(value);
};

const sameKind = (store: TypeStore, left: Type, right: Type): boolean => {
  const a = store.prune(left);
  const b = store.prune(right);
  if (a.kind === "unknown" || b.kind === "unknown") return true;
  const base = (type: Type): string => type.kind === "literal" ? typeof type.value : type.kind;
  return base(a) === base(b) && ["number", "boolean", "string"].includes(base(a));
};

const checkExpr = (expr: Expr, cx: Checker<Type>, store: TypeStore): { ir: CalcExpr; type: Type } => {
  switch (expr.kind) {
    case "number": {
      const type = store.literal(Number(expr.value.text));
      cx.typed(expr, type);
      return { ir: { kind: "number", value: Number(expr.value.text) }, type };
    }
    case "boolean": {
      const value = expr.value.text === "true";
      const type = store.literal(value);
      cx.typed(expr, type);
      return { ir: { kind: "boolean", value }, type };
    }
    case "name": {
      const binding = cx.resolve(expr.value.text, expr.value.span);
      if (!binding) {
        cx.error(`Unknown name ${JSON.stringify(expr.value.text)}`, expr.value);
        return { ir: { kind: "number", value: 0 }, type: store.unknown() };
      }
      const type = binding.type ?? store.unknown();
      cx.typed(expr, type);
      return { ir: { kind: "name", binding }, type };
    }
    case "binary": {
      const left = checkExpr(expr.left, cx, store);
      const right = checkExpr(expr.right, cx, store);
      const operator = expr.operator.text;
      if (operator === "==" || operator === "!=") {
        if (!sameKind(store, left.type, right.type)) {
          cx.error(
            `Cannot compare ${display(store, left.type)} with ${display(store, right.type)}`,
            expr.operator,
          );
        }
        const type = boolean(store);
        cx.typed(expr, type);
        return { ir: { kind: "binary", operator, left: left.ir, right: right.ir }, type };
      }
      for (const [side, at] of [[left, expr.left], [right, expr.right]] as const) {
        const check = store.snapshot();
        if (!store.unify(side.type, num(store))) {
          check();
          cx.error(`Expected number, found ${display(store, side.type)}`, at);
        }
      }
      const type = num(store);
      cx.typed(expr, type);
      return { ir: { kind: "binary", operator, left: left.ir, right: right.ir }, type };
    }
    case "prefix": {
      const operand = checkExpr(expr.operand, cx, store);
      const operator = expr.operator.text;
      const expected = operator === "!" ? boolean(store) : num(store);
      const check = store.snapshot();
      if (!store.unify(operand.type, expected)) {
        check();
        cx.error(`Expected ${display(store, expected)}, found ${display(store, operand.type)}`, expr.operand);
      }
      const type = operator === "!" ? boolean(store) : num(store);
      cx.typed(expr, type);
      return { ir: { kind: "prefix", operator, operand: operand.ir }, type };
    }
    case "postfix": {
      cx.error("Postfix operators are not defined in calc", expr);
      return { ir: { kind: "number", value: 0 }, type: store.unknown() };
    }
  }
};

const check = (file: File, cx: Checker<Type>): CalcModule => {
  const store = new TypeStore();
  const declarations: CalcDecl[] = [];
  const imports: CalcImport[] = [];
  let result: CalcExpr | null = null;
  let resultType: Type | null = null;
  const names = new Set<string>();
  const importedFrom = new Map<string, string>();
  for (const dependency of cx.dependencies.all) {
    const bindings: { exported: string; binding: Binding<Type> }[] = [];
    for (const [name, exported] of dependency.exports) {
      const previous = importedFrom.get(name);
      if (previous !== undefined) {
        if (previous !== dependency.specifier) {
          cx.error(
            `Import ${JSON.stringify(dependency.specifier)} also exports ${JSON.stringify(name)}, already imported from ${
              JSON.stringify(previous)
            }`,
            dependency.span,
          );
        }
        continue;
      }
      const binding = cx.imported(name);
      if (!binding) continue;
      importedFrom.set(name, dependency.specifier);
      names.add(name);
      bindings.push({ exported: name, binding });
    }
    if (bindings.length > 0) imports.push({ specifier: dependency.specifier, bindings });
  }
  for (const declaration of file.declarations) {
    if (declaration.kind === "import") continue;
    if (declaration.kind === "let") {
      const name = declaration.name;
      if (reserved.has(name.text)) {
        cx.error(`${JSON.stringify(name.text)} is reserved in TypeScript and JavaScript`, name);
        continue;
      }
      if (names.has(name.text)) {
        cx.error(`Duplicate name ${JSON.stringify(name.text)}`, name);
        continue;
      }
      names.add(name.text);
      const value = checkExpr(declaration.value, cx, store);
      const binding = cx.declare(name.text, name.span, "variable", value.type);
      cx.bind(binding);
      cx.typed(name, value.type);
      declarations.push({ kind: "let", name, binding, value: value.ir });
    } else {
      const value = checkExpr(declaration.value, cx, store);
      declarations.push({ kind: "show", value: value.ir });
      result = value.ir;
      resultType = value.type;
    }
  }
  return { declarations, imports, result, resultType };
};

const types = (module: CalcModule) => {
  const show = (type: Type | null) => (type === null ? "unknown" : new TypeStore().show(type));
  return ts`${
    module.declarations.flatMap((declaration) =>
      declaration.kind === "let"
        ? [ts`export declare const ${source(declaration.name)}: ${show(declaration.binding.type ?? null)};
`]
        : []
    )
  }${
    module.resultType
      ? ts`declare const _default: ${show(module.resultType)};
export default _default;
`
      : ""
  }`;
};

const runtime = (module: CalcModule): string => {
  const names = new Map<number, string>();
  let index = 0;
  const lines: string[] = [];
  const temp = (binding: Binding<Type>): string => {
    const known = names.get(binding.id);
    if (known) return known;
    const name = `_v${index++}`;
    names.set(binding.id, name);
    return name;
  };
  const expr = (value: CalcExpr): string => {
    switch (value.kind) {
      case "number":
        return String(value.value);
      case "boolean":
        return String(value.value);
      case "name":
        return temp(value.binding);
      case "binary":
        return `(${expr(value.left)} ${value.operator === "==" ? "===" : value.operator === "!=" ? "!==" : value.operator} ${
          expr(value.right)
        })`;
      case "prefix":
        return `(${value.operator}${expr(value.operand)})`;
    }
  };
  const importLines = module.imports.map((group) => {
    const pairs = group.bindings.map(({ exported, binding }) => {
      const local = temp(binding);
      return exported === local ? local : `${exported} as ${local}`;
    });
    return `import { ${pairs.join(", ")} } from ${JSON.stringify(group.specifier)};`;
  });
  const exported: string[] = [];
  let last: string | null = null;
  let shows = 0;
  for (const declaration of module.declarations) {
    if (declaration.kind === "let") {
      const name = temp(declaration.binding);
      lines.push(`const ${name} = ${expr(declaration.value)};`);
      exported.push(`${name} as ${JSON.stringify(declaration.name.text)}`);
      last = name;
    } else {
      const name = `_show${shows++}`;
      lines.push(`const ${name} = ${expr(declaration.value)};`);
      lines.push(`console.log(${name});`);
      last = name;
    }
  }
  if (exported.length) lines.push(`export { ${exported.join(", ")} };`);
  if (last) lines.push(`export default ${last};`);
  return [...importLines, ...lines].join("\n") + "\n";
};

export const calc = defineLanguage<File, CalcModule, Type>({
  name: "calc",
  extensions: [".calc"],
  grammar,
  check,
  imports: (file) =>
    file.declarations.flatMap((entry) => entry.kind === "import" ? [importSpecifier(entry.specifier)] : []),
  exports: (module) =>
    module.declarations.flatMap((declaration) => declaration.kind === "let" ? [declaration.binding] : []),
  typescript: types,
  runtime,
  show: (type) => new TypeStore().show(type),
  describe: (binding) =>
    binding.type === undefined ? undefined : `${binding.kind} ${binding.name}: ${new TypeStore().show(binding.type)}`,
});
