/** Builtin shader functions and their WGSL overloads. */
import { accepts, bool, concrete, elementOf, f32, isFloat, isNumeric, same, show, type Ty, vec } from "./types.ts";

/** A resolved call: the type each argument converts to, and the result. */
export type Overload = { readonly params: readonly Ty[]; readonly result: Ty };
/** A failed call: what was expected, and the argument to blame (or the whole call). */
export type Mismatch = { readonly message: string; readonly argument?: number };

type Family = {
  readonly arity: number;
  /** Placeholder names for the signature in messages, such as `clamp(e, low, high)`. */
  readonly names: readonly string[];
  readonly resolve: (args: readonly Ty[]) => Overload | string;
};

/** One type T shared by every argument: literals take the first concrete argument's type. */
const unify = (args: readonly Ty[], fallback: (type: Ty) => Ty = concrete): Ty | null => {
  const known = args.find((arg) => arg.k !== "abstract" && arg.k !== "error");
  if (known === undefined) {
    const float = args.some((arg) => arg.k === "abstract" && arg.s === "float");
    return fallback(float ? { k: "abstract", s: "float" } : args[0] ?? f32);
  }
  return args.every((arg) => accepts(known, arg)) ? known : null;
};

const toFloat = (type: Ty): Ty => type.k === "abstract" ? f32 : type;
const listed = (args: readonly Ty[]): string => args.map(show).join(", ");

/** `f(T, ...)` where every argument has one type T satisfying `ok`. */
const uniform = (
  arity: number,
  names: readonly string[],
  ok: (type: Ty) => boolean,
  noun: string,
  result: (type: Ty) => Ty = (type) => type,
  float = false,
): Family => ({
  arity,
  names,
  resolve: (args) => {
    const type = unify(args, float ? toFloat : concrete);
    if (type === null || !ok(type)) return `needs ${arity === 1 ? "a" : "arguments of one"} ${noun}${arity === 1 ? "" : " type"}; found ${listed(args)}`;
    return { params: args.map(() => type), result: result(type) };
  },
});

const floating = (type: Ty): boolean => type.k === "error" || isFloat(type);
const numeric = (type: Ty): boolean => type.k === "error" || isNumeric(type);
const floatVector = (type: Ty): boolean => type.k === "error" || (type.k === "vec" && type.s === "f32");
const anyVector = (type: Ty): boolean => type.k === "error" || (type.k === "vec" && type.s !== "bool");
const scalarOf = (type: Ty): Ty => type.k === "vec" ? { k: "scalar", s: type.s } : type;

const float1 = (): Family => uniform(1, ["e"], floating, "f32 or float vector", undefined, true);
const float2 = (): Family => uniform(2, ["a", "b"], floating, "f32 or float vector", undefined, true);

const families: Record<string, Family> = {
  abs: uniform(1, ["e"], numeric, "numeric scalar or vector"),
  min: uniform(2, ["a", "b"], numeric, "numeric"),
  max: uniform(2, ["a", "b"], numeric, "numeric"),
  clamp: uniform(3, ["e", "low", "high"], numeric, "numeric"),
  sign: float1(),
  sin: float1(),
  cos: float1(),
  tan: float1(),
  asin: float1(),
  acos: float1(),
  atan: float1(),
  sinh: float1(),
  cosh: float1(),
  tanh: float1(),
  exp: float1(),
  exp2: float1(),
  log: float1(),
  log2: float1(),
  sqrt: float1(),
  inverseSqrt: float1(),
  floor: float1(),
  ceil: float1(),
  round: float1(),
  fract: float1(),
  trunc: float1(),
  saturate: float1(),
  radians: float1(),
  degrees: float1(),
  atan2: float2(),
  pow: float2(),
  step: uniform(2, ["edge", "x"], floating, "f32 or float vector", undefined, true),
  smoothstep: uniform(3, ["low", "high", "x"], floating, "f32 or float vector", undefined, true),
  length: uniform(1, ["e"], floating, "f32 or float vector", scalarOf, true),
  distance: uniform(2, ["a", "b"], floating, "f32 or float vector", scalarOf, true),
  normalize: uniform(1, ["v"], floatVector, "float vector", undefined, true),
  dot: uniform(2, ["a", "b"], anyVector, "numeric vector", scalarOf),
  cross: uniform(2, ["a", "b"], (type) => type.k === "error" || same(type, vec(3, "f32")), "vec3f"),
  reflect: uniform(2, ["incident", "normal"], floatVector, "float vector", undefined, true),
  mix: {
    arity: 3,
    names: ["a", "b", "t"],
    resolve: (args) => {
      const [a, b, t] = args as [Ty, Ty, Ty];
      const pair = unify([a, b], toFloat);
      if (pair !== null && floating(pair)) {
        if (accepts(pair, t)) return { params: [pair, pair, pair], result: pair };
        if (pair.k === "vec" && accepts(f32, t)) return { params: [pair, pair, f32], result: pair };
      }
      return `needs a and b of one float type and t of that type or f32; found ${listed(args)}`;
    },
  },
  select: {
    arity: 3,
    names: ["whenFalse", "whenTrue", "condition"],
    resolve: (args) => {
      const [a, b, condition] = args as [Ty, Ty, Ty];
      const type = unify([a, b]);
      if (type === null) return `needs whenFalse and whenTrue of one type; found ${show(a)} and ${show(b)}`;
      if (accepts(bool, condition)) return { params: [type, type, bool], result: type };
      if (type.k === "vec" && condition.k === "vec" && condition.s === "bool" && condition.n === type.n) {
        return { params: [type, type, condition], result: type };
      }
      return `needs a bool condition (or a bool vector as wide as the values); found ${show(condition)}`;
    },
  },
  any: uniform(1, ["v"], (type) => type.k === "error" || elementOf(type) === "bool", "bool or bool vector", () => bool),
  all: uniform(1, ["v"], (type) => type.k === "error" || elementOf(type) === "bool", "bool or bool vector", () => bool),
  transpose: {
    arity: 1,
    names: ["m"],
    resolve: ([m]) =>
      m!.k === "mat" ? { params: [m!], result: { k: "mat", c: m!.r, r: m!.c } } : `needs a matrix; found ${show(m!)}`,
  },
  determinant: {
    arity: 1,
    names: ["m"],
    resolve: ([m]) =>
      m!.k === "mat" && m!.c === m!.r ? { params: [m!], result: f32 } : `needs a square matrix; found ${show(m!)}`,
  },
};

export const builtinFunctions: readonly string[] = [...Object.keys(families), "len"];

/** `name(names...)`, for messages and completion details. */
export const signature = (name: string): string =>
  name === "len" ? "len(buffer) -> u32" : `${name}(${families[name]!.names.join(", ")})`;

export const isBuiltinFunction = (name: string): boolean => name in families;

export const resolveBuiltin = (name: string, args: readonly Ty[]): Overload | Mismatch => {
  const family = families[name]!;
  if (args.length !== family.arity) {
    return { message: `${signature(name)} takes ${family.arity} argument${family.arity === 1 ? "" : "s"}, found ${args.length}` };
  }
  // An argument that already failed says nothing more; the call's type is poison too.
  if (args.some((arg) => arg.k === "error")) return { params: args, result: { k: "error" } };
  const resolved = family.resolve(args);
  if (typeof resolved === "string") return { message: `${signature(name)} ${resolved}` };
  const argument = args.findIndex((arg, index) => !accepts(resolved.params[index]!, arg));
  if (argument >= 0) return { message: `${signature(name)} cannot take ${show(args[argument]!)} here`, argument };
  return resolved;
};
