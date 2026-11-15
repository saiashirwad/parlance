import { gpu } from "./parlance.embeds";

// A shade snippet, keyed "Saxpy": y = a * x + y over two storage buffers.
const Saxpy = gpu("Saxpy")`
struct Params { a: f32, count: u32 }

uniform params: Params;
storage read xs: array<f32>;
storage read_write ys: array<f32>;

compute saxpy[64] {
  let i = global_id.x;
  if i >= params.count { return; }
  ys[i] = params.a * xs[i] + ys[i];
}
`;

const xs = new Float32Array([1, 2, 3, 4]);
const ys = new Float32Array([10, 20, 30, 40]);
Saxpy.dispatch("saxpy", 1, { params: Saxpy.Params.pack({ a: 2, count: xs.length }), xs, ys });

console.log([...ys].join(" "), Saxpy.bindings.ys.binding, Saxpy.entryPoints.saxpy.workgroupSize[0]);
