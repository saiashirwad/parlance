/** The shade checker: full static typing of structs, buffers, functions, and compute entry points. */
import { type Binding, bind, type BindSpec, type Bound, type Checker, didYouMean } from "../../src/check/index.ts";
import type { Fix } from "../../src/diagnostic.ts";
import type { Span, Text } from "../../src/source.ts";
import type * as Ast from "./shade.ast.ts";
import { builtinFunctions, isBuiltinFunction, resolveBuiltin, signature } from "./builtins.ts";
import {
  abstractFloat,
  abstractInt,
  accepts,
  bool,
  builtinTypes,
  concrete,
  elementOf,
  errorTy,
  f32,
  i32,
  isNumeric,
  layoutOf,
  roundUp,
  same,
  type Scalar,
  show,
  type StructField,
  type Ty,
  u32,
  uniformProblem,
  vec,
  voidTy,
  wgslKeywords,
  wgslReserved,
} from "./types.ts";

// ---------------------------------------------------------------------------------------------
// Checked IR

export type Expr = { readonly span: Span; readonly type: Ty } & (
  | { readonly k: "lit"; readonly value: number | boolean; readonly text: string }
  | { readonly k: "local"; readonly name: string; readonly id: number }
  | { readonly k: "resource"; readonly name: string }
  | { readonly k: "input"; readonly name: string }
  | { readonly k: "field"; readonly base: Expr; readonly name: string }
  | { readonly k: "swizzle"; readonly base: Expr; readonly components: readonly number[]; readonly text: string }
  | { readonly k: "index"; readonly base: Expr; readonly index: Expr }
  | { readonly k: "call"; readonly name: string; readonly args: readonly Expr[] }
  | { readonly k: "builtin"; readonly name: string; readonly args: readonly Expr[]; readonly params: readonly Ty[] }
  | {
    readonly k: "construct";
    readonly name: string;
    readonly form: "zero" | "convert" | "splat" | "parts";
    readonly args: readonly Expr[];
  }
  | { readonly k: "binary"; readonly op: string; readonly left: Expr; readonly right: Expr; readonly element: Scalar }
  | { readonly k: "unary"; readonly op: string; readonly operand: Expr; readonly element: Scalar }
  | { readonly k: "len"; readonly name: string; readonly stride: number }
);

export type Stmt = { readonly span: Span } & (
  | { readonly k: "let" | "var"; readonly name: string; readonly id: number; readonly type: Ty; readonly init: Expr | null }
  | { readonly k: "assign"; readonly op: string; readonly target: Expr; readonly value: Expr; readonly element: Scalar | null }
  | { readonly k: "if"; readonly cond: Expr; readonly then: readonly Stmt[]; readonly otherwise: readonly Stmt[] | null }
  | { readonly k: "while"; readonly cond: Expr; readonly body: readonly Stmt[] }
  | {
    readonly k: "for";
    readonly name: string;
    readonly id: number;
    readonly type: Ty;
    readonly from: Expr;
    readonly to: Expr;
    readonly body: readonly Stmt[];
  }
  | { readonly k: "return"; readonly value: Expr | null }
  | { readonly k: "break" | "continue" }
  | { readonly k: "expr"; readonly value: Expr }
  | { readonly k: "block"; readonly body: readonly Stmt[] }
);

export type StructDecl = { readonly name: Text; readonly type: Extract<Ty, { k: "struct" }>; readonly span: Span };

export type ResourceDecl = {
  readonly name: Text;
  readonly space: "uniform" | "storage";
  readonly access: "read" | "read_write";
  readonly group: number;
  readonly binding: number;
  readonly type: Ty;
  readonly span: Span;
};

export type FnDecl = {
  readonly name: Text;
  readonly params: readonly { readonly name: string; readonly id: number; readonly type: Ty }[];
  readonly result: Ty;
  readonly body: readonly Stmt[];
  readonly span: Span;
};

export type KernelDecl = {
  readonly name: Text;
  readonly size: readonly [number, number, number];
  /** Builtin inputs the body reads, in a fixed order. */
  readonly inputs: readonly string[];
  readonly body: readonly Stmt[];
  readonly span: Span;
};

export type ShadeModule = {
  readonly source: string;
  readonly structs: readonly StructDecl[];
  readonly resources: readonly ResourceDecl[];
  readonly fns: readonly FnDecl[];
  readonly kernels: readonly KernelDecl[];
};

/** Builtin inputs a compute entry point can read, and their WGSL builtin names. */
export const inputs: ReadonlyMap<string, { readonly type: Ty; readonly wgsl: string }> = new Map([
  ["global_id", { type: vec(3, "u32"), wgsl: "global_invocation_id" }],
  ["local_id", { type: vec(3, "u32"), wgsl: "local_invocation_id" }],
  ["workgroup_id", { type: vec(3, "u32"), wgsl: "workgroup_id" }],
  ["local_index", { type: u32, wgsl: "local_invocation_index" }],
  ["num_workgroups", { type: vec(3, "u32"), wgsl: "num_workgroups" }],
]);

// ---------------------------------------------------------------------------------------------

type Local = {
  readonly origin: "let" | "var" | "param" | "for" | "resource";
  readonly type: Ty;
  readonly node?: Ast.Stmt | Ast.Resource;
  readonly resource?: ResourceDecl;
};

type Body = {
  readonly result: Ty;
  readonly kernel: { readonly inputs: Set<string> } | null;
  readonly calls: Set<string>;
  loops: number;
};

const parseCount = (text: Text): number | null => {
  if (!/^\d+[iu]?$/.test(text.text)) return null;
  const value = Number.parseInt(text.text, 10);
  return Number.isSafeInteger(value) ? value : null;
};

const literal = (text: string): { type: Ty; value: number } | string => {
  if (/^0[xX]/.test(text)) {
    const suffix = /[iu]$/.test(text) ? text.at(-1)! : "";
    const value = Number.parseInt(text.slice(2, suffix ? -1 : undefined), 16);
    return integer(value, suffix, text);
  }
  if (/^\d+[iu]?$/.test(text)) {
    const suffix = /[iu]$/.test(text) ? text.at(-1)! : "";
    return integer(Number.parseInt(text, 10), suffix, text);
  }
  const float = text.endsWith("f");
  const value = Number.parseFloat(float ? text.slice(0, -1) : text);
  if (!Number.isFinite(Math.fround(value))) return `${text} does not fit in f32`;
  return { type: float ? f32 : abstractFloat, value };
};

const integer = (value: number, suffix: string, text: string): { type: Ty; value: number } | string => {
  if (suffix === "u") return value > 0xffffffff ? `${text} does not fit in u32` : { type: u32, value };
  if (suffix === "i") return value > 0x7fffffff ? `${text} does not fit in i32` : { type: i32, value };
  return value > 0xffffffff ? `${text} is too large for a 32-bit integer` : { type: abstractInt, value };
};

const swizzleSets = ["xyzw", "rgba"] as const;

/** One scalar type for an operation's operands, literals taking the other side's type. */
const element = (type: Ty): Scalar => {
  const value = elementOf(type);
  if (value === "int") return "i32";
  if (value === "float") return "f32";
  return value ?? "f32";
};

const withElement = (type: Ty, s: Scalar): Ty => type.k === "vec" ? vec(type.n, s) : { k: "scalar", s };

export const check = (file: Ast.File, cx: Checker<Ty>, spec: BindSpec): ShadeModule => {
  const reportName = (name: Text): boolean => {
    const text = name.text;
    let problem: string | null = null;
    if (wgslKeywords.has(text) || wgslReserved.has(text)) problem = `${JSON.stringify(text)} is reserved in WGSL; pick another name`;
    else if (text.startsWith("__")) problem = `Names starting with "__" are reserved in WGSL`;
    else if (builtinTypes.has(text)) problem = `${JSON.stringify(text)} names a builtin type; pick another name`;
    else if (isBuiltinFunction(text) || text === "len" || text === "arrayLength") problem = `${JSON.stringify(text)} names a builtin function; pick another name`;
    else if (inputs.has(text)) problem = `${JSON.stringify(text)} names a compute builtin input; pick another name`;
    if (problem === null) return true;
    cx.error(problem, name);
    return false;
  };
  const bound: Bound<Ty> = bind(file, cx, spec, {
    accept: (name, node) => (node as { kind: string }).kind === "field" || reportName(name),
    builtin: (name, label) =>
      label === "type" ? { k: "type", of: builtinTypes.get(name)! } : inputs.get(name)?.type,
  });

  const structNodes = file.items.filter((item): item is Ast.Struct => item.kind === "struct");
  const structTypes = new Map<Ast.Struct, Extract<Ty, { k: "struct" }> | "busy">();
  /** Field bindings per struct name, for go-to-definition on member access. */
  const fieldBindings = new Map<string, Map<string, Binding<Ty>>>();
  const locals = new Map<number, Local>();

  // ---- types ----------------------------------------------------------------------------------

  const structType = (node: Ast.Struct): Ty => {
    const known = structTypes.get(node);
    if (known === "busy") {
      cx.error(`Struct ${node.name.text} contains itself`, node.name);
      return errorTy;
    }
    if (known) return known;
    structTypes.set(node, "busy");
    const fields: StructField[] = [];
    const bindings = new Map<string, Binding<Ty>>();
    let offset = 0;
    let align = 1;
    let shareable = true;
    for (const field of node.fields) {
      const type = resolveType(field.type, "field");
      const binding = bound.binding(field);
      if (!binding) continue; // a duplicate field; bind reported it
      bindings.set(field.name.text, bound.define(field, type) ?? binding);
      const layout = layoutOf(type);
      if (layout === null && type.k !== "error") shareable = false;
      const natural = layout ?? { align: 4, size: 4 };
      let fieldAlign = natural.align;
      let fieldSize = natural.size;
      const attrs: { name: "align" | "size"; value: number }[] = [];
      for (const attr of field.attrs) {
        const value = attr.args.length === 1 ? parseCount(attr.args[0]!) : null;
        if (attr.name.text !== "align" && attr.name.text !== "size") {
          cx.error(`Unknown field attribute @${attr.name.text}; expected @align(n) or @size(n)`, attr.name);
          continue;
        }
        if (value === null) {
          cx.error(`@${attr.name.text} takes one integer`, attr);
          continue;
        }
        if (attr.name.text === "align") {
          if (value <= 0 || (value & (value - 1)) !== 0) cx.error(`@align(${value}) must be a power of two`, attr);
          else if (value < natural.align) cx.error(`@align(${value}) is below ${show(type)}'s alignment of ${natural.align}`, attr);
          else fieldAlign = value;
        } else if (value < natural.size) {
          cx.error(`@size(${value}) is below ${show(type)}'s size of ${natural.size}`, attr);
        } else fieldSize = value;
        attrs.push({ name: attr.name.text, value });
      }
      offset = roundUp(fieldAlign, offset);
      fields.push({ name: field.name.text, type, offset, align: fieldAlign, size: fieldSize, attrs });
      offset += fieldSize;
      align = Math.max(align, fieldAlign);
    }
    if (node.fields.length === 0) cx.error(`Struct ${node.name.text} needs at least one field`, node.name);
    const type = { k: "struct", name: node.name.text, fields, align, size: roundUp(align, offset), shareable } as const;
    structTypes.set(node, type);
    fieldBindings.set(node.name.text, bindings);
    bound.define(node, { k: "type", of: type });
    return type;
  };

  /** `where` says which positions accept a runtime-sized array: only a storage buffer's type. */
  const resolveType = (node: Ast.Type, where: "storage" | "field" | "value"): Ty => {
    switch (node.kind) {
      case "error":
        return errorTy;
      case "typeName": {
        const builtin = bound.builtin(node.name);
        if (builtin !== undefined) return builtinTypes.get(builtin)!;
        const target = bound.target<Ast.Struct>(node.name);
        if (target?.kind === "struct") return structType(target);
        return errorTy; // unknown; bind reported it
      }
      case "arrayType": {
        const elementType = resolveType(node.element, "field");
        if (elementType.k !== "error" && layoutOf(elementType) === null) {
          cx.error(`array<${show(elementType)}> needs a host-shareable element type; bool has no memory layout, so use u32`, node.element);
        }
        if (node.count === null) {
          if (where !== "storage") {
            cx.error("A runtime-sized array is only allowed as a storage buffer's type; give it a length, as in array<f32, 4>", node);
            return errorTy;
          }
          return { k: "array", element: elementType, n: null };
        }
        const count = parseCount(node.count);
        if (count === null || count <= 0) {
          cx.error("An array length must be a positive integer", node.count);
          return errorTy;
        }
        return { k: "array", element: elementType, n: count };
      }
    }
  };

  // ---- declarations ---------------------------------------------------------------------------

  for (const node of structNodes) structType(node);

  const resources: ResourceDecl[] = [];
  const taken = new Map<string, Text>();
  const pending: { node: Ast.Resource; group: number; binding: number | null; type: Ty }[] = [];
  for (const item of file.items) {
    if (item.kind !== "resource") continue;
    const space = item.space.kind;
    const type = resolveType(item.type, space === "storage" ? "storage" : "value");
    let group = 0;
    let binding: number | null = null;
    for (const attr of item.attrs) {
      const value = attr.args.length === 1 ? parseCount(attr.args[0]!) : null;
      if (attr.name.text !== "group" && attr.name.text !== "binding") {
        cx.error(`Unknown buffer attribute @${attr.name.text}; expected @group(n) or @binding(n)`, attr.name);
      } else if (value === null) cx.error(`@${attr.name.text} takes one integer`, attr);
      else if (attr.name.text === "group") group = value;
      else binding = value;
    }
    if (type.k !== "error") {
      if (layoutOf(type) === null) {
        cx.error(`${show(type)} cannot be stored in a buffer: bool has no memory layout, so use u32`, item.type);
      } else if (space === "uniform") {
        const problem = uniformProblem(type, item.name.text);
        if (problem) cx.error(problem, item.type);
      }
    }
    if (binding !== null) {
      const key = `${group}:${binding}`;
      const previous = taken.get(key);
      if (previous) cx.error(`@group(${group}) @binding(${binding}) is already used by ${previous.text}`, item.name);
      else taken.set(key, item.name);
    }
    pending.push({ node: item, group, binding, type });
  }
  for (const entry of pending) {
    let binding = entry.binding;
    if (binding === null) {
      binding = 0;
      while (taken.has(`${entry.group}:${binding}`)) binding++;
      taken.set(`${entry.group}:${binding}`, entry.node.name);
    }
    const access = entry.node.space.kind === "storage" && entry.node.space.access?.text === "read_write" ? "read_write" : "read";
    const decl: ResourceDecl = {
      name: entry.node.name,
      space: entry.node.space.kind,
      access,
      group: entry.group,
      binding,
      type: entry.type,
      span: entry.node.span,
    };
    resources.push(decl);
    const declared = bound.define(entry.node, entry.type);
    if (declared) locals.set(declared.id, { origin: "resource", type: entry.type, node: entry.node, resource: decl });
  }

  type Signature = { readonly params: readonly Ty[]; readonly result: Ty; readonly node: Ast.Fn };
  const signatures = new Map<string, Signature>();
  for (const item of file.items) {
    if (item.kind !== "fn") continue;
    const params = item.params.map((param) => {
      const type = resolveType(param.type, "value");
      const declared = bound.define(param, type);
      if (declared) locals.set(declared.id, { origin: "param", type });
      return type;
    });
    const result = item.result ? resolveType(item.result, "value") : voidTy;
    if (!bound.binding(item)) continue;
    signatures.set(item.name.text, { params, result, node: item });
    bound.define(item, { k: "fn", params, result });
  }

  // ---- expressions ----------------------------------------------------------------------------

  const typed = (node: Ast.Expr | Text, type: Ty): Ty => {
    if (type.k !== "error") cx.typed(node, type);
    return type;
  };

  const poison = (span: Span): Expr => ({ k: "lit", value: 0, text: "0", span, type: errorTy });

  /** A quick fix wrapping `node` in a conversion to `type`. */
  const wrap = (node: { readonly span: Span }, type: Ty): Fix => ({
    title: `Convert with ${show(type)}(...)`,
    edits: [{ span: { start: node.span.start, end: node.span.start }, newText: `${show(type)}(` }, {
      span: { start: node.span.end, end: node.span.end },
      newText: ")",
    }],
  });

  /** Reports `a op b` with mismatched scalar types, offering to convert the side that is not the target type. */
  const mixed = (op: Text, left: Ast.Expr, right: Ast.Expr, a: Ty, b: Ty): void => {
    const ea = elementOf(a);
    const eb = elementOf(b);
    const numeric = ea !== null && eb !== null && ea !== "bool" && eb !== "bool";
    let fix: Fix | undefined;
    let hint = "";
    if (numeric) {
      // Floats win; otherwise the left side's concrete type does. Literals never need converting.
      const floaty = (e: typeof ea) => e === "f32" || e === "float";
      const target: Scalar = floaty(ea) || floaty(eb) ? "f32" : ea === "int" ? (eb as Scalar) : (ea as Scalar);
      const [side, sideType] = ea !== target && a.k !== "abstract" ? [left, a] : [right, b];
      if (sideType.k !== "abstract") {
        const to = withElement(sideType, target);
        fix = wrap(side, to);
        hint = `; convert one side, as in ${show(to)}(${cx.text(side)})`;
      }
    }
    cx.error(`Cannot mix ${show(a)} and ${show(b)} in "${op.text}"${hint}`, op, fix ? { fix } : {});
  };

  const expr = (node: Ast.Expr, body: Body, runtimeArray = false): Expr => {
    const value = exprInner(node, body, runtimeArray);
    if (!runtimeArray && value.type.k === "array" && value.type.n === null) {
      cx.error(`${cx.text(node)} is a runtime-sized array; index it or pass it to len()`, node);
      return { ...value, type: errorTy };
    }
    return value;
  };

  const exprInner = (node: Ast.Expr, body: Body, runtimeArray: boolean): Expr => {
    switch (node.kind) {
      case "error":
        return poison(node.span);
      case "group": {
        const inner = expr(node.value, body);
        typed(node, inner.type);
        return { ...inner, span: node.span };
      }
      case "number": {
        const parsed = literal(node.value.text);
        if (typeof parsed === "string") {
          cx.error(parsed, node);
          return poison(node.span);
        }
        return { k: "lit", value: parsed.value, text: node.value.text, span: node.span, type: typed(node, parsed.type) };
      }
      case "bool":
        return { k: "lit", value: node.value.text === "true", text: node.value.text, span: node.span, type: typed(node, bool) };
      case "name":
        return name(node.value, body);
      case "access":
        return access(node, body, runtimeArray);
      case "call":
        return call(node, body);
      case "prefix": {
        const operand = expr(node.operand, body);
        const op = node.operator.text;
        const type = operand.type;
        if (type.k === "error") return { ...operand, span: node.span };
        if (op === "!") {
          if (elementOf(type) !== "bool") {
            cx.error(`"!" needs a bool, found ${show(type)}`, node.operand);
            return poison(node.span);
          }
        } else if (!isNumeric(type) && type.k !== "mat") {
          cx.error(`"-" needs a number, found ${show(type)}`, node.operand);
          return poison(node.span);
        } else if (elementOf(type) === "u32") {
          cx.error(`Cannot negate a ${show(type)}; convert to i32 first`, node.operator, { fix: wrap(node.operand, withElement(type, "i32")) });
          return poison(node.span);
        }
        return { k: "unary", op, operand, element: type.k === "mat" ? "f32" : element(type), span: node.span, type: typed(node, type) };
      }
      case "binary":
        return binary(node, body);
      case "postfix":
        cx.error("Shade has no postfix operators", node.operator);
        return poison(node.span);
    }
  };

  const name = (site: Text, body: Body): Expr => {
    const binding = bound.resolved(site);
    if (binding) {
      const local = locals.get(binding.id);
      if (!local) return poison(site.span);
      typed(site, local.type);
      if (local.origin === "resource") return { k: "resource", name: site.text, span: site.span, type: local.type };
      return { k: "local", name: site.text, id: binding.id, span: site.span, type: local.type };
    }
    const builtin = bound.builtin(site);
    if (builtin !== undefined && inputs.has(builtin)) {
      if (body.kernel === null) {
        cx.error(`${builtin} is only available inside a compute entry point; pass it in as a parameter`, site);
        return poison(site.span);
      }
      body.kernel.inputs.add(builtin);
      return { k: "input", name: builtin, span: site.span, type: inputs.get(builtin)!.type };
    }
    if (builtin !== undefined) cx.error(`${builtin} is a type, not a value; call it to construct one, as in ${builtin}()`, site);
    return poison(site.span);
  };

  const access = (node: Ast.Postfix, body: Body, runtimeArray: boolean): Expr => {
    let base = exprInner(node.base, body, true);
    for (const operation of node.operations) {
      const span = { start: node.span.start, end: operation.span.end };
      const type = base.type;
      if (operation.kind === "index") {
        const index = expr(operation.index, body);
        if (index.type.k !== "error" && !accepts(i32, index.type) && !accepts(u32, index.type)) {
          cx.error(`An index must be i32 or u32, found ${show(index.type)}`, operation.index);
        }
        let result: Ty;
        let length: number | null = null;
        if (type.k === "vec") [result, length] = [{ k: "scalar", s: type.s }, type.n];
        else if (type.k === "mat") [result, length] = [vec(type.r, "f32"), type.c];
        else if (type.k === "array") [result, length] = [type.element, type.n];
        else if (type.k === "error") result = errorTy;
        else {
          cx.error(`Cannot index ${show(type)}`, node.base);
          return poison(node.span);
        }
        if (length !== null && index.k === "lit" && typeof index.value === "number" && index.value >= length) {
          cx.error(`Index ${index.value} is out of bounds for ${show(type)}`, operation.index);
        }
        base = { k: "index", base, index, span, type: result };
        continue;
      }
      const member = operation.name;
      if (cx.isMissing(member)) return poison(node.span);
      if (type.k === "struct") {
        const field = type.fields.find((entry) => entry.name === member.text);
        if (!field) {
          const fix = didYouMean(member.text, member.span, type.fields.map((entry) => entry.name));
          cx.error(`${type.name} has no field ${JSON.stringify(member.text)}`, member, fix ? { fix } : {});
          return poison(node.span);
        }
        const binding = fieldBindings.get(type.name)?.get(member.text);
        if (binding) cx.reference(binding, member);
        typed(member, field.type);
        base = { k: "field", base, name: member.text, span, type: field.type };
        continue;
      }
      if (type.k === "vec") {
        const swizzle = member.text;
        const set = swizzleSets.find((letters) => letters.includes(swizzle[0]!));
        if (swizzle.length > 4) {
          cx.error(`A swizzle has at most 4 components, found ${swizzle.length}`, member);
          return poison(node.span);
        }
        if (set === undefined || [...swizzle].some((letter) => !set.includes(letter))) {
          const mixes = [...swizzle].every((letter) => "xyzwrgba".includes(letter));
          cx.error(
            mixes
              ? `Swizzle "${swizzle}" mixes xyzw and rgba components`
              : `${show(type)} has no field "${swizzle}"; vectors have x, y, z, w (or r, g, b, a) components`,
            member,
          );
          return poison(node.span);
        }
        const components = [...swizzle].map((letter) => set.indexOf(letter));
        const outside = components.findIndex((component) => component >= type.n);
        if (outside >= 0) {
          cx.error(`${show(type)} has no component "${swizzle[outside]}"`, member);
          return poison(node.span);
        }
        const result: Ty = components.length === 1 ? { k: "scalar", s: type.s } : vec(components.length as 2 | 3 | 4, type.s);
        typed(member, result);
        base = { k: "swizzle", base, components, text: swizzle, span, type: result };
        continue;
      }
      if (type.k !== "error") cx.error(`${show(type)} has no fields`, member);
      return poison(node.span);
    }
    typed(node, base.type);
    if (!runtimeArray && base.type.k === "array" && base.type.n === null) return base;
    return base;
  };

  const callArgs = (node: Ast.PrimaryCallNode, body: Body): Expr[] => node.args.map((arg) => expr(arg, body));

  const call = (node: Ast.PrimaryCallNode, body: Body): Expr => {
    const callee = node.callee;
    const text = callee.text;
    const builtinType = builtinTypes.get(text);
    if (builtinType) {
      cx.typed(callee, { k: "type", of: builtinType });
      return construct(node, builtinType, callArgs(node, body));
    }
    if (text === "len") {
      const [arg] = node.args;
      if (node.args.length !== 1 || !arg) {
        cx.error(`${signature("len")} takes 1 argument, found ${node.args.length}`, node);
        return poison(node.span);
      }
      const value = expr(arg, body, true);
      if (value.type.k === "error") return poison(node.span);
      if (value.k !== "resource" || value.type.k !== "array" || value.type.n !== null) {
        cx.error(`len() takes a storage buffer holding a runtime-sized array, found ${show(value.type)}`, arg);
        return poison(node.span);
      }
      return { k: "len", name: value.name, stride: layoutOf(value.type)!.size, span: node.span, type: typed(node, u32) };
    }
    if (isBuiltinFunction(text)) {
      const args = callArgs(node, body);
      const resolved = resolveBuiltin(text, args.map((arg) => arg.type));
      if ("message" in resolved) {
        cx.error(resolved.message, resolved.argument === undefined ? node : node.args[resolved.argument]!);
        return poison(node.span);
      }
      return { k: "builtin", name: text, args, params: resolved.params, span: node.span, type: typed(node, resolved.result) };
    }
    const binding = cx.resolve(text, callee);
    if (!binding) {
      cx.unknown("function", text, callee, [...builtinFunctions, ...builtinTypes.keys(), ...signatures.keys(), ...structNodes.map((entry) => entry.name.text)]);
      callArgs(node, body);
      return poison(node.span);
    }
    if (binding.type) cx.typed(callee, binding.type);
    if (binding.kind === "struct") {
      const target = structNodes.find((entry) => entry.name.text === text);
      return construct(node, target ? structType(target) : errorTy, callArgs(node, body));
    }
    const signature_ = signatures.get(text);
    if (!signature_) {
      cx.error(binding.detail === "entry point" ? `${text} is a compute entry point; it cannot be called` : `${text} is not a function`, callee);
      callArgs(node, body);
      return poison(node.span);
    }
    body.calls.add(text);
    const args = callArgs(node, body);
    if (args.length !== signature_.params.length) {
      cx.error(`${text} takes ${signature_.params.length} argument${signature_.params.length === 1 ? "" : "s"}, found ${args.length}`, node);
    } else {
      args.forEach((arg, index) => {
        const expected = signature_.params[index]!;
        if (!accepts(expected, arg.type)) {
          cx.error(`Argument ${index + 1} of ${text} expects ${show(expected)}, found ${show(arg.type)}`, node.args[index]!);
        }
      });
    }
    return { k: "call", name: text, args, span: node.span, type: typed(node, signature_.result) };
  };

  const construct = (node: Ast.PrimaryCallNode, type: Ty, args: Expr[]): Expr => {
    const done = (form: "zero" | "convert" | "splat" | "parts"): Expr => ({
      k: "construct",
      name: show(type),
      form,
      args,
      span: node.span,
      type: typed(node, type),
    });
    if (type.k === "error" || args.some((arg) => arg.type.k === "error")) return { ...poison(node.span), type: type.k === "error" ? errorTy : type };
    if (args.length === 0) return done("zero");
    const fail = (message: string, at: { span: Span } = node): Expr => {
      cx.error(message, at);
      return poison(node.span);
    };
    const name_ = show(type);
    switch (type.k) {
      case "scalar": {
        const [arg] = args;
        if (args.length !== 1 || (arg!.type.k !== "scalar" && arg!.type.k !== "abstract")) {
          return fail(`${name_}(...) converts one scalar, found (${args.map((entry) => show(entry.type)).join(", ")})`);
        }
        return done("convert");
      }
      case "vec": {
        const s = type.s;
        if (args.length === 1) {
          const only = args[0]!;
          if (only.type.k === "vec" && only.type.n === type.n) return done("convert");
          if (accepts({ k: "scalar", s }, only.type)) return done("splat");
        }
        let count = 0;
        for (let index = 0; index < args.length; index++) {
          const arg = args[index]!;
          if (accepts({ k: "scalar", s }, arg.type)) count++;
          else if (arg.type.k === "vec" && arg.type.s === s) count += arg.type.n;
          else return fail(`${name_} takes ${s} components, found ${show(arg.type)}`, node.args[index]!);
        }
        if (count !== type.n) return fail(`${name_} needs ${type.n} components, found ${count}`);
        return done("parts");
      }
      case "mat": {
        if (args.length === 1 && same(args[0]!.type, type)) return done("convert");
        const column = vec(type.r, "f32");
        if (args.length === type.c && args.every((arg) => same(arg.type, column))) return done("parts");
        if (args.length === type.c * type.r && args.every((arg) => accepts(f32, arg.type))) return done("parts");
        return fail(`${name_} takes ${type.c} ${show(column)} columns or ${type.c * type.r} f32 values`);
      }
      case "struct": {
        if (args.length !== type.fields.length) {
          return fail(`${type.name}(...) takes ${type.fields.length} field values, found ${args.length}`);
        }
        for (let index = 0; index < args.length; index++) {
          const field = type.fields[index]!;
          if (!accepts(field.type, args[index]!.type)) {
            return fail(`Field ${field.name} of ${type.name} is ${show(field.type)}, found ${show(args[index]!.type)}`, node.args[index]!);
          }
        }
        return done("parts");
      }
      default:
        return fail(`${name_} cannot be constructed`);
    }
  };

  /** Result type of arithmetic, or null when the operands do not fit together. */
  const arithmetic = (op: string, a: Ty, b: Ty): { type: Ty; element: Scalar } | null => {
    const scalarLike = (type: Ty) => type.k === "scalar" || type.k === "abstract";
    if (a.k === "mat" || b.k === "mat") {
      if (op === "+" || op === "-") return same(a, b) ? { type: a, element: "f32" } : null;
      if (op !== "*") return null;
      if (a.k === "mat" && accepts(f32, b)) return { type: a, element: "f32" };
      if (b.k === "mat" && accepts(f32, a)) return { type: b, element: "f32" };
      if (a.k === "mat" && b.k === "vec" && b.s === "f32" && b.n === a.c) return { type: vec(a.r, "f32"), element: "f32" };
      if (b.k === "mat" && a.k === "vec" && a.s === "f32" && a.n === b.r) return { type: vec(b.c, "f32"), element: "f32" };
      if (a.k === "mat" && b.k === "mat" && a.c === b.r) return { type: { k: "mat", c: b.c, r: a.r }, element: "f32" };
      return null;
    }
    if (!isNumeric(a) || !isNumeric(b)) return null;
    if (scalarLike(a) && scalarLike(b)) {
      if (a.k === "abstract" && b.k === "abstract") {
        const type = a.s === "float" || b.s === "float" ? abstractFloat : abstractInt;
        return { type, element: element(type) };
      }
      if (accepts(a, b) && a.k !== "abstract") return { type: a, element: element(a) };
      if (accepts(b, a) && b.k !== "abstract") return { type: b, element: element(b) };
      return null;
    }
    if (a.k === "vec" && b.k === "vec") return same(a, b) ? { type: a, element: a.s } : null;
    const [vector, other] = a.k === "vec" ? [a, b] : [b, a];
    if (vector.k === "vec" && accepts({ k: "scalar", s: vector.s }, other)) return { type: vector, element: vector.s };
    return null;
  };

  const binary = (node: Ast.ExprBinaryNode, body: Body): Expr => {
    const left = expr(node.left, body);
    const right = expr(node.right, body);
    const op = node.operator.text;
    const a = left.type;
    const b = right.type;
    if (a.k === "error" || b.k === "error") return poison(node.span);
    const result = (type: Ty, element_: Scalar): Expr => ({
      k: "binary",
      op,
      left,
      right,
      element: element_,
      span: node.span,
      type: typed(node, type),
    });
    if (op === "&&" || op === "||") {
      if (!same(a, bool) || !same(b, bool)) {
        const [side, type] = same(a, bool) ? [node.right, b] : [node.left, a];
        cx.error(`"${op}" needs bool operands, found ${show(type)}`, side);
        return poison(node.span);
      }
      return result(bool, "bool");
    }
    if (["==", "!=", "<", "<=", ">", ">="].includes(op)) {
      const ordered = op !== "==" && op !== "!=";
      const shape = (type: Ty) => type.k === "scalar" || type.k === "abstract" || type.k === "vec";
      if (!shape(a) || !shape(b) || (ordered && (!isNumeric(a) || !isNumeric(b)))) {
        const bad = !shape(a) || (ordered && !isNumeric(a)) ? node.left : node.right;
        const type = bad === node.left ? a : b;
        cx.error(`"${op}" cannot compare ${show(type)}`, bad);
        return poison(node.span);
      }
      const operands = accepts(a, b) && a.k !== "abstract" ? a : accepts(b, a) ? (b.k === "abstract" ? concrete(b) : b) : null;
      if (operands === null || (a.k === "vec") !== (b.k === "vec")) {
        mixed(node.operator, node.left, node.right, a, b);
        return poison(node.span);
      }
      return result(operands.k === "vec" ? vec(operands.n, "bool") : bool, element(operands));
    }
    const arith = arithmetic(op, a, b);
    if (arith === null) {
      const numericPair = (isNumeric(a) || a.k === "mat") && (isNumeric(b) || b.k === "mat");
      if (numericPair && a.k !== "mat" && b.k !== "mat" && elementOf(a) !== elementOf(b)) mixed(node.operator, node.left, node.right, a, b);
      else if (!numericPair) {
        const [side, type] = isNumeric(a) || a.k === "mat" ? [node.right, b] : [node.left, a];
        cx.error(`"${op}" needs numbers, found ${show(type)}`, side);
      } else cx.error(`Cannot apply "${op}" to ${show(a)} and ${show(b)}`, node.operator);
      return poison(node.span);
    }
    return result(arith.type, arith.element);
  };

  // ---- statements -----------------------------------------------------------------------------

  const block = (node: Ast.Block, body: Body): Stmt[] => node.kind === "error" ? [] : node.statements.flatMap((entry) => statement(entry, body));

  const mutable = (root: Text, target: Ast.Expr): boolean => {
    const binding = bound.resolved(root);
    if (!binding) {
      if (bound.builtin(root) !== undefined) cx.error(`${root.text} is a builtin input and is read-only`, root);
      return false;
    }
    const local = locals.get(binding.id);
    if (!local) return false;
    switch (local.origin) {
      case "var":
        return true;
      case "let": {
        const node = local.node as Ast.StmtLetNode;
        cx.error(`Cannot assign to ${root.text}: it is a let; declare it with var to change it`, target, {
          fix: { title: `Declare ${root.text} with var`, edits: [{ span: { start: node.span.start, end: node.span.start + 3 }, newText: "var" }] },
        });
        return false;
      }
      case "param":
        cx.error(`Cannot assign to parameter ${root.text}; copy it into a var first`, target);
        return false;
      case "for":
        cx.error(`Cannot assign to loop variable ${root.text}`, target);
        return false;
      case "resource": {
        const resource = local.resource!;
        if (resource.space === "uniform") {
          cx.error(`${root.text} is a uniform buffer, which shaders can only read`, target);
          return false;
        }
        if (resource.access === "read") {
          const node = local.node as Ast.Resource;
          const space = node.space as Ast.SpaceStorageNode;
          cx.error(`${root.text} is read-only storage; declare it as storage read_write to write to it`, target, {
            fix: {
              title: "Make the buffer read_write",
              edits: [space.access
                ? { span: space.access.span, newText: "read_write" }
                : { span: { start: space.span.end, end: space.span.end }, newText: " read_write" }],
            },
          });
          return false;
        }
        return true;
      }
    }
  };

  const assign = (node: Ast.StmtAssignNode, body: Body): Stmt[] => {
    const targetNode = node.target;
    const root = targetNode.kind === "name" ? targetNode.value : targetNode.kind === "access" && targetNode.base.kind === "name" ? targetNode.base.value : null;
    const target = expr(targetNode, body);
    const value = expr(node.value, body);
    if (cx.isError(targetNode)) return [];
    if (root === null) {
      cx.error("Only a variable, a field, an element, or a single vector component can be assigned", targetNode);
      return [];
    }
    // A swizzle may only be the last step, and only a single component: `v.x = 1.0`.
    for (let cursor: Expr = target, last = true; ; last = false) {
      if (cursor.k === "swizzle") {
        const message = !last
          ? "Only the last step of an assignment target can be a swizzle"
          : cursor.components.length > 1
          ? "Cannot assign to a multi-component swizzle; assign one component at a time or build a new vector"
          : null;
        if (message) {
          cx.error(message, targetNode);
          return [];
        }
      }
      if (cursor.k !== "field" && cursor.k !== "index" && cursor.k !== "swizzle") break;
      cursor = cursor.base;
    }
    if (!mutable(root, targetNode)) return [];
    const op = node.op.text;
    if (target.type.k === "error" || value.type.k === "error") return [];
    if (op === "=") {
      if (!accepts(target.type, value.type)) {
        cx.error(`Cannot assign ${show(value.type)} to ${show(target.type)}`, node.value, convertFix(node.value, value.type, target.type));
        return [];
      }
      return [{ k: "assign", op, target, value, element: null, span: node.span }];
    }
    const arith = arithmetic(op[0]!, target.type, value.type);
    if (arith === null || !same(arith.type, target.type)) {
      if (arith === null && elementOf(target.type) !== elementOf(value.type) && isNumeric(target.type) && isNumeric(value.type)) {
        mixed(node.op, targetNode, node.value, target.type, value.type);
      } else cx.error(`Cannot apply "${op}" to ${show(target.type)} and ${show(value.type)}`, node.op);
      return [];
    }
    return [{ k: "assign", op: op[0]!, target, value, element: arith.element, span: node.span }];
  };

  const convertFix = (node: Ast.Expr, from: Ty, to: Ty): { fix?: Fix } => {
    const a = elementOf(from);
    const b = elementOf(to);
    if (a === null || b === null || a === "bool" || b === "bool") return {};
    if ((from.k === "vec") !== (to.k === "vec") || (from.k === "vec" && to.k === "vec" && from.n !== to.n)) return {};
    return { fix: wrap(node, to) };
  };

  const declare = (node: Ast.StmtLetNode | Ast.StmtVarNode, body: Body): Stmt[] => {
    const annotation = node.annotation ? resolveType(node.annotation, "value") : null;
    const valueNode = node.kind === "let" ? node.value : node.init;
    const init = valueNode ? expr(valueNode, body) : null;
    let type = annotation ?? (init ? concrete(init.type) : null);
    if (init && init.type.k === "void") {
      cx.error(`${cx.text(valueNode!)} returns no value`, valueNode!);
      type = errorTy;
    } else if (init && annotation && !accepts(annotation, init.type)) {
      cx.error(`${node.name.text} is ${show(annotation)}, but the value is ${show(init.type)}`, valueNode!, convertFix(valueNode!, init.type, annotation));
    }
    if (type === null) {
      cx.error(`var ${node.name.text} needs a type or an initial value`, node.name);
      type = errorTy;
    }
    const declared = bound.define(node, type);
    if (!declared) return [];
    locals.set(declared.id, { origin: node.kind, type, node });
    return [{ k: node.kind, name: node.name.text, id: declared.id, type, init, span: node.span }];
  };

  const condition = (node: Ast.Expr, body: Body, what: string): Expr => {
    const cond = expr(node, body);
    if (cond.type.k !== "error" && !same(cond.type, bool)) cx.error(`${what} condition must be bool, found ${show(cond.type)}`, node);
    return cond;
  };

  const ifStatement = (node: Ast.If, body: Body): Stmt => {
    const cond = condition(node.cond, body, "An if");
    const then = block(node.then, body);
    let otherwise: Stmt[] | null = null;
    if (node.otherwise) {
      const branch = node.otherwise.branch;
      otherwise = branch.kind === "if" ? [ifStatement(branch, body)] : block(branch, body);
    }
    return { k: "if", cond, then, otherwise, span: node.span };
  };

  const statement = (node: Ast.Stmt, body: Body): Stmt[] => {
    switch (node.kind) {
      case "error":
        return [];
      case "let":
      case "var":
        return declare(node, body);
      case "assign":
        return assign(node, body);
      case "block":
        return [{ k: "block", body: block(node, body), span: node.span }];
      case "if":
        return [ifStatement(node, body)];
      case "while": {
        const cond = condition(node.cond, body, "A while");
        body.loops++;
        const inner = block(node.body, body);
        body.loops--;
        return [{ k: "while", cond, body: inner, span: node.span }];
      }
      case "for": {
        const from = expr(node.from, body);
        const to = expr(node.to, body);
        let type: Ty = errorTy;
        if (from.type.k !== "error" && to.type.k !== "error") {
          const known = from.type.k !== "abstract" ? from.type : to.type.k !== "abstract" ? to.type : i32;
          if (!same(known, i32) && !same(known, u32)) cx.error(`A range needs i32 or u32 bounds, found ${show(known)}`, from.type.k !== "abstract" ? node.from : node.to);
          else if (!accepts(known, from.type) || !accepts(known, to.type)) {
            cx.error(`Range bounds must have one type, found ${show(from.type)} and ${show(to.type)}`, node.to, convertFix(node.to, to.type, known));
          } else type = known;
        }
        const declared = bound.define(node, type);
        if (declared) locals.set(declared.id, { origin: "for", type });
        body.loops++;
        const inner = block(node.body, body);
        body.loops--;
        return declared ? [{ k: "for", name: node.name.text, id: declared.id, type, from, to, body: inner, span: node.span }] : [];
      }
      case "return": {
        const value = node.value ? expr(node.value, body) : null;
        if (body.result.k === "void") {
          if (value) cx.error(body.kernel ? "A compute entry point cannot return a value" : "This function has no return type; remove the value or add -> T", node.value!);
        } else if (!value) {
          cx.error(`Return a ${show(body.result)} value`, node);
        } else if (!accepts(body.result, value.type)) {
          cx.error(`Expected a ${show(body.result)} return value, found ${show(value.type)}`, node.value!, convertFix(node.value!, value.type, body.result));
        }
        return [{ k: "return", value, span: node.span }];
      }
      case "break":
      case "continue":
        if (body.loops === 0) cx.error(`${node.kind} is only allowed inside a loop`, node);
        return [{ k: node.kind, span: node.span }];
      case "expr": {
        const value = expr(node.value, body);
        if (node.value.kind !== "call") {
          cx.error("Only a function call can stand alone as a statement", node.value);
          return [];
        }
        if (value.k === "builtin" || value.k === "construct" || value.k === "len") {
          cx.error(`The result of ${node.value.callee.text}(...) is unused`, node.value);
          return [];
        }
        return [{ k: "expr", value, span: node.span }];
      }
    }
  };

  /** True when every path through `statements` returns. */
  const returns = (statements: readonly Stmt[]): boolean =>
    statements.some((entry) =>
      entry.k === "return"
      || (entry.k === "block" && returns(entry.body))
      || (entry.k === "if" && entry.otherwise !== null && returns(entry.then) && returns(entry.otherwise))
    );

  // ---- functions and entry points -------------------------------------------------------------

  const fns: FnDecl[] = [];
  const kernels: KernelDecl[] = [];
  const callGraph = new Map<string, Set<string>>();
  for (const item of file.items) {
    if (item.kind === "fn") {
      const signature_ = signatures.get(item.name.text);
      if (!signature_ || signature_.node !== item) continue;
      const body: Body = { result: signature_.result, kernel: null, calls: new Set(), loops: 0 };
      const statements = cx.check(() => block(item.body, body)) ?? [];
      callGraph.set(item.name.text, body.calls);
      if (signature_.result.k !== "void" && signature_.result.k !== "error" && !cx.isError(item.body) && !returns(statements)) {
        cx.error(`${item.name.text} must return a ${show(signature_.result)} on every path`, item.name);
      }
      fns.push({
        name: item.name,
        params: item.params.map((param, index) => ({
          name: param.name.text,
          id: bound.binding(param)?.id ?? -1,
          type: signature_.params[index]!,
        })),
        result: signature_.result,
        body: statements,
        span: item.span,
      });
    } else if (item.kind === "compute") {
      const sizes = item.size.map((entry) => parseCount(entry));
      let size: [number, number, number] = [1, 1, 1];
      if (item.size.length > 3) cx.error("A workgroup size has at most 3 dimensions", item.size[3]!);
      else if (sizes.some((entry) => entry === null || entry <= 0)) {
        cx.error("Workgroup sizes must be positive integers", item.size[sizes.findIndex((entry) => entry === null || entry <= 0)]!);
      } else {
        size = [sizes[0] ?? 1, sizes[1] ?? 1, sizes[2] ?? 1];
        const total = size[0] * size[1] * size[2];
        if (size[0] > 256 || size[1] > 256 || size[2] > 64 || total > 256) {
          cx.error(`Workgroup size [${size.join(", ")}] exceeds WebGPU's default limits (x, y <= 256, z <= 64, 256 invocations)`, item.size[0]!);
        }
      }
      bound.define(item, { k: "entry", size });
      const used = new Set<string>();
      const body: Body = { result: voidTy, kernel: { inputs: used }, calls: new Set(), loops: 0 };
      const statements = cx.check(() => block(item.body, body)) ?? [];
      kernels.push({ name: item.name, size, inputs: [...inputs.keys()].filter((entry) => used.has(entry)), body: statements, span: item.span });
    }
  }

  // Shader code cannot recurse: report each function on a call cycle once.
  const state = new Map<string, "open" | "done">();
  const visit = (name: string, path: string[]): void => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "open") {
      const cycle = [...path.slice(path.indexOf(name)), name];
      const node = signatures.get(name)?.node;
      if (node) cx.error(`${name} is recursive (${cycle.join(" -> ")}); shader functions cannot recurse`, node.name);
      return;
    }
    state.set(name, "open");
    for (const callee of callGraph.get(name) ?? []) visit(callee, [...path, name]);
    state.set(name, "done");
  };
  for (const name of callGraph.keys()) visit(name, []);

  return {
    source: cx.source,
    structs: structNodes.flatMap((node) => {
      const type = structTypes.get(node);
      return type && type !== "busy" && bound.binding(node) ? [{ name: node.name, type, span: node.span }] : [];
    }),
    resources,
    fns,
    kernels,
  };
};

