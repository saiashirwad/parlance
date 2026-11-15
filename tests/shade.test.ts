import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { Diagnostic } from "../src/diagnostic.ts";
import { analyze } from "../src/language.ts";
import type { ShadeModule } from "../examples/shade/check.ts";
import { describe } from "../examples/shade/emit.ts";
import { struct } from "../examples/shade/runtime.ts";
import { shade } from "../examples/shade/shade.ts";

type Message = Record<string, any>;

const root = new URL("..", import.meta.url).pathname;
const particlesPath = join(root, "examples/shade/particles.gpu");
const particles = readFileSync(particlesPath, "utf8");

const run = (source: string) => analyze(shade, source, "file:///virtual/test.gpu");

/** Each diagnostic as [message, guest text under its span]. */
const report = (source: string): [string, string][] =>
  run(source).diagnostics.map((entry: Diagnostic) => [entry.message, source.slice(entry.span.start, entry.span.end)]);

const only = (source: string): Diagnostic => {
  const { diagnostics } = run(source);
  assert.equal(diagnostics.length, 1, diagnostics.map((entry) => entry.message).join("\n"));
  return diagnostics[0]!;
};

const applyFix = (source: string, diagnostic: Diagnostic): string => {
  const edits = [...diagnostic.fix!.edits].sort((a, b) => b.span.start - a.span.start);
  return edits.reduce((text, edit) => text.slice(0, edit.span.start) + edit.newText + text.slice(edit.span.end), source);
};

const kernel = (body: string): string => `compute main[1] {\n${body}\n}`;

const structs = (source: string) => {
  const analysis = run(source);
  assert.deepEqual(analysis.diagnostics, []);
  return Object.fromEntries((analysis.ir as ShadeModule).structs.map((entry) => [entry.name.text, entry.type]));
};

const offsets = (type: { fields: readonly { name: string; offset: number }[] }) =>
  Object.fromEntries(type.fields.map((field) => [field.name, field.offset]));

// ---- grammar --------------------------------------------------------------------------------

test("particles.gpu parses and checks without diagnostics", () => {
  const analysis = run(particles);
  assert.deepEqual(analysis.diagnostics, []);
  assert.equal(analysis.valid, true);
  const module = analysis.ir as ShadeModule;
  assert.deepEqual(module.structs.map((entry) => entry.name.text), ["Particle", "Params"]);
  assert.deepEqual(module.kernels.map((entry) => entry.name.text), ["simulate"]);
});

test("a broken function body yields a parse diagnostic and later items are still checked", () => {
  const source = "fn a(x: f32) -> f32 {\n  let y = x * ;\n  return y;\n}\n\nfn b() -> f32 {\n  return nope;\n}\n";
  const diagnostics = run(source).diagnostics;
  assert.deepEqual(diagnostics.map((entry) => entry.code), ["parse/missing", undefined]);
  assert.match(diagnostics[0]!.message, /^Expected /);
  assert.deepEqual(report(source).slice(1), [['Unknown name "nope"', "nope"]]);
});

// ---- checker diagnostics --------------------------------------------------------------------

test("swizzles: component outside the vector and mixed component sets", () => {
  assert.deepEqual(report(kernel("let v = vec2f(1.0, 2.0);\nlet z = v.z;")), [['vec2f has no component "z"', "z"]]);
  assert.deepEqual(report(kernel("let v = vec4f(1.0);\nlet z = v.xg;")), [['Swizzle "xg" mixes xyzw and rgba components', "xg"]]);
  assert.deepEqual(report(kernel("let v = vec4f(1.0);\nlet z = v.xyzwx;")), [["A swizzle has at most 4 components, found 5", "xyzwx"]]);
});

test("mixing i32 and f32 reports the operator and offers an f32(...) fix", () => {
  const source = "fn f(a: i32) -> f32 {\n  var x: f32 = 1.0;\n  return a * x;\n}\n";
  const diagnostic = only(source);
  assert.equal(diagnostic.message, 'Cannot mix i32 and f32 in "*"; convert one side, as in f32(a)');
  assert.equal(source.slice(diagnostic.span.start, diagnostic.span.end), "*");
  assert.equal(diagnostic.fix!.title, "Convert with f32(...)");
  assert.deepEqual(diagnostic.fix!.edits.map((edit) => [source.slice(edit.span.start, edit.span.end), edit.newText]), [["", "f32("], ["", ")"]]);
  assert.equal(applyFix(source, diagnostic), "fn f(a: i32) -> f32 {\n  var x: f32 = 1.0;\n  return f32(a) * x;\n}\n");
  assert.deepEqual(run(applyFix(source, diagnostic)).diagnostics, []);
});

test("assigning to a let offers to declare it with var", () => {
  const source = kernel("let a = 1;\na = 2;");
  const diagnostic = only(source);
  assert.equal(diagnostic.message, "Cannot assign to a: it is a let; declare it with var to change it");
  assert.equal(source.slice(diagnostic.span.start, diagnostic.span.end), "a");
  const fixed = applyFix(source, diagnostic);
  assert.equal(fixed, kernel("var a = 1;\na = 2;"));
  assert.deepEqual(run(fixed).diagnostics, []);
});

test("assignment targets: parameters, loop variables, and multi-component swizzles", () => {
  assert.deepEqual(report("fn f(a: i32) -> i32 {\n  a = 2;\n  return a;\n}"), [["Cannot assign to parameter a; copy it into a var first", "a"]]);
  assert.deepEqual(report(kernel("for i in 0..3 {\n i = 2;\n}")), [["Cannot assign to loop variable i", "i"]]);
  assert.deepEqual(report(kernel("var v = vec3f(1.0);\nv.xy = vec2f(1.0);")), [
    ["Cannot assign to a multi-component swizzle; assign one component at a time or build a new vector", "v.xy"],
  ]);
});

test("an unknown builtin offers a did-you-mean fix", () => {
  const source = kernel("let v = normalise(vec3f(1.0));");
  const diagnostic = only(source);
  assert.equal(diagnostic.message, 'Unknown function "normalise"');
  assert.equal(source.slice(diagnostic.span.start, diagnostic.span.end), "normalise");
  assert.equal(diagnostic.fix!.title, 'Did you mean "normalize"?');
  assert.equal(applyFix(source, diagnostic), kernel("let v = normalize(vec3f(1.0));"));
});

test("builtin calls check argument count and types", () => {
  assert.deepEqual(report(kernel("let w = vec3f(1.0);\nlet d = dot(w);")), [["dot(a, b) takes 2 arguments, found 1", "dot(w)"]]);
  assert.deepEqual(report(kernel("let w = vec3f(1.0);\nvar a: f32 = 1.0;\nvar b: f32 = 2.0;\nlet c = clamp(w, a, b);")), [
    ["clamp(e, low, high) needs arguments of one numeric type; found vec3f, f32, f32", "clamp(w, a, b)"],
  ]);
  assert.deepEqual(report(kernel("let n = normalize(1.0);")), [["normalize(v) needs a float vector; found float literal", "normalize(1.0)"]]);
});

test("a function that does not return on every path is reported at its name", () => {
  assert.deepEqual(report("fn f(a: i32) -> i32 {\n  if a > 1 { return 1; }\n}"), [["f must return a value of type i32 on every path", "f"]]);
  assert.deepEqual(report("fn f(a: i32) -> i32 {\n  if a > 1 { return 1; } else { return 2; }\n}"), []);
});

test("writing read-only storage offers read_write; uniforms cannot be written", () => {
  const plain = "struct P { a: f32 }\nstorage buf: array<P>;\ncompute main[1] {\n  buf[0].a = 1.0;\n}\n";
  const diagnostic = only(plain);
  assert.equal(diagnostic.message, "buf is read-only storage; declare it as storage read_write to write to it");
  assert.equal(plain.slice(diagnostic.span.start, diagnostic.span.end), "buf[0].a");
  assert.equal(applyFix(plain, diagnostic), plain.replace("storage buf", "storage read_write buf"));

  const explicit = "storage read buf: array<f32>;\ncompute main[1] {\n  buf[0] = 1.0;\n}\n";
  assert.equal(applyFix(explicit, only(explicit)), explicit.replace("storage read buf", "storage read_write buf"));

  const uniform = "struct P { a: f32 }\nuniform u: P;\ncompute main[1] {\n  u.a = 1.0;\n}\n";
  assert.deepEqual(report(uniform), [["u is a uniform buffer, which shaders can only read", "u.a"]]);
});

test("compute inputs are only available in a compute entry point and are read-only", () => {
  assert.deepEqual(report("fn f() -> u32 {\n  return global_id.x;\n}"), [
    ["global_id is only available inside a compute entry point; pass it in as a parameter", "global_id"],
  ]);
  assert.deepEqual(report(kernel("global_id = vec3u(1u);")), [["global_id is a builtin input and is read-only", "global_id"]]);
});

test("buffer type restrictions: bool, runtime arrays, and uniform strides", () => {
  assert.deepEqual(report("struct P { a: bool }\nuniform u: P;"), [["P cannot be stored in a buffer: bool has no memory layout, so use u32", "P"]]);
  const runtime = "A runtime-sized array is only allowed as a storage buffer's type; give it a length, as in array<f32, 4>";
  assert.deepEqual(report("uniform u: array<f32>;"), [[runtime, "array<f32>"]]);
  assert.deepEqual(report("struct P { a: array<f32> }"), [[runtime, "array<f32>"]]);
  assert.deepEqual(report("uniform u: array<f32, 4>;"), [
    ["u has a 4-byte array stride; uniform buffers need a multiple of 16 (use vec4 elements or a padded struct)", "array<f32, 4>"],
  ]);
  assert.deepEqual(report("uniform u: array<vec4f, 4>;"), []);
});

test("duplicate bindings, recursion, break outside a loop, and workgroup limits", () => {
  const dup = "@group(0) @binding(1) uniform a: f32;\n@group(0) @binding(1) uniform b: f32;";
  assert.deepEqual(report(dup), [["@group(0) @binding(1) is already used by a", "b"]]);
  assert.deepEqual(report("fn a(x: i32) -> i32 {\n  return b(x);\n}\nfn b(x: i32) -> i32 {\n  return a(x);\n}"), [
    ["a is recursive (a -> b -> a); shader functions cannot recurse", "a"],
  ]);
  assert.deepEqual(report(kernel("break;")), [["break is only allowed inside a loop", "break;"]]);
  const limits = "exceeds WebGPU's default limits (x, y <= 256, z <= 64, 256 invocations)";
  assert.deepEqual(report("compute main[512] {\n}"), [[`Workgroup size [512, 1, 1] ${limits}`, "512"]]);
  assert.deepEqual(report("compute main[16, 16, 2] {\n}"), [[`Workgroup size [16, 16, 2] ${limits}`, "16"]]);
  assert.deepEqual(report("compute main[16, 16, 1] {\n}"), []);
});

test("reserved WGSL words and builtin names cannot be declared", () => {
  assert.deepEqual(report("fn mod() {}"), [['"mod" is reserved in WGSL; pick another name', "mod"]]);
  // The name is still bound, so its uses do not cascade into "Unknown name".
  assert.deepEqual(report("fn f(target: i32) -> i32 { return target; }"), [['"target" is reserved in WGSL; pick another name', "target"]]);
  assert.deepEqual(report("struct vec3f { a: f32 }"), [['"vec3f" names a builtin type; pick another name', "vec3f"]]);
  assert.deepEqual(report("fn clamp() {}"), [['"clamp" names a builtin function; pick another name', "clamp"]]);
});

test("a missing struct field offers a did-you-mean fix", () => {
  const source = "struct S { speed: f32 }\nfn f(s: S) -> f32 {\n  return s.sped;\n}\n";
  const diagnostic = only(source);
  assert.equal(diagnostic.message, 'S has no field "sped"');
  assert.equal(source.slice(diagnostic.span.start, diagnostic.span.end), "sped");
  assert.equal(applyFix(source, diagnostic), source.replace("s.sped", "s.speed"));
});

// ---- layout ---------------------------------------------------------------------------------

test("struct layout matches the WGSL spec's offsets, alignment, and size", () => {
  const { S } = structs("struct S { a: f32, b: vec3f, c: vec2f, d: mat3x3f, e: array<f32, 3>, f: u32 }");
  assert.deepEqual(offsets(S!), { a: 0, b: 16, c: 32, d: 48, e: 96, f: 108 });
  assert.equal(S!.align, 16);
  assert.equal(S!.size, 112);
});

test("matrix and array sizes follow WGSL", () => {
  const { M } = structs(
    "struct M { a: mat2x2f, b: mat4x3f, c: mat3x2f, d: vec3f, e: array<vec3f, 2>, f: array<vec2f, 3>, g: array<u32, 3> }",
  );
  const field = (name: string) => M!.fields.find((entry) => entry.name === name)!;
  assert.deepEqual([field("a").align, field("a").size], [8, 16]);
  assert.deepEqual([field("b").align, field("b").size], [16, 64]);
  assert.deepEqual([field("c").align, field("c").size], [8, 24]);
  assert.deepEqual([field("d").align, field("d").size], [16, 12]);
  assert.deepEqual([field("e").align, field("e").size], [16, 32]);
  assert.deepEqual([field("f").align, field("f").size], [8, 24]);
  assert.deepEqual([field("g").align, field("g").size], [4, 12]);
});

test("@align and @size shift later offsets", () => {
  const { A } = structs("struct A { a: f32, @align(16) b: f32, @size(32) c: f32, d: f32 }");
  assert.deepEqual(offsets(A!), { a: 0, b: 16, c: 20, d: 52 });
  assert.equal(A!.align, 16);
  assert.equal(A!.size, 64);
  assert.deepEqual(report("struct A { @align(3) a: f32 }"), [["@align(3) must be a power of two", "@align(3)"]]);
  assert.deepEqual(report("struct A { @size(2) a: f32 }"), [["@size(2) is below f32's size of 4", "@size(2)"]]);
});

test("Particle and Params in particles.gpu have the documented layout", () => {
  const { Particle, Params } = structs(particles);
  assert.equal(Particle!.size, 64);
  assert.equal(Particle!.align, 16);
  assert.deepEqual(offsets(Particle!), { position: 0, velocity: 16, color: 32, age: 48 });
  assert.equal(Params!.size, 48);
  assert.deepEqual(offsets(Params!), { dt: 0, gravity: 16, drag: 28, lifetime: 32 });
});

// ---- WGSL -----------------------------------------------------------------------------------

const wgslOf = (source: string): string => {
  const analysis = run(source);
  assert.deepEqual(analysis.diagnostics, []);
  return shade.targets!.wgsl!(analysis.ir).text;
};

test("particles.gpu emits the expected WGSL", () => {
  const text = wgslOf(particles);
  for (
    const expected of [
      "@compute @workgroup_size(64, 1, 1)",
      "var<storage, read_write> particles: array<Particle>;",
      "@group(0) @binding(0) var<uniform> params: Params;",
      "@builtin(global_invocation_id) global_id: vec3u",
      "arrayLength(&particles)",
    ]
  ) assert.ok(text.includes(expected), expected);
  assert.equal(shade.targets!.wgsl!(run(particles).ir).fileName, "shader.wgsl");
});

const matrices = `struct Camera {
  view: mat4x4f,
  proj: mat4x4f,
  eye: vec3f,
}

uniform camera: Camera;
storage read_write points: array<vec4f>;

fn project(p: vec4f) -> vec4f {
  let m = camera.proj * camera.view;
  return m * p;
}

compute transform[8, 8] {
  let i = global_id.x + global_id.y * 8u;
  if i >= len(points) { return; }
  var p = points[i];
  p.x = p.z;
  let q = project(vec4f(p.xyz, 1.0));
  let t = transpose(mat2x2f(1.0, 0.0, 0.0, 1.0));
  points[i] = q * t[0].x + vec4f(camera.eye, 0.0).wzyx;
}
`;

const control = `struct Hit {
  point: vec3f,
  dist: f32,
}

storage read_write hits: array<Hit>;
storage read_write counts: array<u32>;

fn measure(a: vec3f, b: vec3f) -> Hit {
  let n = normalize(cross(a, b));
  let d = select(1.0, length(a - b), dot(n, a) > 0.0);
  return Hit(mix(a, b, 0.5), d);
}

compute march[16] {
  let i = global_id.x;
  var total = 0.0;
  for k in 0..4 {
    total += f32(k) * 0.5;
  }
  var n = 0u;
  while n < 10u {
    n += 1u;
    if n == 7u { break; }
  }
  counts[i] = n;
  hits[i] = measure(vec3f(1.0, 0.0, 0.0), vec3f(0.0, total, 1.0));
}
`;

const naga = process.env.NAGA ?? "naga";
const nagaInstalled = spawnSync(naga, ["--version"]).status === 0;

test("naga validates the emitted WGSL", (t) => {
  if (!nagaInstalled) return t.skip("naga not installed");
  const directory = mkdtempSync(join(tmpdir(), "shade-naga-"));
  try {
    for (const [name, source] of Object.entries({ particles, matrices, control })) {
      const file = join(directory, `${name}.wgsl`);
      writeFileSync(file, wgslOf(source));
      const result = spawnSync(naga, [file], { encoding: "utf8" });
      assert.equal(result.status, 0, `${name}\n${result.stdout}${result.stderr}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// ---- runtime through the Node loader --------------------------------------------------------

const node = (args: string[], cwd = root) => spawnSync(process.execPath, args, { cwd, encoding: "utf8" });

test("examples/typescript/shade.ts runs through the loader", () => {
  const result = node(["--import", "./examples/register.ts", "examples/typescript/shade.ts"]);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split("\n");
  assert.ok(lines.includes("Particle 64 16 16"), result.stdout);
  assert.ok(lines.includes("Params 48 16 28"), result.stdout);
  assert.ok(lines.includes("bindings 0 1 64x1x1"), result.stdout);
  assert.ok(lines.includes("@compute @workgroup_size(64, 1, 1)"), result.stdout);
  assert.equal(lines.filter((line) => line.startsWith("particle ")).length, 2);
});

const saxpy = `uniform params: Params;
storage read_write xs: array<f32>;
storage read_write ys: array<f32>;
storage read_write words: array<u32>;
storage read_write ints: array<i32>;

struct Params {
  a: f32,
  n: u32,
}

compute saxpy[4] {
  let i = global_id.x;
  if i >= len(xs) { return; }
  ys[i] = params.a * xs[i] + ys[i];
  words[i] = 4294967295u + i;
  var minus: i32 = -7;
  var zero: i32 = 0;
  ints[i] = minus / 2 * 1000 + minus % 3 * 100 + minus / zero * 0;
}
`;

/** Writes `source` to a temp .gpu file under the repo and runs `body` as a module that imports it as `g`. */
const runGuest = (source: string, body: string, flags: string[] = []) => {
  const directory = mkdtempSync(join(root, ".shade-"));
  try {
    const guest = join(directory, "guest.gpu");
    writeFileSync(guest, source);
    const script = `import * as g from ${JSON.stringify(pathToFileURL(guest).href)};\n${body}`;
    return { ...node([...flags, "--import", "./examples/register.ts", "--input-type=module", "-e", script]), guest };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test("a CPU dispatch computes saxpy with u32 wrap-around and i32 division", () => {
  const result = runGuest(
    saxpy,
    `const xs = new Float32Array([1, 2, 3]);
const ys = new Float32Array([10, 20, 30]);
const words = new Uint32Array(3);
const ints = new Int32Array(3);
g.dispatch("saxpy", 1, { params: g.Params.pack({ a: 2, n: 3 }), xs, ys, words, ints });
console.log(JSON.stringify({ ys: [...ys], words: [...words], ints: [...ints], size: g.Params.size, bindings: Object.keys(g.bindings) }));`,
  );
  assert.equal(result.status, 0, result.stderr);
  // -7 / 2 truncates to -3, -7 % 3 is -1, and x / 0 is x.
  assert.equal(
    result.stdout,
    JSON.stringify({
      ys: [12, 24, 36],
      words: [4294967295, 0, 1],
      ints: [-3100, -3100, -3100],
      size: 8,
      bindings: ["params", "xs", "ys", "words", "ints"],
    }) + "\n",
  );
});

test("an out-of-bounds write throws a RangeError whose stack points into the .gpu file", () => {
  const source = "storage read_write xs: array<f32>;\n\ncompute oob[1] {\n  xs[5] = 1.0;\n}\n";
  const result = runGuest(
    source,
    `try { g.dispatch("oob", 1, { xs: new Float32Array(2) }); } catch (error) { console.log(JSON.stringify([error.name, error.message, error.stack])); }`,
    ["--enable-source-maps"],
  );
  assert.equal(result.status, 0, result.stderr);
  const [name, message, stack] = JSON.parse(result.stdout);
  assert.equal(name, "RangeError");
  assert.equal(message, "Index 5 is out of bounds for array<f32> (length 2)");
  assert.match(stack, /at Object\.k_oob \(.*guest\.gpu:4:3\)/);
});

test("a guest type error fails the import with a SyntaxError naming the position", () => {
  const result = runGuest("compute bad[1] {\n  let x = 1 + true;\n}\n", "console.log(Object.keys(g));");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SyntaxError: .*guest\.gpu: 2:15 error: "\+" needs numbers, found bool/);
});

// ---- pack and unpack ------------------------------------------------------------------------

const packed = (() => {
  const { Sample } = structs("struct Sample { position: vec3f, rotation: mat2x2f, id: u32, delta: i32, tint: vec2f }");
  return { type: Sample!, layout: struct(describe(Sample!) as Parameters<typeof struct>[0]) };
})();

test("struct() packs a value at its WGSL offsets", () => {
  const { type, layout } = packed;
  assert.deepEqual(offsets(type), { position: 0, rotation: 16, id: 32, delta: 36, tint: 40 });
  assert.deepEqual([layout.size, layout.align, layout.stride], [48, 16, 48]);
  const value = { position: [1, 2, 3], rotation: [[4, 5], [6, 7]], id: 4294967295, delta: -2, tint: [0.5, 8] };
  const bytes = layout.pack(value);
  assert.equal(bytes.byteLength, 48);
  const view = new DataView(bytes);
  assert.deepEqual([0, 4, 8].map((at) => view.getFloat32(at, true)), [1, 2, 3]);
  assert.equal(view.getFloat32(12, true), 0, "padding after vec3f is untouched");
  assert.deepEqual([16, 20, 24, 28].map((at) => view.getFloat32(at, true)), [4, 5, 6, 7]);
  assert.equal(view.getUint32(32, true), 4294967295);
  assert.equal(view.getInt32(36, true), -2);
  assert.deepEqual([40, 44].map((at) => view.getFloat32(at, true)), [0.5, 8]);
  assert.deepEqual(layout.unpack(bytes), value);
});

test("packArray strides elements and unpackArray reads them back", () => {
  const { layout } = packed;
  const values = [1, 2].map((id) => ({ position: [id, 0, 0], rotation: [[1, 0], [0, 1]], id, delta: -id, tint: [id, id] }));
  const bytes = layout.packArray(values);
  assert.equal(bytes.byteLength, 96);
  assert.equal(new DataView(bytes).getUint32(48 + 32, true), 2);
  assert.deepEqual(layout.unpackArray(bytes), values);
  assert.deepEqual(layout.unpackArray(new Uint8Array(bytes, 48)), [values[1]]);
});

test("a wrong-shaped value throws a TypeError naming the path", () => {
  const { layout } = packed;
  const good = { position: [1, 2, 3], rotation: [[1, 0], [0, 1]], id: 1, delta: 1, tint: [0, 0] };
  assert.throws(() => layout.pack({ ...good, position: [1, 2] }), { name: "TypeError", message: "Sample.position: expected 3 numbers, found an array of 2" });
  assert.throws(() => layout.pack({ ...good, rotation: [[1, 0], [0]] }), { name: "TypeError", message: "Sample.rotation[1]: expected 2 numbers, found an array of 1" });
  assert.throws(() => layout.pack({ ...good, id: "7" }), { name: "TypeError", message: "Sample.id: expected a number (u32), found string" });
  assert.throws(() => layout.packArray([good, { ...good, tint: 1 }]), { name: "TypeError", message: "Sample[1].tint: expected 2 numbers, found number" });
});

// ---- TypeScript surface ---------------------------------------------------------------------

test("the TypeScript surface declares layouts and a typed dispatch", () => {
  const text = shade.typescript!(run(particles).ir as ShadeModule).text;
  for (
    const expected of [
      "readonly size: 64;",
      "readonly stride: 64;",
      "export interface Particle {",
      "readonly position: readonly [number, number, number];",
      'export declare function dispatch(entry: "simulate"',
      "readonly particles: ArrayBuffer | ArrayBufferView",
      'readonly type: "array<Particle>"',
    ]
  ) assert.ok(text.includes(expected), expected);
});

class Client {
  readonly child: ChildProcessWithoutNullStreams;
  #pending = Buffer.alloc(0);
  #waiting = new Map<number, { resolve: (value: Message) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout }>();
  #next = 1;
  #logs = "";

  constructor(command: string, args: string[]) {
    this.child = spawn(command, args, { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (chunk: Buffer) => this.#receive(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.#logs = `${this.#logs}${chunk.toString()}`.slice(-8000);
    });
    this.child.on("exit", (code, signal) => {
      for (const entry of this.#waiting.values()) entry.reject(new Error(`LSP exited ${code ?? signal}\n${this.#logs}`));
      this.#waiting.clear();
    });
  }

  #receive(chunk: Buffer): void {
    this.#pending = Buffer.concat([this.#pending, chunk]);
    for (;;) {
      const end = this.#pending.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = /Content-Length: *(\d+)/i.exec(this.#pending.subarray(0, end).toString())?.[1];
      if (length === undefined) {
        this.#pending = this.#pending.subarray(end + 4);
        continue;
      }
      const stop = end + 4 + Number(length);
      if (this.#pending.length < stop) return;
      const message = JSON.parse(this.#pending.subarray(end + 4, stop).toString("utf8")) as Message;
      this.#pending = this.#pending.subarray(stop);
      if (message.id !== undefined && this.#waiting.has(message.id)) {
        const entry = this.#waiting.get(message.id)!;
        this.#waiting.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
        else entry.resolve(message.result);
        continue;
      }
      if (typeof message.method === "string" && message.id !== undefined) {
        let result: unknown = null;
        if (message.method === "workspace/configuration") {
          result = (message.params?.items ?? []).map(() => ({}));
        } else if (message.method === "workspace/workspaceFolders") {
          result = [{ uri: pathToFileURL(root).href, name: "parlance" }];
        } else if (!["client/registerCapability", "window/workDoneProgress/create"].includes(message.method)) {
          this.#send({ id: message.id, error: { code: -32601, message: `Unsupported ${message.method}` } });
          continue;
        }
        this.#send({ id: message.id, result });
      }
    }
  }

  #send(message: Message): void {
    const body = JSON.stringify({ jsonrpc: "2.0", ...message });
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  request(method: string, params?: unknown): Promise<Message> {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id);
        reject(new Error(`timeout ${method}\n${this.#logs}`));
      }, 30_000);
      this.#waiting.set(id, { resolve, reject, timer });
      this.#send({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.#send({ method, params });
  }

  kill(): void {
    this.child.kill();
  }
}

const position = (source: string, needle: string, occurrence = 0) => {
  let index = -1;
  for (let count = 0; count <= occurrence; count++) index = source.indexOf(needle, index + 1);
  assert.ok(index >= 0, `missing ${needle}`);
  const before = source.slice(0, index).split("\n");
  return { line: before.length - 1, character: before.at(-1)!.length };
};

const hoverText = (hover: Message): string => typeof hover.contents === "string" ? hover.contents : hover.contents.value;

test("tsgo hovers and navigates from TypeScript into a shade file", async () => {
  const consumer = join(root, "examples/typescript/shade.ts");
  const source = readFileSync(consumer, "utf8");
  const guestUri = pathToFileURL(particlesPath).href;
  const client = new Client(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--lsp", "--stdio"]);
  try {
    await client.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(root).href,
      workspaceFolders: [{ uri: pathToFileURL(root).href, name: "parlance" }],
      initializationOptions: { runExternalCode: true },
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        textDocument: { hover: { contentFormat: ["markdown"] } },
      },
    });
    client.notify("initialized", {});
    const uri = pathToFileURL(consumer).href;
    client.notify("textDocument/didOpen", { textDocument: { uri, languageId: "typescript", version: 1, text: source } });

    const hover = await client.request("textDocument/hover", { textDocument: { uri }, position: position(source, "ParticleLayout", 1) });
    assert.match(hoverText(hover), /size: 64/);

    const definition = await client.request("textDocument/definition", { textDocument: { uri }, position: position(source, "Particle") });
    const locations = Array.isArray(definition) ? definition : [definition];
    const target = locations.find((entry) => entry.uri === guestUri || entry.targetUri === guestUri);
    assert.ok(target, `definition should land in particles.gpu: ${JSON.stringify(definition)}`);
    const range = target.range ?? target.targetSelectionRange;
    const lines = particles.split("\n");
    assert.equal(lines[range.start.line]!.slice(range.start.character, range.end.character), "Particle");
    assert.equal(lines[range.start.line], "struct Particle {");

    const diagnostics = await client.request("textDocument/diagnostic", { textDocument: { uri } });
    assert.deepEqual(diagnostics.items, []);
  } finally {
    client.kill();
  }
});

// ---- parlance LSP ---------------------------------------------------------------------------

class LspClient {
  readonly child: ChildProcessWithoutNullStreams;
  #pending = Buffer.alloc(0);
  #waiting = new Map<number, (value: Message) => void>();
  #notifications: Message[] = [];
  #next = 1;

  constructor() {
    this.child = spawn(process.execPath, ["src/lsp/cli.ts", "--config", "./parlance.config.ts"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (chunk: Buffer) => this.#receive(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      if (chunk.length) process.stderr.write(`[lsp] ${chunk.toString()}`);
    });
  }

  #receive(chunk: Buffer): void {
    this.#pending = Buffer.concat([this.#pending, chunk]);
    for (;;) {
      const end = this.#pending.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = /Content-Length: *(\d+)/i.exec(this.#pending.subarray(0, end).toString())?.[1];
      if (length === undefined) {
        this.#pending = this.#pending.subarray(end + 4);
        continue;
      }
      const stop = end + 4 + Number(length);
      if (this.#pending.length < stop) return;
      const message = JSON.parse(this.#pending.subarray(end + 4, stop).toString("utf8")) as Message;
      this.#pending = this.#pending.subarray(stop);
      if (message.id !== undefined && this.#waiting.has(message.id)) {
        this.#waiting.get(message.id)!(message);
        this.#waiting.delete(message.id);
      } else if (message.method) {
        this.#notifications.push(message);
      }
    }
  }

  send(message: Message): void {
    const body = JSON.stringify({ jsonrpc: "2.0", ...message });
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  request(method: string, params?: unknown): Promise<Message> {
    const id = this.#next++;
    return new Promise((resolve) => {
      this.#waiting.set(id, resolve);
      this.send({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ method, params });
  }

  async waitDiagnostics(uri: string, version: number): Promise<Message> {
    for (let attempt = 0; attempt < 400; attempt++) {
      const diagnostic = this.#notifications.find((message) =>
        message.method === "textDocument/publishDiagnostics" && message.params?.uri === uri && message.params?.version === version
      );
      if (diagnostic) return diagnostic;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`no diagnostics notification for version ${version}`);
  }

  async open(uri: string, text: string): Promise<Message> {
    this.notify("textDocument/didOpen", { textDocument: { uri, languageId: "shade", version: 1, text } });
    return this.waitDiagnostics(uri, 1);
  }

  close(): void {
    this.notify("shutdown");
    this.notify("exit");
    this.child.kill();
  }
}

const lspUri = pathToFileURL("/virtual/particles.gpu").href;

const withEditor = async (text: string, body: (client: LspClient, diagnostics: Message[]) => Promise<void>) => {
  const client = new LspClient();
  try {
    await client.request("initialize", { processId: null, rootUri: null, capabilities: {} });
    client.notify("initialized", {});
    const published = await client.open(lspUri, text);
    await body(client, published.params.diagnostics);
  } finally {
    client.close();
  }
};

const at = (source: string, needle: string, offset = 0, occurrence = 0) => {
  const found = position(source, needle, occurrence);
  return { line: found.line, character: found.character + offset };
};

test("the LSP hovers shade locals and functions", async () => {
  await withEditor(particles, async (client, diagnostics) => {
    assert.deepEqual(diagnostics, []);
    const hover = async (needle: string, offset = 0, occurrence = 0) =>
      hoverText((await client.request("textDocument/hover", { textDocument: { uri: lspUri }, position: at(particles, needle, offset, occurrence) })).result);
    assert.match(await hover("var p = particles[i];", 4), /Particle/);
    assert.match(await hover("let fade = remaining", 4), /f32/);
    assert.match(await hover("fn remaining", 4), /^fn\(f32\) -> f32$/);
    assert.equal(await hover("struct Particle", 8), "struct Particle (size 64, align 16)");
  });
});

test("the LSP completes builtin functions inside a function body", async () => {
  await withEditor(particles, async (client) => {
    const items: Message[] = (await client.request("textDocument/completion", {
      textDocument: { uri: lspUri },
      position: at(particles, "let fade", 4),
    })).result;
    const labels = items.map((item) => item.label);
    for (const label of ["normalize", "clamp", "remaining", "particles", "p"]) assert.ok(labels.includes(label), label);
    assert.equal(items.find((item) => item.label === "clamp")?.detail, "clamp(e, low, high)");
  });
});

test("the LSP shows inlay hints for inferred let and var types", async () => {
  await withEditor(particles, async (client) => {
    const result = (await client.request("textDocument/inlayHint", {
      textDocument: { uri: lspUri },
      range: { start: { line: 0, character: 0 }, end: { line: particles.split("\n").length, character: 0 } },
    })).result;
    const hints = result.map((hint: Message) => [hint.position, hint.label]);
    assert.deepEqual(hints.find(([, label]: [unknown, string]) => label === ": u32"), [at(particles, "let i = global_id.x", "let i".length), ": u32"]);
    assert.ok(hints.some(([, label]: [unknown, string]) => label === ": Particle"));
    assert.ok(hints.some(([, label]: [unknown, string]) => label === ": f32"));
  });
});

test("the LSP offers a did-you-mean code action for a misspelled builtin", async () => {
  const broken = particles.replace("let fade = remaining(p.age);", "let fade = remaining(p.age);\n  let n = normalise(p.position);");
  await withEditor(broken, async (client, diagnostics) => {
    const diagnostic = diagnostics.find((entry) => entry.message === 'Unknown function "normalise"')!;
    assert.ok(diagnostic, JSON.stringify(diagnostics));
    const actions = (await client.request("textDocument/codeAction", {
      textDocument: { uri: lspUri },
      range: diagnostic.range,
      context: { diagnostics: [diagnostic] },
    })).result;
    const fix = actions.find((action: Message) => action.title === 'Did you mean "normalize"?');
    assert.ok(fix, JSON.stringify(actions));
    assert.equal(fix.kind, "quickfix");
    assert.deepEqual(fix.edit.changes[lspUri], [{ range: diagnostic.range, newText: "normalize" }]);
  });
});
