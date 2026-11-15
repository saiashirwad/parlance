import {
  bindings,
  dispatch,
  entryPoints,
  type Particle,
  Particle as ParticleLayout,
  Params,
  wgsl,
} from "../shade/particles.gpu";

// Layouts follow WGSL rules: vec3f aligns to 16 bytes,
// so Params.gravity starts at 16.
console.log(
  "Particle",
  ParticleLayout.size,
  ParticleLayout.align,
  ParticleLayout.fields.velocity.offset,
);
console.log(
  "Params",
  Params.size,
  Params.fields.gravity.offset,
  Params.fields.drag.offset,
);
console.log(
  "bindings",
  bindings.params.binding,
  bindings.particles.binding,
  entryPoints.simulate.workgroupSize.join("x"),
);

const start: Particle[] = [
  { position: [0, 1, 0], velocity: [1, 0, 0], color: [1, 0.5, 0, 1], age: 0 },
  {
    position: [0, 0.05, 0],
    velocity: [0, -2, 0],
    color: [0, 0.5, 1, 1],
    age: 1.5,
  },
];
const particles = ParticleLayout.packArray(start);
const params = Params.pack({
  dt: 0.1,
  gravity: [0, -9.8, 0],
  drag: 0.5,
  lifetime: 2,
});

// One step on the CPU: 1 workgroup of 64 invocations;
// the kernel skips ids past the array.
dispatch("simulate", 1, { params, particles });

const round = (values: readonly number[]) =>
  values.map((value) => Number(value.toFixed(3))).join(" ");
for (const particle of ParticleLayout.unpackArray(particles)) {
  console.log(
    "particle",
    round(particle.position),
    "|",
    round(particle.velocity),
    "| alpha",
    round([particle.color[3]]),
  );
}
console.log(wgsl.split("\n").find((line) => line.startsWith("@compute")));
