import { readFileSync } from "node:fs";
import { bind, type Binding, type Bound, type Checker, type ForeignModule, type Spanned } from "../../src/check/index.ts";
import { type Diagnostic, error } from "../../src/diagnostic.ts";
import { compileGrammar } from "../../src/grammar/compile.ts";
import { parseGrammar } from "../../src/grammar/parse.ts";
import { defineLanguage, importSpecifier } from "../../src/language.ts";
import type { Span, Text } from "../../src/source.ts";
import { foreignImports, foreignRuntime, source, synth, ts, type TsDoc } from "../../src/ts/index.ts";
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
  | { readonly span: Span; readonly kind: "number"; readonly value: number }
  | { readonly span: Span; readonly kind: "boolean"; readonly value: boolean }
  | { readonly span: Span; readonly kind: "name"; readonly binding: Binding<Type> }
  | { readonly span: Span; readonly kind: "binary"; readonly operator: string; readonly left: CalcExpr; readonly right: CalcExpr }
  | { readonly span: Span; readonly kind: "prefix"; readonly operator: string; readonly operand: CalcExpr };

type CalcDecl =
  | {
    readonly span: Span;
    readonly kind: "let";
    readonly name: Text;
    readonly binding: Binding<Type>;
    readonly value: CalcExpr;
    readonly valueSpan: Span;
  }
  | { readonly span: Span; readonly kind: "show"; readonly value: CalcExpr; readonly valueSpan: Span };

type CalcImport = {
  readonly specifier: string;
  readonly bindings: readonly { readonly exported: string; readonly binding: Binding<Type> }[];
};

export type CalcModule = {
  readonly source: string;
  /** Names imported from TypeScript; their type is opaque here and tsgo checks them. */
  readonly foreign: readonly ForeignModule<Type>[];
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
type ExprContext = { readonly cx: Checker<Type>; readonly bound: Bound<Type>; readonly store: TypeStore; result: Type };

const expectNumber = (context: ExprContext, type: Type, at: Spanned): void => {
  const mark = context.store.mark();
  if (context.store.unify(type, num(context.store))) return;
  context.store.restore(mark);
  context.cx.error(`Expected number, found ${display(context.store, type)}`, at);
};

const checkExpr = (expr: Expr, context: ExprContext): CalcExpr => {
  const { cx, store } = context;
  switch (expr.kind) {
    case "error": {
      // The parser reported the missing expression; error unifies with anything, so nothing cascades.
      context.result = store.error();
      return { span: expr.span, kind: "number", value: 0 };
    }
    case "number": {
      const value = Number(expr.value.text);
      const type = store.literal(value);
      cx.typed(expr, type);
      context.result = type;
      return { span: expr.span, kind: "number", value };
    }
    case "boolean": {
      const value = expr.value.text === "true";
      const type = store.literal(value);
      cx.typed(expr, type);
      context.result = type;
      return { span: expr.span, kind: "boolean", value };
    }
    case "name": {
      // `bind` resolved the name, or reported it unknown.
      const binding = context.bound.resolved(expr.value);
      if (!binding) {
        const type = store.unknown();
        context.result = type;
        return { span: expr.span, kind: "number", value: 0 };
      }
      if (binding.runtime === false) {
        cx.error(`${JSON.stringify(binding.name)} is not available at runtime`, expr.value);
      }
      const type = binding.type ?? store.unknown();
      cx.typed(expr, type);
      context.result = type;
      return { span: expr.span, kind: "name", binding };
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
        return { span: expr.span, kind: "binary", operator, left, right };
      }
      expectNumber(context, leftType, expr.left);
      expectNumber(context, rightType, expr.right);
      const type = num(store);
      cx.typed(expr, type);
      context.result = type;
      return { span: expr.span, kind: "binary", operator, left, right };
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
      return { span: expr.span, kind: "prefix", operator, operand };
    }
    case "postfix": {
      cx.error("Postfix operators are not defined in calc", expr);
      const type = store.unknown();
      context.result = type;
      return { span: expr.span, kind: "number", value: 0 };
    }
  }
};

const check = (file: File, cx: Checker<Type>): CalcModule => {
  const store = new TypeStore();
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
      // A type or model has no runtime export; the runtime module imports only values.
      if (exported.runtime !== false) bindings.push({ exported: exported.runtime ?? name, binding });
    }
    if (bindings.length > 0) imports.push({ specifier: dependency.specifier, bindings });
  }
  // Names from TypeScript: opaque to this checker, so uses never report; tsgo checks them.
  const foreign = cx.foreign(store.unknown());
  const bound = bind(file, cx, grammar.bind!, { accept: (name) => !reserved.has(name.text) });
  const context: ExprContext = { cx, bound, store, result: store.unknown() };
  for (let index = 0; index < file.declarations.length; index++) {
    const declaration = file.declarations[index]!;
    if (declaration.kind === "import" || declaration.kind === "tsimport") continue;
    if (declaration.kind === "let") {
      const name = declaration.name;
      if (reserved.has(name.text)) {
        cx.error(`${JSON.stringify(name.text)} is reserved in TypeScript and JavaScript`, name);
        continue;
      }
      // A duplicate has no binding; `bind` reported it.
      if (!bound.binding(declaration)) continue;
      const value = checkExpr(declaration.value, context);
      const valueType = context.result;
      if (cx.isMissing(name)) continue;
      const binding = bound.define(declaration, valueType)!;
      declarations.push({ span: declaration.span, kind: "let", name, binding, value, valueSpan: declaration.value.span });
    } else {
      const value = checkExpr(declaration.value, context);
      declarations.push({ span: declaration.span, kind: "show", value, valueSpan: declaration.value.span });
      result = value;
      resultType = context.result;
    }
  }
  return { source: cx.source, foreign, declarations, imports, result, resultType };
};

/**
 * Modules that use TypeScript names are emitted as real TypeScript: guest expression text is valid
 * TypeScript verbatim, so tsgo infers the types and reports errors at the guest span.
 */
const foreignSurface = (module: CalcModule) => {
  let shows = 0;
  let last: string | null = null;
  const imports = module.imports.map((group) =>
    ts`import { ${
      group.bindings.map(({ exported, binding }) => exported === binding.name ? exported : `${exported} as ${binding.name}`)
        .join(", ")
    } } from ${JSON.stringify(group.specifier)};
`
  );
  return ts`${foreignImports(module.foreign)}${imports}${
    module.declarations.map((declaration) => {
      const body = source(module.source.slice(declaration.valueSpan.start, declaration.valueSpan.end), declaration.valueSpan);
      if (declaration.kind === "let") {
        return ts`export const ${source(declaration.name)} = ${body};
`;
      }
      last = `_show${shows}`;
      return ts`const _show${shows++} = ${body};
`;
    })
  }${last ? `export default ${last};
` : ""}`;
};

const types = (module: CalcModule) => {
  if (module.foreign.some((group) => group.names.length > 0)) return foreignSurface(module);
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

/** Emits ES module text mapped to guest spans, so stacks from a running module point at the .calc file. */
const runtime = (module: CalcModule): TsDoc => {
  const names = new Map<number, string>();
  let index = 0;
  const temp = (binding: Binding<Type>): string => {
    const known = names.get(binding.id);
    if (known) return known;
    const name = `_v${index++}`;
    names.set(binding.id, name);
    return name;
  };
  const expr = (value: CalcExpr): TsDoc => {
    switch (value.kind) {
      case "number":
      case "boolean":
        return ts`${synth(String(value.value), value.span)}`;
      case "name":
        return ts`${synth(temp(value.binding), value.span)}`;
      case "binary": {
        const operator = value.operator === "==" ? "===" : value.operator === "!=" ? "!==" : value.operator;
        return ts`${synth("(", value.span)}${expr(value.left)} ${operator} ${expr(value.right)})`;
      }
      case "prefix":
        return ts`${synth(`(${value.operator}`, value.span)}${expr(value.operand)})`;
    }
  };
  const foreignLines = foreignRuntime(module.foreign, temp);
  const importLines = module.imports.map((group) => {
    const pairs = group.bindings.map(({ exported, binding }) => {
      const local = temp(binding);
      return exported === local ? local : `${exported} as ${local}`;
    });
    return ts`import { ${pairs.join(", ")} } from ${JSON.stringify(group.specifier)};${"\n"}`;
  });
  const lines: TsDoc[] = [];
  const exported: string[] = [];
  let last: string | null = null;
  let shows = 0;
  for (const declaration of module.declarations) {
    if (declaration.kind === "let") {
      const name = temp(declaration.binding);
      lines.push(ts`${synth("const", declaration.span)} ${name} = ${expr(declaration.value)};${"\n"}`);
      exported.push(`${name} as ${JSON.stringify(declaration.name.text)}`);
      last = name;
    } else {
      const name = `_show${shows++}`;
      lines.push(ts`${synth("const", declaration.span)} ${name} = ${expr(declaration.value)};${"\n"}`);
      lines.push(ts`${synth("console.log", declaration.span)}(${name});${"\n"}`);
      last = name;
    }
  }
  return ts`${foreignLines}${importLines}${lines}${exported.length ? `export { ${exported.join(", ")} };${"\n"}` : ""}${
    last ? `export default ${last};${"\n"}` : ""
  }`;
};

export const calc = defineLanguage<File, CalcModule, Type>({
  name: "calc",
  extensions: [".calc"],
  grammar,
  check,
  foreign: (file) =>
    file.declarations.flatMap((entry) =>
      entry.kind === "tsimport"
        ? [{
          specifier: importSpecifier(entry.specifier),
          names: entry.names.flatMap((name) => name.text === "" ? [] : [{ name: name.text, span: name.span }]),
        }]
        : []
    ),
  exports: (module) =>
    module.declarations.flatMap((declaration) => declaration.kind === "let" ? [declaration.binding] : []),
  typescript: types,
  runtime,
  show: (type) => new TypeStore().show(type),
  describe: (binding) =>
    binding.type === undefined ? undefined : `${binding.kind} ${binding.name}: ${new TypeStore().show(binding.type)}`,
});
