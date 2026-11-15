/** Shade's types, their printed names, and WGSL host-shareable memory layout. */

export type Scalar = "f32" | "i32" | "u32" | "bool";

export type StructField = {
  readonly name: string;
  readonly type: Ty;
  readonly offset: number;
  readonly align: number;
  readonly size: number;
  /** Explicit `@align(n)` / `@size(n)`, re-emitted to WGSL. */
  readonly attrs: readonly { readonly name: "align" | "size"; readonly value: number }[];
};

export type Ty =
  | { readonly k: "scalar"; readonly s: Scalar }
  | { readonly k: "vec"; readonly n: 2 | 3 | 4; readonly s: Scalar }
  | { readonly k: "mat"; readonly c: 2 | 3 | 4; readonly r: 2 | 3 | 4 }
  /** `n` null: runtime-sized, only as a storage buffer's type. */
  | { readonly k: "array"; readonly element: Ty; readonly n: number | null }
  | {
    readonly k: "struct";
    readonly name: string;
    readonly fields: readonly StructField[];
    readonly align: number;
    readonly size: number;
    /** False when a field is a bool (or holds one): it cannot live in a buffer. */
    readonly shareable: boolean;
  }
  /** An unsuffixed literal: converts to i32, u32, or f32 (int) or f32 (float) where it is used. */
  | { readonly k: "abstract"; readonly s: "int" | "float" }
  | { readonly k: "void" }
  /** A poison type from an earlier error: agrees with everything, so nothing cascades. */
  | { readonly k: "error" }
  | { readonly k: "fn"; readonly params: readonly Ty[]; readonly result: Ty }
  | { readonly k: "entry"; readonly size: readonly [number, number, number] }
  /** The type a type name denotes, as a binding's type. */
  | { readonly k: "type"; readonly of: Ty };

export const scalar = (s: Scalar): Ty => ({ k: "scalar", s });
export const vec = (n: 2 | 3 | 4, s: Scalar): Ty => ({ k: "vec", n, s });
export const f32 = scalar("f32");
export const i32 = scalar("i32");
export const u32 = scalar("u32");
export const bool = scalar("bool");
export const voidTy: Ty = { k: "void" };
export const errorTy: Ty = { k: "error" };
export const abstractInt: Ty = { k: "abstract", s: "int" };
export const abstractFloat: Ty = { k: "abstract", s: "float" };

const suffix = (s: Scalar): string => s === "bool" ? "" : s[0]!;

export const show = (type: Ty): string => {
  switch (type.k) {
    case "scalar":
      return type.s;
    case "vec":
      return type.s === "bool" ? `vec${type.n}<bool>` : `vec${type.n}${suffix(type.s)}`;
    case "mat":
      return `mat${type.c}x${type.r}f`;
    case "array":
      return type.n === null ? `array<${show(type.element)}>` : `array<${show(type.element)}, ${type.n}>`;
    case "struct":
      return type.name;
    case "abstract":
      return type.s === "int" ? "integer literal" : "float literal";
    case "void":
      return "void";
    case "error":
      return "unknown";
    case "fn":
      return `fn(${type.params.map(show).join(", ")})${type.result.k === "void" ? "" : ` -> ${show(type.result)}`}`;
    case "entry":
      return `compute[${type.size.join(", ")}]`;
    case "type":
      return show(type.of);
  }
};

/** WGSL spelling: identical to `show` except bool vectors, which have no shorthand. */
export const wgslType = show;

/** The builtin type names a shade file can write. */
export const builtinTypes: ReadonlyMap<string, Ty> = new Map<string, Ty>([
  ["f32", f32],
  ["i32", i32],
  ["u32", u32],
  ["bool", bool],
  ...(["f32", "i32", "u32", "bool"] as const).flatMap((s) =>
    ([2, 3, 4] as const).map((n): [string, Ty] => [`vec${n}${s === "bool" ? "b" : s[0]}`, vec(n, s)])
  ),
  ...([2, 3, 4] as const).flatMap((c) =>
    ([2, 3, 4] as const).map((r): [string, Ty] => [`mat${c}x${r}f`, { k: "mat", c, r }])
  ),
]);

export const same = (a: Ty, b: Ty): boolean => {
  if (a.k === "error" || b.k === "error") return true;
  if (a.k !== b.k) return false;
  switch (a.k) {
    case "scalar":
      return a.s === (b as typeof a).s;
    case "vec":
      return a.n === (b as typeof a).n && a.s === (b as typeof a).s;
    case "mat":
      return a.c === (b as typeof a).c && a.r === (b as typeof a).r;
    case "array":
      return a.n === (b as typeof a).n && same(a.element, (b as typeof a).element);
    case "struct":
      return a.name === (b as typeof a).name;
    case "abstract":
      return a.s === (b as typeof a).s;
    default:
      return false;
  }
};

/** The scalar a scalar or vector is made of. */
export const elementOf = (type: Ty): Scalar | "int" | "float" | null =>
  type.k === "scalar" || type.k === "vec" ? type.s : type.k === "abstract" ? type.s : null;

export const isNumeric = (type: Ty): boolean => {
  const element = elementOf(type);
  return element !== null && element !== "bool";
};

export const isFloat = (type: Ty): boolean => {
  const element = elementOf(type);
  return element === "f32" || element === "float";
};

/** True when a value of `from` can be used where `to` is expected (literals convert). */
export const accepts = (to: Ty, from: Ty): boolean => {
  if (to.k === "error" || from.k === "error") return true;
  if (from.k === "abstract" && to.k === "scalar") {
    return from.s === "int" ? to.s !== "bool" : to.s === "f32";
  }
  if (from.k === "abstract" && to.k === "abstract") return from.s === "int" || to.s === "float";
  return same(to, from);
};

/** The concrete type an unannotated `let` or `var` gets. */
export const concrete = (type: Ty): Ty => type.k === "abstract" ? (type.s === "int" ? i32 : f32) : type;

/** Layout constraints for host-shareable types (WGSL "Alignment and Size"). */
export type Layout = { readonly align: number; readonly size: number };

export const roundUp = (k: number, n: number): number => Math.ceil(n / k) * k;

/** Align and size of a host-shareable type; null for bool, literals, and non-data types. */
export const layoutOf = (type: Ty): Layout | null => {
  switch (type.k) {
    case "scalar":
      return type.s === "bool" ? null : { align: 4, size: 4 };
    case "vec":
      if (type.s === "bool") return null;
      return { align: type.n === 2 ? 8 : 16, size: type.n * 4 };
    case "mat": {
      const column = layoutOf(vec(type.r, "f32"))!;
      return { align: column.align, size: type.c * roundUp(column.align, column.size) };
    }
    case "array": {
      const element = layoutOf(type.element);
      if (element === null) return null;
      const stride = roundUp(element.align, element.size);
      return { align: element.align, size: type.n === null ? stride : type.n * stride };
    }
    case "struct":
      return type.shareable ? { align: type.align, size: type.size } : null;
    default:
      return null;
  }
};

/** Bytes between consecutive elements of an array of `element`. */
export const strideOf = (element: Ty): number => {
  const layout = layoutOf(element)!;
  return roundUp(layout.align, layout.size);
};

/**
 * Why `type` cannot sit in a uniform buffer, or null. Uniform buffers (without the
 * `uniform_buffer_standard_layout` feature) round struct and array alignment up to 16, need a
 * 16-byte array stride, and leave roundUp(16, size) bytes after a struct member.
 */
export const uniformProblem = (type: Ty, path: string): string | null => {
  if (type.k === "array") {
    if (type.n === null) return `${path} is a runtime-sized array, which a uniform buffer cannot hold`;
    const stride = strideOf(type.element);
    if (stride % 16 !== 0) {
      return `${path} has a ${stride}-byte array stride; uniform buffers need a multiple of 16 (use vec4 elements or a padded struct)`;
    }
    return uniformProblem(type.element, `${path}[]`);
  }
  if (type.k !== "struct") return null;
  for (let index = 0; index < type.fields.length; index++) {
    const field = type.fields[index]!;
    const name = `${path}.${field.name}`;
    if ((field.type.k === "struct" || field.type.k === "array") && field.offset % 16 !== 0) {
      return `${name} is at offset ${field.offset}; a uniform buffer needs struct and array members at a multiple of 16 (add @align(16))`;
    }
    const next = type.fields[index + 1];
    if (field.type.k === "struct" && next && next.offset - field.offset < roundUp(16, field.size)) {
      return `${next.name} follows struct member ${name} too closely for a uniform buffer; add @align(16) to ${next.name}`;
    }
    const nested = uniformProblem(field.type, name);
    if (nested) return nested;
  }
  return null;
};

export const wgslKeywords: ReadonlySet<string> = new Set(["alias","break","case","const","const_assert","continue","continuing","default","diagnostic","discard","else","enable","false","fn","for","if","let","loop","override","requires","return","struct","switch","true","var","while"]);

/** WGSL reserved words (spec section "Reserved Words"). */
export const wgslReserved: ReadonlySet<string> = new Set(["NULL","Self","abstract","active","alignas","alignof","as","asm","asm_fragment","async","attribute","auto","await","become","cast","catch","class","co_await","co_return","co_yield","coherent","column_major","common","compile","compile_fragment","concept","const_cast","consteval","constexpr","constinit","crate","debugger","decltype","delete","demote","demote_to_helper","do","dynamic_cast","enum","explicit","export","extends","extern","external","fallthrough","filter","final","finally","friend","from","fxgroup","get","goto","groupshared","highp","impl","implements","import","inline","instanceof","interface","layout","lowp","macro","macro_rules","match","mediump","meta","mod","module","move","mut","mutable","namespace","new","nil","noexcept","noinline","nointerpolation","non_coherent","noncoherent","noperspective","null","nullptr","of","operator","package","packoffset","partition","pass","patch","pixelfragment","precise","precision","premerge","priv","protected","pub","public","readonly","ref","regardless","register","reinterpret_cast","require","resource","restrict","self","set","shared","sizeof","smooth","snorm","static","static_assert","static_cast","std","subroutine","super","target","template","this","thread_local","throw","trait","try","type","typedef","typeid","typename","typeof","union","unless","unorm","unsafe","unsized","use","using","varying","virtual","volatile","wgsl","where","with","writeonly","yield"]);
