import { readFileSync } from "node:fs";
import { type Binding, type Checker, type Spanned } from "../../src/check/index.ts";
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

/** `result` holds the type of the expression just checked. */
type ExprContext = { readonly cx: Checker<Type>; readonly store: TypeStore; result: Type };

const expectNumber = (context: ExprContext, type: Type, at: Spanned): void => {
  const mark = context.store.mark();
  if (context.store.unify(type, num(context.store))) return;
  context.store.restore(mark);
  context.cx.error(`Expected number, found ${display(context.store, type)}`, at);
};

const checkExpr = (expr: Expr, context: ExprContext): CalcExpr => {
  const { cx, store } = context;
  switch (expr.kind) {
    case "number": {
      const value = Number(expr.value.text);
      const type = store.literal(value);
      cx.typed(expr, type);
      context.result = type;
      return { kind: "number", value };
    }
    case "boolean": {
      const value = expr.value.text === "true";
      const type = store.literal(value);
      cx.typed(expr, type);
      context.result = type;
      return { kind: "boolean", value };
    }
    case "name": {
      const binding = cx.resolve(expr.value.text, expr.value.span);
      if (!binding) {
        cx.error(`Unknown name ${JSON.stringify(expr.value.text)}`, expr.value);
        const type = store.unknown();
        context.result = type;
        return { kind: "number", value: 0 };
      }
      const type = binding.type ?? store.unknown();
      cx.typed(expr, type);
      context.result = type;
      return { kind: "name", binding };
    }
    case "binary": {
      const left = checkExpr(expr.left, context);
      const leftType = context.result;
      const right = checkExpr(expr.right, context);
      const rightType = context.result;
      const operator = expr.operator.text;
      if (operator === "==" || operator === "!=") {
        if (!sameKind(store, leftType, rightType)) {
          cx.error(
            `Cannot compare ${display(store, leftType)} with ${display(store, rightType)}`,
            expr.operator,
          );
        }
        const type = boolean(store);
        cx.typed(expr, type);
        context.result = type;
        return { kind: "binary", operator, left, right };
      }
      expectNumber(context, leftType, expr.left);
      expectNumber(context, rightType, expr.right);
      const type = num(store);
      cx.typed(expr, type);
      context.result = type;
      return { kind: "binary", operator, left, right };
    }
    case "prefix": {
      const operand = checkExpr(expr.operand, context);
      const operandType = context.result;
      const operator = expr.operator.text;
      const expected = operator === "!" ? boolean(store) : num(store);
      const mark = store.mark();
      if (!store.unify(operandType, expected)) {
        store.restore(mark);
        cx.error(`Expected ${display(store, expected)}, found ${display(store, operandType)}`, expr.operand);
      }
      const type = operator === "!" ? boolean(store) : num(store);
      cx.typed(expr, type);
      context.result = type;
      return { kind: "prefix", operator, operand };
    }
    case "postfix": {
      cx.error("Postfix operators are not defined in calc", expr);
      const type = store.unknown();
      context.result = type;
      return { kind: "number", value: 0 };
    }
  }
};

const check = (file: File, cx: Checker<Type>): CalcModule => {
  const store = new TypeStore();
  const context: ExprContext = { cx, store, result: store.unknown() };
  const declarations: CalcDecl[] = [];
  const imports: CalcImport[] = [];
  let result: CalcExpr | null = null;
  let resultType: Type | null = null;
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
      bindings.push({ exported: name, binding });
    }
    if (bindings.length > 0) imports.push({ specifier: dependency.specifier, bindings });
  }
  for (let index = 0; index < file.declarations.length; index++) {
    const declaration = file.declarations[index]!;
    if (declaration.kind === "import") continue;
    if (declaration.kind === "let") {
      const name = declaration.name;
      if (reserved.has(name.text)) {
        cx.error(`${JSON.stringify(name.text)} is reserved in TypeScript and JavaScript`, name);
        continue;
      }
      if (cx.resolve(name.text, undefined)) {
        cx.error(`Duplicate name ${JSON.stringify(name.text)}`, name);
        continue;
      }
      const value = checkExpr(declaration.value, context);
      const valueType = context.result;
      const binding = cx.declare(name.text, name.span, "variable", valueType);
      cx.bind(binding);
      cx.typed(name, valueType);
      declarations.push({ kind: "let", name, binding, value });
    } else {
      const value = checkExpr(declaration.value, context);
      declarations.push({ kind: "show", value });
      result = value;
      resultType = context.result;
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
