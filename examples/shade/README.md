# shade

A small, typed shader language for `.gpu` files, in the spirit of WGSL and TypeGPU. One file declares
data, buffers, and compute kernels; parlance checks it, emits WGSL, gives TypeScript typed layouts for
the buffers, and can run the kernels on the CPU in Node.

```gpu
struct Particle { position: vec3f, velocity: vec3f, color: vec4f, age: f32 }
struct Params { dt: f32, gravity: vec3f, drag: f32, lifetime: f32 }

uniform params: Params;
storage read_write particles: array<Particle>;

compute simulate[64] {
  let i = global_id.x;
  if i >= len(particles) { return; }
  var p = particles[i];
  p.velocity += params.gravity * params.dt;
  p.position += p.velocity * params.dt;
  particles[i] = p;
}
```

`particles.gpu` is the full example; `../typescript/shade.ts` packs particles, steps them once on the
CPU, and prints the results. `../embed/kernel.ts` writes a kernel inline as `gpu("Saxpy")`...``.

## The language

- Types: `f32 i32 u32 bool`, `vec2f`..`vec4u` (and `vec2b`..`vec4b`), `mat2x2f`..`mat4x4f`,
  `array<T, N>`, and structs. Fields take `@align(n)` and `@size(n)`.
- Buffers: `uniform name: T;`, `storage name: T;` (read-only), `storage read_write name: T;`. Group and
  binding default to group 0 and the next free binding; `@group(g) @binding(b)` sets them.
  `array<T>` (no length) is a runtime-sized array, allowed only as a storage buffer's type; `len(buf)`
  is its length.
- Functions: `fn name(a: T) -> R { ... }`. `let` is immutable, `var` is mutable. `if`/`else`,
  `while`, `for i in a..b`, `break`, `continue`, `return`. Recursion is rejected, as in WGSL.
- Entry points: `compute name[x, y, z] { ... }`. The body can read `global_id`, `local_id`,
  `workgroup_id`, `local_index`, and `num_workgroups`; the WGSL entry gets the `@builtin` parameters it uses.
- Expressions follow WGSL: no implicit int/float mixing (unsuffixed literals adapt), `vec * scalar`,
  `mat * vec`, swizzles (`v.xy`, `c.rgb`), constructors (`vec4f(v.xyz, 1.0)`, `Particle(...)`,
  `f32(i)`), and about 45 builtins with their overloads (`dot cross normalize length mix clamp min
  max abs select sqrt sin cos ...`).

## What the checker reports

Each at the offending span, with a quick fix where one edit resolves it: a bad or mixed swizzle,
`i32 * f32` (fix: wrap in `f32(...)`), assigning to a `let` (fix: `var`), a parameter, a uniform, or a
read-only storage buffer (fix: `read_write`), a multi-component swizzle write, an unknown builtin
(fix: did you mean), wrong argument counts or types, a missing return, `global_id` outside an entry
point, `bool` in a buffer, uniform layout rules (16-byte array strides), duplicate bindings,
workgroup sizes over WebGPU's limits, and WGSL reserved words.

## What TypeScript sees

`import { Particle, Params, bindings, entryPoints, dispatch, wgsl } from "./particles.gpu"`:

- `interface Particle` with vectors as number tuples (`readonly [number, number, number]`) and
  matrices as tuples of columns.
- A `Particle` value with the WGSL layout as literal types (`size: 64`, `fields.velocity.offset: 16`)
  and `pack`, `packArray`, `unpack`, `unpackArray`, `write`. They use a `DataView`, so they run anywhere.
- `wgsl`, the module as WGSL; `bindings` (group, binding, space, access, minimum size); `entryPoints`.
- `dispatch(entry, workgroups, buffers)` runs a compute entry point on the CPU against the buffers,
  writing results in place.

Targets: `./parlance emit --target wgsl examples/shade/particles.gpu`.

## Limits

- Compute only: no vertex or fragment stages, textures, samplers, atomics, or workgroup memory.
- No pointers, `loop`/`switch`, `const`/`override`, bitwise or shift operators, or array constructors.
- The CPU dispatcher runs invocations one after another. Without barriers or shared memory that
  matches the GPU result for race-free kernels. Out-of-bounds indexing throws instead of clamping.
- f32 math is rounded with `Math.fround` after each operation; builtins such as `sin` use JavaScript's
  double-precision results, so they can differ from a GPU in the last bits.
