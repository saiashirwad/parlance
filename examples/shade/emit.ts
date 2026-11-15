/**
 * Compiles checked shade IR to an ES module for the Node loader. Kernels become JavaScript
 * functions over DataViews; statements and bounds checks map back to guest spans, so a stack
 * trace under --enable-source-maps points into the .gpu file.
 */
import type { Span } from "../../src/source.ts";
import { synth, ts, type TsDoc } from "../../src/ts/index.ts";
import type { Expr, ShadeModule, Stmt } from "./check.ts";
import type { Desc } from "./runtime.ts";
import { elementOf, layoutOf, roundUp, type Scalar, show, strideOf, type Ty } from "./types.ts";
import { wgsl } from "./wgsl.ts";

const runtimeUrl = new URL("./runtime.ts", import.meta.url).href;

export const describe = (type: Ty): Desc => {
  switch (type.k) {
    case "scalar":
      return { k: "scalar", s: type.s };
    case "vec":
      return { k: "vec", n: type.n, s: type.s };
    case "mat": {
      const column = layoutOf({ k: "vec", n: type.r, s: "f32" })!;
      return { k: "mat", c: type.c, r: type.r, stride: roundUp(column.align, column.size) };
    }
    case "array":
      return { k: "array", element: describe(type.element), n: type.n, stride: layoutOf(type.element) ? strideOf(type.element) : 0, name: show(type) };
    case "struct":
      return {
        k: "struct",
        name: type.name,
        size: type.size,
        align: type.align,
        fields: type.fields.map((field) => ({ name: field.name, offset: field.offset, size: field.size, type: describe(field.type), wgsl: show(field.type) })),
      };
    default:
      return { k: "scalar", s: "f32" };
  }
};

const element = (type: Ty): Scalar => {
  const value = elementOf(type);
  return value === "int" ? "i32" : value === "float" ? "f32" : value ?? "f32";
};

const composite = (type: Ty): boolean => type.k === "vec" || type.k === "mat" || type.k === "array" || type.k === "struct";

export const runtime = (module: ShadeModule): TsDoc => {
  const table: Desc[] = [];
  const keys = new Map<string, number>();
  const desc = (type: Ty): string => {
    const key = show(type);
    let index = keys.get(key);
    if (index === undefined) {
      index = table.length;
      table.push(describe(type));
      keys.set(key, index);
    }
    return `$t[${index}]`;
  };
  const local = (name: string, id: number): string => `${name}_${id}`;
  const resources = new Map(module.resources.map((resource) => [resource.name.text, resource]));

  type Place = { readonly resource: string; readonly offset: TsDoc; readonly type: Ty };

  /** A place inside a bound buffer: the resource and a byte offset expression. */
  const place = (value: Expr): Place | null => {
    switch (value.k) {
      case "resource":
        return { resource: value.name, offset: ts`0`, type: value.type };
      case "field": {
        const base = place(value.base);
        if (!base || base.type.k !== "struct") return null;
        const field = base.type.fields.find((entry) => entry.name === value.name)!;
        return { ...base, offset: ts`${base.offset} + ${String(field.offset)}`, type: value.type };
      }
      case "index": {
        const base = place(value.base);
        if (!base) return null;
        const type = base.type;
        const [stride, length] = type.k === "array"
          ? [strideOf(type.element), type.n === null ? `$r.${base.resource}.count` : String(type.n)]
          : type.k === "vec"
          ? [4, String(type.n)]
          : type.k === "mat"
          ? [describe(type).k === "mat" ? (describe(type) as { stride: number }).stride : 16, String(type.c)]
          : [0, "0"];
        const index = ts`${synth("$.bound", value.span)}(${expr(value.index)}, ${length}, ${JSON.stringify(show(type))})`;
        return { ...base, offset: ts`${base.offset} + ${index} * ${String(stride)}`, type: value.type };
      }
      case "swizzle": {
        const base = place(value.base);
        if (!base || value.components.length !== 1) return null;
        return { ...base, offset: ts`${base.offset} + ${String(value.components[0]! * 4)}`, type: value.type };
      }
      default:
        return null;
    }
  };

  const load = (at: Place): TsDoc => ts`$.load($r.${at.resource}.view, ${at.offset}, ${desc(at.type)})`;

  /** A value that may alias a variable is copied before it is stored elsewhere. */
  const owned = (value: Expr): TsDoc => {
    const code = expr(value);
    const aliases = value.k === "local" || value.k === "field" || value.k === "index";
    return composite(value.type) && aliases && !(place(value) !== null) ? ts`$.clone(${code})` : code;
  };

  const scalarOp = (op: string, s: Scalar, a: TsDoc, b: TsDoc): TsDoc => {
    if (["==", "!=", "<", "<=", ">", ">="].includes(op)) return ts`(${a} ${op === "==" ? "===" : op === "!=" ? "!==" : op} ${b})`;
    if (op === "&&" || op === "||") return ts`(${a} ${op} ${b})`;
    if (s === "f32" && op !== "%") return ts`$.f(${a} ${op} ${b})`;
    if (s === "i32" && (op === "+" || op === "-")) return ts`((${a} ${op} ${b}) | 0)`;
    if (s === "u32" && (op === "+" || op === "-")) return ts`((${a} ${op} ${b}) >>> 0)`;
    return ts`$.op(${JSON.stringify(op)}, ${JSON.stringify(s)}, ${a}, ${b})`;
  };

  const binary = (op: string, s: Scalar, left: Ty, right: Ty, a: TsDoc, b: TsDoc): TsDoc => {
    if (op === "*" && left.k === "mat" && right.k === "vec") return ts`$.mulMV(${a}, ${b})`;
    if (op === "*" && left.k === "vec" && right.k === "mat") return ts`$.mulVM(${a}, ${b})`;
    if (op === "*" && left.k === "mat" && right.k === "mat") return ts`$.mulMM(${a}, ${b})`;
    const scalarish = (type: Ty) => type.k === "scalar" || type.k === "abstract";
    if (scalarish(left) && scalarish(right)) return scalarOp(op, s, a, b);
    return ts`$.op(${JSON.stringify(op)}, ${JSON.stringify(s)}, ${a}, ${b})`;
  };

  const literal = (value: number | boolean, type: Ty): string => {
    if (typeof value === "boolean") return String(value);
    const number = element(type) === "f32" ? Math.fround(value) : value;
    return Object.is(number, -0) ? "-0" : String(number);
  };

  const expr = (value: Expr): TsDoc => {
    switch (value.k) {
      case "lit":
        return ts`${literal(value.value, value.type)}`;
      case "local":
        return ts`${local(value.name, value.id)}`;
      case "input":
        return ts`$in.${value.name}`;
      case "resource":
        return load(place(value)!);
      case "field": {
        const at = place(value);
        if (at) return load(at);
        return ts`${expr(value.base)}[${JSON.stringify(value.name)}]`;
      }
      case "index": {
        const at = place(value);
        if (at) return load(at);
        const type = value.base.type;
        const length = type.k === "vec" ? type.n : type.k === "mat" ? type.c : type.k === "array" ? type.n ?? 0 : 0;
        return ts`${expr(value.base)}[${synth("$.bound", value.span)}(${expr(value.index)}, ${String(length)}, ${JSON.stringify(show(type))})]`;
      }
      case "swizzle":
        return value.components.length === 1
          ? ts`${expr(value.base)}[${String(value.components[0])}]`
          : ts`$.swizzle(${expr(value.base)}, [${value.components.join(", ")}])`;
      case "call":
        return ts`${synth(`fn_${value.name}`, value.span)}(${value.args.map((arg, index) => ts`${index ? ", " : ""}${expr(arg)}`)})`;
      case "builtin": {
        const s = JSON.stringify(element(value.params[0] ?? value.type));
        return ts`$.builtins.${value.name}(${s}${value.args.map((arg) => ts`, ${expr(arg)}`)})`;
      }
      case "len":
        return ts`$r.${value.name}.count`;
      case "unary": {
        const operand = expr(value.operand);
        if (value.op === "!") return value.operand.type.k === "vec" ? ts`$.not(${operand})` : ts`(!${operand})`;
        return ts`$.neg(${JSON.stringify(value.element)}, ${operand})`;
      }
      case "binary":
        return binary(value.op, value.element, value.left.type, value.right.type, expr(value.left), expr(value.right));
      case "construct":
        return construct(value);
    }
  };

  const construct = (value: Extract<Expr, { k: "construct" }>): TsDoc => {
    const type = value.type;
    const args = value.args;
    switch (value.form) {
      case "zero":
        return ts`$.zero(${desc(type)})`;
      case "convert": {
        if (type.k === "mat") return ts`$.clone(${expr(args[0]!)})`;
        return ts`$.convert(${JSON.stringify(element(type))}, ${JSON.stringify(element(args[0]!.type))}, ${expr(args[0]!)})`;
      }
      case "splat":
        return ts`$.convert(${JSON.stringify(element(type))}, ${JSON.stringify(element(args[0]!.type))}, Array(${String(type.k === "vec" ? type.n : 1)}).fill(${expr(args[0]!)}))`;
      case "parts": {
        const list = ts`[${args.map((arg, index) => ts`${index ? ", " : ""}${owned(arg)}`)}]`;
        if (type.k === "vec") return ts`$.convert(${JSON.stringify(type.s)}, ${JSON.stringify(type.s)}, $.parts(${list}))`;
        if (type.k === "mat") return args.length === type.c ? list : ts`$.columns(${String(type.c)}, ${String(type.r)}, ${list})`;
        if (type.k === "struct") {
          return ts`{ ${type.fields.map((field, index) => ts`${index ? ", " : ""}${JSON.stringify(field.name)}: ${owned(args[index]!)}`)} }`;
        }
        return list;
      }
    }
  };

  const mapped = (keyword: string, span: Span): TsDoc => ts`${synth(keyword, span)}`;

  const block = (statements: readonly Stmt[], indent: string): TsDoc =>
    ts`{${"\n"}${statements.map((entry) => statement(entry, `${indent}  `))}${indent}}`;

  const statement = (value: Stmt, indent: string): TsDoc => {
    switch (value.k) {
      case "let":
      case "var": {
        const init = value.init ? owned(value.init) : ts`$.zero(${desc(value.type)})`;
        return ts`${indent}${mapped(value.k === "let" ? "const" : "let", value.span)} ${local(value.name, value.id)} = ${init};${"\n"}`;
      }
      case "assign": {
        const at = place(value.target);
        if (at) {
          const next = value.element === null ? owned(value.value) : binary(value.op, value.element, value.target.type, value.value.type, load(at), expr(value.value));
          return ts`${indent}${synth("$.store", value.span)}($r.${at.resource}.view, ${at.offset}, ${desc(at.type)}, ${next});${"\n"}`;
        }
        const target = expr(value.target);
        const next = value.element === null ? owned(value.value) : binary(value.op, value.element, value.target.type, value.value.type, target, expr(value.value));
        return ts`${indent}${target} ${synth("=", value.span)} ${next};${"\n"}`;
      }
      case "if":
        return ts`${indent}${mapped("if", value.span)} (${expr(value.cond)}) ${block(value.then, indent)}${value.otherwise ? ts` else ${block(value.otherwise, indent)}` : ""}${"\n"}`;
      case "while":
        return ts`${indent}${mapped("while", value.span)} (${expr(value.cond)}) ${block(value.body, indent)}${"\n"}`;
      case "for": {
        const name = local(value.name, value.id);
        const step = element(value.type) === "u32" ? `(${name} + 1) >>> 0` : `(${name} + 1) | 0`;
        return ts`${indent}${mapped("for", value.span)} (let ${name} = ${expr(value.from)}; ${name} < ${expr(value.to)}; ${name} = ${step}) ${block(value.body, indent)}${"\n"}`;
      }
      case "return":
        return ts`${indent}${mapped("return", value.span)}${value.value ? ts` ${owned(value.value)}` : ""};${"\n"}`;
      case "break":
      case "continue":
        return ts`${indent}${mapped(value.k, value.span)};${"\n"}`;
      case "expr":
        return ts`${indent}${expr(value.value)};${"\n"}`;
      case "block":
        return ts`${indent}${block(value.body, indent)}${"\n"}`;
    }
  };

  const fns = module.fns.map((fn) =>
    ts`${mapped("function", fn.name.span)} fn_${fn.name.text}(${fn.params.map((param) => local(param.name, param.id)).join(", ")}) ${block(fn.body, "")}${"\n"}`
  );
  const kernels = module.kernels.map((kernel) =>
    ts`${mapped("function", kernel.name.span)} k_${kernel.name.text}($in) ${block(kernel.body, "")}${"\n"}`
  );
  const structs = module.structs.filter((struct) => struct.type.shareable).map((struct) =>
    ts`export const ${synth(struct.name.text, struct.name.span)} = $.struct(${desc(struct.type)});${"\n"}`
  );
  const bindingInfo = module.resources.map((resource) => {
    const layout = layoutOf(resource.type);
    const minSize = resource.type.k === "array" && resource.type.n === null ? strideOf(resource.type.element) : layout?.size ?? 0;
    return { resource, minSize };
  });
  const bindings = bindingInfo.map(({ resource, minSize }) =>
    ts`  ${synth(resource.name.text, resource.name.span)}: Object.freeze({ group: ${String(resource.group)}, binding: ${String(resource.binding)}, space: "${resource.space}", access: "${resource.access}", type: ${JSON.stringify(show(resource.type))}, minSize: ${String(minSize)} }),${"\n"}`
  );
  const bindingDescs = bindingInfo.map(({ resource, minSize }) =>
    `  { name: ${JSON.stringify(resource.name.text)}, space: "${resource.space}", access: "${resource.access}", type: ${desc(resource.type)}, minSize: ${minSize} },${"\n"}`
  );
  const entries = module.kernels.map((kernel) =>
    ts`  ${synth(kernel.name.text, kernel.name.span)}: Object.freeze({ stage: "compute", workgroupSize: Object.freeze([${kernel.size.join(", ")}]) }),${"\n"}`
  );
  const kernelTable = module.kernels.map((kernel) =>
    `  ${JSON.stringify(kernel.name.text)}: { name: ${JSON.stringify(kernel.name.text)}, size: [${kernel.size.join(", ")}], run: k_${kernel.name.text} },${"\n"}`
  );
  // `$t` is filled while the body is generated, so the body is built before the module text.
  const body = ts`${structs}export const bindings = Object.freeze({
${bindings}});
export const entryPoints = Object.freeze({
${entries}});
const $bindings = [
${bindingDescs.join("")}];
const $r = {};
${fns}${kernels}const $kernels = {
${kernelTable.join("")}};
export function dispatch(entry, workgroups, buffers) {
  const kernel = Object.hasOwn($kernels, entry) ? $kernels[entry] : undefined;
  if (!kernel) throw new TypeError("Unknown entry point " + JSON.stringify(entry) + "; expected one of: ${module.kernels.map((kernel) => kernel.name.text).join(", ")}");
  $.dispatch(kernel, workgroups, buffers, $bindings, $r);
}
`;
  return ts`import * as $ from ${JSON.stringify(runtimeUrl)};
const $t = ${JSON.stringify(table)};
export const wgsl = ${JSON.stringify(wgsl(module))};
${body}`;
};
