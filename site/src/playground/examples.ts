/**
 * The example languages and the files each one opens with, read from `examples/` at build time.
 * A `.js` file is a driver: plain JavaScript that imports the guest files and runs them.
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

const machineDriver = `import { start } from "./order.machine";

// The machine's runtime: send events, read the state.
const order = start();
console.log("start", order.state);
console.log("pay 25 ->", order.send({ type: "pay", amount: 25 }));
console.log("pay 50 ->", order.send({ type: "pay", amount: 50 }));
console.log("edit   ->", order.send({ type: "edit" }));
console.log("state", order.state, "last", order.lastEvent?.type);
`;

const shadeDriver = `import * as kernel from "./particles.gpu";
import { Particle, Params } from "./particles.gpu";
import { device, dispatch } from "playground";

// Struct layouts follow WGSL rules: vec3f aligns to 16 bytes.
console.log("Particle", Particle.size, "bytes; velocity at", Particle.fields.velocity.offset);
console.log("Params", Params.size, "bytes; gravity at", Params.fields.gravity.offset);

const particles = Particle.packArray([
  { position: [0, 1, 0], velocity: [1, 0, 0], color: [1, 0.5, 0, 1], age: 0 },
  { position: [0, 0.05, 0], velocity: [0, -2, 0], color: [0, 0.5, 1, 1], age: 1.5 },
]);
const params = Params.pack({ dt: 0.1, gravity: [0, -9.8, 0], drag: 0.5, lifetime: 2 });

// One step: 1 workgroup of 64 invocations, on the CPU or on WebGPU.
await dispatch(kernel, "simulate", 1, { params, particles });
console.log("ran on", device);

const round = (values) => values.map((value) => value.toFixed(3)).join(" ");
for (const p of Particle.unpackArray(particles)) {
  console.log("particle", round(p.position), "|", round(p.velocity), "| alpha", p.color[3].toFixed(3));
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
    ],
    entry: "demo.calc",
    run: "module",
  },
  {
    id: "advanced",
    label: "advanced",
    files: [
      { name: "main.advanced", text: advancedMain },
      { name: "stdlib.advanced", text: advancedStdlib },
      { name: "trees.advanced", text: advancedTrees },
    ],
    entry: "main.advanced",
    run: "module",
  },
  {
    id: "schema",
    label: "schema",
    files: [
      { name: "catalog.schema", text: schemaCatalog },
      { name: "blog.schema", text: schemaBlog },
    ],
    entry: "catalog.schema",
    run: "node",
  },
  {
    id: "machine",
    label: "machine",
    files: [
      { name: "order.machine", text: machineOrder },
      { name: "run.js", text: machineDriver },
    ],
    entry: "run.js",
    run: "module",
  },
  {
    id: "shade",
    label: "shade",
    files: [
      { name: "particles.gpu", text: shadeParticles },
      { name: "run.js", text: shadeDriver },
    ],
    entry: "run.js",
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

export const isDriver = (name: string): boolean => name.endsWith(".js");
