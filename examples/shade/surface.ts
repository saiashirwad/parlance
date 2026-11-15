/** The TypeScript surface of a shade module: struct types, layouts, bindings, entry points, and dispatch. */
import { source, ts, type TsDoc } from "../../src/ts/index.ts";
import type { ShadeModule } from "./check.ts";
import { layoutOf, show, strideOf, type Ty } from "./types.ts";

/** The TypeScript type of a host value: vectors are number tuples, matrices tuples of columns. */
export const hostType = (type: Ty): string => {
  const tuple = (n: number, item: string) => `readonly [${Array.from({ length: n }, () => item).join(", ")}]`;
  switch (type.k) {
    case "scalar":
      return type.s === "bool" ? "boolean" : "number";
    case "vec":
      return tuple(type.n, type.s === "bool" ? "boolean" : "number");
    case "mat":
      return tuple(type.c, tuple(type.r, "number"));
    case "array":
      return `readonly ${hostType(type.element).startsWith("readonly") ? `(${hostType(type.element)})` : hostType(type.element)}[]`;
    case "struct":
      return type.name;
    default:
      return "unknown";
  }
};

const data = "ArrayBuffer | ArrayBufferView";

export const surface = (module: ShadeModule): TsDoc => {
  const structs = module.structs.map((struct) => {
    const type = struct.type;
    const fields = type.fields.map((field, index) => {
      const node = struct.fieldNames[index]!;
      return ts`  readonly ${source(node)}: ${hostType(field.type)};${"\n"}`;
    });
    const iface = ts`export interface ${source(struct.name)} {${"\n"}${fields}}${"\n"}`;
    if (!type.shareable) return iface;
    const layouts = type.fields.map((field) =>
      `    readonly ${field.name}: { readonly offset: ${field.offset}; readonly size: ${field.size}; readonly type: ${JSON.stringify(show(field.type))} };${"\n"}`
    );
    const name = type.name;
    return ts`${iface}export declare const ${source(struct.name)}: {
  readonly name: ${JSON.stringify(name)};
  readonly size: ${String(type.size)};
  readonly align: ${String(type.align)};
  /** Bytes between elements of an array<${name}>. */
  readonly stride: ${String(strideOf(type))};
  readonly fields: {
${layouts.join("")}  };
  /** Packs one value into a new buffer of ${String(type.size)} bytes. */
  pack(value: ${name}): ArrayBuffer;
  /** Packs values at the array stride, ready for an array<${name}> storage buffer. */
  packArray(values: readonly ${name}[]): ArrayBuffer;
  write(data: ${data}, offset: number, value: ${name}): void;
  unpack(data: ${data}, offset?: number): ${name};
  unpackArray(data: ${data}): ${name}[];
};
`;
  });
  const bindings = module.resources.map((resource) => {
    const minSize = resource.type.k === "array" && resource.type.n === null
      ? strideOf(resource.type.element)
      : layoutOf(resource.type)?.size ?? 0;
    return ts`  readonly ${source(resource.name)}: { readonly group: ${String(resource.group)}; readonly binding: ${String(resource.binding)}; readonly space: "${resource.space}"; readonly access: "${resource.access}"; readonly type: ${JSON.stringify(show(resource.type))}; readonly minSize: ${String(minSize)} };${"\n"}`;
  });
  const entries = module.kernels.map((kernel) =>
    ts`  readonly ${source(kernel.name)}: { readonly stage: "compute"; readonly workgroupSize: readonly [${kernel.size.join(", ")}] };${"\n"}`
  );
  const names = module.kernels.map((kernel) => JSON.stringify(kernel.name.text)).join(" | ") || "never";
  const buffers = module.resources.map((resource) => `readonly ${resource.name.text}: ${data}`).join("; ");
  return ts`${structs}/** The module as WGSL, ready for device.createShaderModule({ code: wgsl }). */
export declare const wgsl: string;
export declare const bindings: {
${bindings}};
export declare const entryPoints: {
${entries}};
/**
 * Runs a compute entry point on the CPU over the given number of workgroups, reading and writing the
 * given buffers in place. Out-of-bounds accesses throw instead of being clamped.
 */
export declare function dispatch(entry: ${names}, workgroups: number | readonly [number, number?, number?], buffers: { ${buffers} }): void;
`;
};
