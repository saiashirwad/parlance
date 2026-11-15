/**
 * The shade runtime: WGSL memory layout in pure JavaScript (pack and unpack through a DataView),
 * the math the generated kernels call, and a CPU dispatcher for compute entry points.
 */

export type Scalar = "f32" | "i32" | "u32" | "bool";

/** A JSON description of a type, emitted by the shade compiler. */
export type Desc =
  | { readonly k: "scalar"; readonly s: Scalar }
  | { readonly k: "vec"; readonly n: 2 | 3 | 4; readonly s: Scalar }
  | { readonly k: "mat"; readonly c: 2 | 3 | 4; readonly r: 2 | 3 | 4; readonly stride: number }
  | { readonly k: "array"; readonly element: Desc; readonly n: number | null; readonly stride: number; readonly name: string }
  | {
    readonly k: "struct";
    readonly name: string;
    readonly size: number;
    readonly align: number;
    readonly fields: readonly { readonly name: string; readonly offset: number; readonly size: number; readonly type: Desc; readonly wgsl: string }[];
  };

type Value = number | boolean | Value[] | { [field: string]: Value };
type Data = ArrayBuffer | ArrayBufferView;

const viewOf = (data: Data): DataView =>
  data instanceof ArrayBuffer ? new DataView(data) : new DataView(data.buffer, data.byteOffset, data.byteLength);

const fail = (path: string, expected: string, value: unknown): never => {
  throw new TypeError(`${path}: expected ${expected}, found ${Array.isArray(value) ? `an array of ${value.length}` : typeof value}`);
};

/** Reads a value of type `desc` at `offset` (little-endian, as WebGPU buffers are). */
export const load = (view: DataView, offset: number, desc: Desc): Value => {
  switch (desc.k) {
    case "scalar":
      return desc.s === "f32" ? view.getFloat32(offset, true) : desc.s === "i32" ? view.getInt32(offset, true) : view.getUint32(offset, true);
    case "vec": {
      const out: number[] = [];
      for (let index = 0; index < desc.n; index++) out.push(load(view, offset + index * 4, { k: "scalar", s: desc.s }) as number);
      return out;
    }
    case "mat": {
      const out: Value[] = [];
      for (let column = 0; column < desc.c; column++) out.push(load(view, offset + column * desc.stride, { k: "vec", n: desc.r, s: "f32" }));
      return out;
    }
    case "array": {
      const out: Value[] = [];
      for (let index = 0; index < desc.n!; index++) out.push(load(view, offset + index * desc.stride, desc.element));
      return out;
    }
    case "struct": {
      const out: { [field: string]: Value } = {};
      for (const field of desc.fields) out[field.name] = load(view, offset + field.offset, field.type);
      return out;
    }
  }
};

/** Writes `value` at `offset`. Padding bytes are left as they are. `path` names the value in errors. */
export const store = (view: DataView, offset: number, desc: Desc, value: unknown, path = "value"): void => {
  switch (desc.k) {
    case "scalar": {
      if (typeof value !== "number") fail(path, `a number (${desc.s})`, value);
      const number = value as number;
      if (desc.s === "f32") view.setFloat32(offset, number, true);
      else if (desc.s === "i32") view.setInt32(offset, number, true);
      else view.setUint32(offset, number >>> 0, true);
      return;
    }
    case "vec":
    case "array": {
      const length = desc.k === "vec" ? desc.n : desc.n;
      if (!Array.isArray(value) || (length !== null && value.length !== length)) {
        fail(path, desc.k === "vec" ? `${desc.n} numbers` : `${length} elements`, value);
      }
      const items = value as unknown[];
      for (let index = 0; index < items.length; index++) {
        if (desc.k === "vec") store(view, offset + index * 4, { k: "scalar", s: desc.s }, items[index], `${path}[${index}]`);
        else store(view, offset + index * desc.stride, desc.element, items[index], `${path}[${index}]`);
      }
      return;
    }
    case "mat": {
      if (!Array.isArray(value) || value.length !== desc.c) fail(path, `${desc.c} columns`, value);
      (value as unknown[]).forEach((column, index) =>
        store(view, offset + index * desc.stride, { k: "vec", n: desc.r, s: "f32" }, column, `${path}[${index}]`)
      );
      return;
    }
    case "struct": {
      if (typeof value !== "object" || value === null) fail(path, `a ${desc.name}`, value);
      for (const field of desc.fields) {
        store(view, offset + field.offset, field.type, (value as Record<string, unknown>)[field.name], `${path}.${field.name}`);
      }
    }
  }
};

export const zero = (desc: Desc): Value => {
  switch (desc.k) {
    case "scalar":
      return desc.s === "bool" ? false : 0;
    case "vec":
      return Array.from({ length: desc.n }, () => (desc.s === "bool" ? false : 0));
    case "mat":
      return Array.from({ length: desc.c }, () => Array.from({ length: desc.r }, () => 0));
    case "array":
      return Array.from({ length: desc.n ?? 0 }, () => zero(desc.element));
    case "struct":
      return Object.fromEntries(desc.fields.map((field) => [field.name, zero(field.type)]));
  }
};

/** The layout object a module exports for each struct. */
export const struct = (desc: Extract<Desc, { k: "struct" }>) => {
  const stride = Math.ceil(desc.size / desc.align) * desc.align;
  return Object.freeze({
    name: desc.name,
    size: desc.size,
    align: desc.align,
    stride,
    fields: Object.freeze(Object.fromEntries(desc.fields.map((field) => [field.name, Object.freeze({ offset: field.offset, size: field.size, type: field.wgsl })]))),
    pack: (value: unknown): ArrayBuffer => {
      const buffer = new ArrayBuffer(desc.size);
      store(new DataView(buffer), 0, desc, value, desc.name);
      return buffer;
    },
    packArray: (values: readonly unknown[]): ArrayBuffer => {
      const buffer = new ArrayBuffer(stride * values.length);
      const view = new DataView(buffer);
      values.forEach((value, index) => store(view, index * stride, desc, value, `${desc.name}[${index}]`));
      return buffer;
    },
    write: (data: Data, offset: number, value: unknown): void => store(viewOf(data), offset, desc, value, desc.name),
    unpack: (data: Data, offset = 0) => load(viewOf(data), offset, desc),
    unpackArray: (data: Data) => {
      const view = viewOf(data);
      return Array.from({ length: Math.floor(view.byteLength / stride) }, (_, index) => load(view, index * stride, desc));
    },
  });
};

// ---- math ---------------------------------------------------------------------------------------

export const f = Math.fround;

/** A bounds-checked index. GPUs clamp or drop out-of-bounds accesses; the CPU runtime throws instead. */
export const bound = (index: number, length: number, what: string): number => {
  if (!(index >= 0 && index < length)) throw new RangeError(`Index ${index} is out of bounds for ${what} (length ${length})`);
  return index;
};

const scalarOp = (op: string, s: Scalar, a: any, b: any): any => {
  switch (op) {
    case "+":
      return s === "f32" ? f(a + b) : s === "i32" ? (a + b) | 0 : (a + b) >>> 0;
    case "-":
      return s === "f32" ? f(a - b) : s === "i32" ? (a - b) | 0 : (a - b) >>> 0;
    case "*":
      return s === "f32" ? f(a * b) : s === "i32" ? Math.imul(a, b) : Math.imul(a, b) >>> 0;
    case "/":
      // WGSL integer division by zero yields the dividend.
      if (s === "f32") return f(a / b);
      if (b === 0) return a;
      return s === "i32" ? (a === -2147483648 && b === -1 ? a : (a / b) | 0) : Math.trunc(a / b) >>> 0;
    case "%":
      if (s === "f32") return f(a % b);
      if (b === 0) return 0;
      return s === "i32" ? (a % b) | 0 : (a % b) >>> 0;
    case "==":
      return a === b;
    case "!=":
      return a !== b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
  }
  throw new Error(`unknown operator ${op}`);
};

/** A componentwise operator; a scalar operand is broadcast (vec * f32, mat * f32). */
export const op = (operator: string, s: Scalar, a: any, b: any): any => {
  if (Array.isArray(a) || Array.isArray(b)) {
    const length = Array.isArray(a) ? a.length : b.length;
    return Array.from({ length }, (_, index) => op(operator, s, Array.isArray(a) ? a[index] : a, Array.isArray(b) ? b[index] : b));
  }
  return scalarOp(operator, s, a, b);
};

export const neg = (s: Scalar, a: any): any =>
  Array.isArray(a) ? a.map((entry) => neg(s, entry)) : s === "f32" ? f(-a) : -a | 0;

export const not = (a: any): any => Array.isArray(a) ? a.map((entry) => !entry) : !a;

/** matCxR * vecC -> vecR */
export const mulMV = (m: number[][], v: number[]): number[] =>
  m[0]!.map((_, row) => f(m.reduce((sum, column, index) => sum + column[row]! * v[index]!, 0)));

/** vecR * matCxR -> vecC */
export const mulVM = (v: number[], m: number[][]): number[] =>
  m.map((column) => f(column.reduce((sum, value, row) => sum + value * v[row]!, 0)));

/** matKxR * matCxK -> matCxR */
export const mulMM = (a: number[][], b: number[][]): number[][] => b.map((column) => mulMV(a, column));

export const clone = <T>(value: T): T =>
  Array.isArray(value)
    ? value.map(clone) as T
    : typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)])) as T
    : value;

export const convert = (to: Scalar, from: Scalar, value: any): any => {
  if (Array.isArray(value)) return value.map((entry) => convert(to, from, entry));
  const number = from === "bool" ? (value ? 1 : 0) : value;
  switch (to) {
    case "bool":
      return number !== 0;
    case "f32":
      return f(number);
    case "i32":
      if (from === "u32") return number | 0;
      if (from === "f32") return Number.isNaN(number) ? 0 : Math.max(-2147483648, Math.min(2147483520, Math.trunc(number))) | 0;
      return number | 0;
    case "u32":
      if (from === "i32") return number >>> 0;
      if (from === "f32") return Number.isNaN(number) ? 0 : Math.max(0, Math.min(4294967040, Math.trunc(number))) >>> 0;
      return number >>> 0;
  }
};

export const swizzle = (vector: readonly any[], components: readonly number[]): any[] => components.map((index) => vector[index]);

/** Flattens scalar and vector parts into one vector: vec4f(v.xyz, 1.0). */
export const parts = (values: readonly any[]): any[] => values.flatMap((value) => Array.isArray(value) ? value : [value]);

/** Rows into columns: mat2x2f(a, b, c, d) has columns [a, b] and [c, d]. */
export const columns = (c: number, r: number, values: readonly number[]): number[][] =>
  Array.from({ length: c }, (_, column) => values.slice(column * r, column * r + r).map(f));

const map1 = (fn: (x: number) => number) => (s: Scalar, a: any): any =>
  Array.isArray(a) ? a.map((entry) => map1(fn)(s, entry)) : s === "f32" ? f(fn(a)) : fn(a);
const map2 = (fn: (x: number, y: number) => number) => (s: Scalar, a: any, b: any): any =>
  Array.isArray(a) ? a.map((entry, index) => map2(fn)(s, entry, b[index])) : s === "f32" ? f(fn(a, b)) : fn(a, b);
const map3 = (fn: (x: number, y: number, z: number) => number) => (s: Scalar, a: any, b: any, c: any): any =>
  Array.isArray(a)
    ? a.map((entry, index) => map3(fn)(s, entry, b[index], Array.isArray(c) ? c[index] : c))
    : s === "f32"
    ? f(fn(a, b, c))
    : fn(a, b, c);

const sum = (s: Scalar, values: number[]): number => values.reduce((total, value) => scalarOp("+", s, total, value), 0);
const dot = (s: Scalar, a: number[], b: number[]): number => sum(s, a.map((value, index) => scalarOp("*", s, value, b[index]!)));
const length = (_: Scalar, a: any): number => Array.isArray(a) ? f(Math.hypot(...a)) : f(Math.abs(a));

/** Builtin functions, called as `builtins.name(elementType, ...args)`. */
export const builtins: Record<string, (s: Scalar, ...args: any[]) => any> = {
  abs: map1(Math.abs),
  min: map2(Math.min),
  max: map2(Math.max),
  clamp: map3((e, low, high) => Math.min(Math.max(e, low), high)),
  sign: map1(Math.sign),
  sin: map1(Math.sin),
  cos: map1(Math.cos),
  tan: map1(Math.tan),
  asin: map1(Math.asin),
  acos: map1(Math.acos),
  atan: map1(Math.atan),
  sinh: map1(Math.sinh),
  cosh: map1(Math.cosh),
  tanh: map1(Math.tanh),
  exp: map1(Math.exp),
  exp2: map1((x) => 2 ** x),
  log: map1(Math.log),
  log2: map1(Math.log2),
  sqrt: map1(Math.sqrt),
  inverseSqrt: map1((x) => 1 / Math.sqrt(x)),
  floor: map1(Math.floor),
  ceil: map1(Math.ceil),
  // WGSL rounds half to even.
  round: map1((x) => {
    const r = Math.round(x);
    return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
  }),
  fract: map1((x) => x - Math.floor(x)),
  trunc: map1(Math.trunc),
  saturate: map1((x) => Math.min(Math.max(x, 0), 1)),
  radians: map1((x) => x * Math.PI / 180),
  degrees: map1((x) => x * 180 / Math.PI),
  atan2: map2(Math.atan2),
  pow: map2((x, y) => x ** y),
  step: map2((edge, x) => (x >= edge ? 1 : 0)),
  smoothstep: map3((low, high, x) => {
    const t = Math.min(Math.max((x - low) / (high - low), 0), 1);
    return t * t * (3 - 2 * t);
  }),
  mix: map3((a, b, t) => a * (1 - t) + b * t),
  length,
  distance: (s, a, b) => length(s, op("-", s, a, b)),
  normalize: (s, a: number[]) => {
    const size = length(s, a);
    return a.map((value) => f(value / size));
  },
  dot: (s, a, b) => dot(s, a, b),
  cross: (_, a: number[], b: number[]) => [
    f(a[1]! * b[2]! - a[2]! * b[1]!),
    f(a[2]! * b[0]! - a[0]! * b[2]!),
    f(a[0]! * b[1]! - a[1]! * b[0]!),
  ],
  reflect: (s, e: number[], n: number[]) => op("-", s, e, op("*", s, n, f(2 * dot(s, n, e)))),
  select: (_, whenFalse, whenTrue, condition) =>
    Array.isArray(condition) ? condition.map((entry, index) => (entry ? whenTrue[index] : whenFalse[index])) : condition ? whenTrue : whenFalse,
  any: (_, a) => Array.isArray(a) ? a.some(Boolean) : a,
  all: (_, a) => Array.isArray(a) ? a.every(Boolean) : a,
  transpose: (_, m: number[][]) => m[0]!.map((__, row) => m.map((column) => column[row]!)),
  determinant: (_, m: number[][]) => {
    const det = (rows: number[][]): number =>
      rows.length === 1
        ? rows[0]![0]!
        : rows[0]!.reduce((total, value, column) =>
          total + (column % 2 ? -1 : 1) * value * det(rows.slice(1).map((row) => row.filter((_, index) => index !== column))), 0);
    return f(det(m));
  },
};

// ---- buffers and dispatch -------------------------------------------------------------------

export type Binding = {
  readonly name: string;
  readonly space: "uniform" | "storage";
  readonly access: "read" | "read_write";
  readonly type: Desc;
  /** Bytes the buffer needs at least: the type's size, or one element of a runtime-sized array. */
  readonly minSize: number;
};

/** A bound buffer as generated kernels see it. */
export type Resource = { readonly view: DataView; readonly count: number };

export type Kernel = {
  readonly name: string;
  readonly size: readonly [number, number, number];
  readonly run: (inputs: Record<string, unknown>) => void;
};

/**
 * Runs `kernel` once per invocation of a `workgroups` dispatch, sequentially, against the given
 * buffers (bound by resource name). Writes land in the buffers, as on a GPU.
 */
export const dispatch = (
  kernel: Kernel,
  workgroups: number | readonly [number, number?, number?],
  buffers: Record<string, Data>,
  bindings: readonly Binding[],
  resources: Record<string, Resource>,
): void => {
  const [wx, wy = 1, wz = 1] = typeof workgroups === "number" ? [workgroups] : workgroups;
  for (const binding of bindings) {
    const data = buffers[binding.name];
    if (data === undefined) throw new TypeError(`dispatch(${JSON.stringify(kernel.name)}): missing buffer ${JSON.stringify(binding.name)}`);
    const view = viewOf(data);
    if (view.byteLength < binding.minSize) {
      throw new RangeError(`Buffer ${JSON.stringify(binding.name)} has ${view.byteLength} bytes; it needs at least ${binding.minSize}`);
    }
    const count = binding.type.k === "array" && binding.type.n === null ? Math.floor(view.byteLength / binding.type.stride) : 1;
    resources[binding.name] = { view, count };
  }
  const [sx, sy, sz] = kernel.size;
  const num_workgroups = [wx, wy, wz];
  for (let gz = 0; gz < wz; gz++) {
    for (let gy = 0; gy < wy!; gy++) {
      for (let gx = 0; gx < wx!; gx++) {
        for (let lz = 0; lz < sz; lz++) {
          for (let ly = 0; ly < sy; ly++) {
            for (let lx = 0; lx < sx; lx++) {
              kernel.run({
                global_id: [gx * sx + lx, gy * sy + ly, gz * sz + lz],
                local_id: [lx, ly, lz],
                workgroup_id: [gx, gy, gz],
                local_index: lx + ly * sx + lz * sx * sy,
                num_workgroups,
              });
            }
          }
        }
      }
    }
  }
};
