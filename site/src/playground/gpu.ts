/// <reference types="@webgpu/types" />
/**
 * The `playground` module a driver imports: one `dispatch` that runs a shade kernel on the
 * CPU (the emitted dispatcher) or on WebGPU (the emitted WGSL), writing results back into the
 * same buffers either way.
 */

export type Device = "cpu" | "webgpu";

/** Where `dispatch` runs kernels in this run. */
export let device: Device = "cpu";

export const use = (next: Device): void => {
  device = next;
};

type Binding = { readonly group: number; readonly binding: number; readonly space: "uniform" | "storage"; readonly access: string; readonly minSize: number };

/** What a shade module exports. */
export type Kernel = {
  readonly wgsl: string;
  readonly bindings: Readonly<Record<string, Binding>>;
  readonly dispatch: (entry: string, workgroups: number | readonly number[], buffers: Record<string, ArrayBuffer | ArrayBufferView>) => void;
};

const bytesOf = (data: ArrayBuffer | ArrayBufferView): Uint8Array =>
  data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

export const dispatch = async (
  kernel: Kernel,
  entry: string,
  workgroups: number | readonly number[],
  buffers: Record<string, ArrayBuffer | ArrayBufferView>,
): Promise<void> => {
  if (device === "cpu") return kernel.dispatch(entry, workgroups, buffers);
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) {
    // A browser can have navigator.gpu and still no adapter; the CPU runs the same kernel.
    device = "cpu";
    return kernel.dispatch(entry, workgroups, buffers);
  }
  const gpu = await adapter.requestDevice();
  try {
    const module = gpu.createShaderModule({ code: kernel.wgsl });
    const problems = (await module.getCompilationInfo()).messages.filter((message) => message.type === "error");
    if (problems.length > 0) {
      throw new Error(problems.map((message) => `WGSL ${message.lineNum}:${message.linePos}: ${message.message}`).join("\n"));
    }
    const pipeline = await gpu.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: entry } });
    const groups = new Map<number, GPUBindGroupEntry[]>();
    const readBack: { buffer: GPUBuffer; target: Uint8Array }[] = [];
    for (const [name, binding] of Object.entries(kernel.bindings)) {
      const data = buffers[name];
      if (data === undefined) throw new TypeError(`dispatch(${JSON.stringify(entry)}): missing buffer ${JSON.stringify(name)}`);
      const bytes = bytesOf(data);
      const size = Math.ceil(Math.max(bytes.byteLength, binding.minSize) / 16) * 16;
      const usage = (binding.space === "uniform" ? GPUBufferUsage.UNIFORM : GPUBufferUsage.STORAGE)
        | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
      const buffer = gpu.createBuffer({ size, usage });
      gpu.queue.writeBuffer(buffer, 0, bytes);
      if (binding.access === "read_write") readBack.push({ buffer, target: bytes });
      groups.set(binding.group, [...(groups.get(binding.group) ?? []), { binding: binding.binding, resource: { buffer } }]);
    }
    const encoder = gpu.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    for (const [group, entries] of groups) pass.setBindGroup(group, gpu.createBindGroup({ layout: pipeline.getBindGroupLayout(group), entries }));
    const [x = 1, y = 1, z = 1] = typeof workgroups === "number" ? [workgroups] : workgroups;
    pass.dispatchWorkgroups(x, y, z);
    pass.end();
    const staging = readBack.map(({ buffer, target }) => {
      const copy = gpu.createBuffer({ size: buffer.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      encoder.copyBufferToBuffer(buffer, 0, copy, 0, buffer.size);
      return { copy, target };
    });
    gpu.queue.submit([encoder.finish()]);
    for (const { copy, target } of staging) {
      await copy.mapAsync(GPUMapMode.READ);
      target.set(new Uint8Array(copy.getMappedRange(0, target.byteLength)));
      copy.unmap();
    }
  } finally {
    gpu.destroy();
  }
};
