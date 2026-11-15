/**
 * The example languages and the files each one opens with, read from `examples/` at build time.
 * A `.ts` file is TypeScript that imports the guest files, from `examples/typescript/` with its
 * imports pointed at the flat file set; it is what Run executes.
 */
import advancedMain from "../../../examples/advanced/main.advanced?raw";
import advancedStdlib from "../../../examples/advanced/stdlib.advanced?raw";
import advancedTrees from "../../../examples/advanced/trees.advanced?raw";
import calcGrammar from "../../../examples/calc/calc.parl?raw";
import calcDemo from "../../../examples/calc/demo.calc?raw";
import calcImports from "../../../examples/calc/imports.calc?raw";
import calcLib from "../../../examples/calc/lib.calc?raw";
import machineOrder from "../../../examples/machine/order.machine?raw";
import schemaBlog from "../../../examples/schema/blog.schema?raw";
import schemaCatalog from "../../../examples/schema/catalog.schema?raw";
import shadeParticles from "../../../examples/shade/particles.gpu?raw";
import advancedTs from "../../../examples/typescript/advanced.ts?raw";
import calcTs from "../../../examples/typescript/calc.ts?raw";
import catalogTs from "../../../examples/typescript/catalog.ts?raw";
import machineTs from "../../../examples/typescript/machine.ts?raw";
import shadeTs from "../../../examples/typescript/shade.ts?raw";

export type ExampleFile = { readonly name: string; readonly text: string };

export type Example = {
  readonly id: string;
  readonly label: string;
  readonly files: readonly ExampleFile[];
  /** The file Run executes when the active tab is not runnable. */
  readonly entry: string;
  /** How Run behaves: run modules, show that it needs Node, or nothing to run. */
  readonly run: "module" | "node" | "none";
};

/** The repository's TypeScript example, importing from the playground's flat file set. */
const flat = (text: string): string => text.replace(/"\.\.\/[a-z]+\//g, '"./');

const shadeGpu = `import * as kernel from "./particles.gpu";
import { type Particle, Particle as Layout, Params } from "./particles.gpu";
import { device, dispatch } from "playground";

// Struct layouts follow WGSL rules: vec3f aligns to 16 bytes.
console.log("Particle", Layout.size, Layout.fields.velocity.offset);
console.log("Params", Params.size, Params.fields.gravity.offset);

const start: Particle[] = [
  { position: [0, 1, 0], velocity: [1, 0, 0], color: [1, 0.5, 0, 1], age: 0 },
  {
    position: [0, 0.05, 0],
    velocity: [0, -2, 0],
    color: [0, 0.5, 1, 1],
    age: 1.5,
  },
];
const particles = Layout.packArray(start);
const params = Params.pack({
  dt: 0.1,
  gravity: [0, -9.8, 0],
  drag: 0.5,
  lifetime: 2,
});

// One step on WebGPU where the browser has it (else the CPU): the
// emitted WGSL and the same packed buffers, read back in place.
await dispatch(kernel, "simulate", 1, { params, particles });
console.log("ran on", device);

const round = (values: readonly number[]) =>
  values.map((value) => value.toFixed(3)).join(" ");
for (const p of Layout.unpackArray(particles)) {
  console.log(
    "particle",
    round(p.position),
    "|",
    round(p.velocity),
    "| alpha",
    p.color[3].toFixed(3),
  );
}
`;

export const examples: readonly Example[] = [
  {
    id: "calc",
    label: "calc",
    files: [
      { name: "demo.calc", text: calcDemo },
      { name: "imports.calc", text: calcImports },
      { name: "lib.calc", text: calcLib },
      { name: "calc.ts", text: flat(calcTs) },
    ],
    entry: "calc.ts",
    run: "module",
  },
  {
    id: "advanced",
    label: "advanced",
    files: [
      { name: "main.advanced", text: advancedMain },
      { name: "stdlib.advanced", text: advancedStdlib },
      { name: "trees.advanced", text: advancedTrees },
      { name: "advanced.ts", text: flat(advancedTs) },
    ],
    entry: "advanced.ts",
    run: "module",
  },
  {
    id: "schema",
    label: "schema",
    files: [
      { name: "catalog.schema", text: schemaCatalog },
      { name: "blog.schema", text: schemaBlog },
      { name: "catalog.ts", text: flat(catalogTs) },
    ],
    entry: "catalog.ts",
    run: "node",
  },
  {
    id: "machine",
    label: "machine",
    files: [
      { name: "order.machine", text: machineOrder },
      { name: "machine.ts", text: flat(machineTs) },
    ],
    entry: "machine.ts",
    run: "module",
  },
  {
    id: "shade",
    label: "shade",
    files: [
      { name: "particles.gpu", text: shadeParticles },
      { name: "shade.ts", text: flat(shadeTs) },
      { name: "webgpu.ts", text: shadeGpu },
    ],
    entry: "shade.ts",
    run: "module",
  },
  {
    id: "grammar",
    label: "grammar (.parl)",
    files: [{ name: "calc.parl", text: calcGrammar }],
    entry: "calc.parl",
    run: "none",
  },
];

export const uriOf = (example: Example, name: string): string => `file:///${example.id}/${name}`;

export const isDriver = (name: string): boolean => name.endsWith(".ts");

