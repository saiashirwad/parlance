import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { runtimeModule } from "../src/runtime/index.ts";

const options = {
  data: { name: "demo" },
  from: "./runtime.mjs",
  exports: { start: "runtime.start" },
};

test("shared references are legal data, not a cycle", () => {
  const shared = { x: 1 };
  const text = runtimeModule({ ...options, data: { a: shared, b: shared } });
  assert.match(text, /const data = \{"a":\{"x":1\},"b":\{"x":1\}\};/);
});

test("a real cycle is rejected before serialization", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => runtimeModule({ ...options, data: cyclic }), /cycle/);
});

test("undefined, functions, symbols, and bigints are rejected with the key", () => {
  assert.throws(() => runtimeModule({ ...options, data: { value: undefined } }), /"value" is undefined/);
  assert.throws(() => runtimeModule({ ...options, data: { value: () => 1 } }), /"value" is not serializable/);
  assert.throws(() => runtimeModule({ ...options, data: { value: Symbol("x") } }), /"value" is not serializable/);
  assert.throws(() => runtimeModule({ ...options, data: { value: 1n } }), /"value" is not serializable/);
});

test("imports, factory, default export, and export names are emitted as written", () => {
  const text = runtimeModule({
    data: [],
    from: "./runtime.mjs",
    imports: ["create", "go"],
    factory: "create(data, go)",
    exports: { default: "runtime", start: "runtime.start" },
  });
  assert.match(text, /import \{ create, go \} from "\.\/runtime\.mjs";/);
  assert.match(text, /const runtime = create\(data, go\);/);
  assert.match(text, /export default runtime;/);
  assert.match(text, /export const start = runtime\.start;/);
  assert.throws(
    () => runtimeModule({ ...options, exports: { "not-an-identifier": "1" } }),
    /not a valid identifier/,
  );
});

test("the emitted module runs and round-trips its data", async () => {
  const directory = mkdtempSync(join(tmpdir(), "parlance-runtime-"));
  try {
    writeFileSync(
      join(directory, "runtime.mjs"),
      "export const create = (data) => ({ start: () => data });\n",
    );
    const modulePath = join(directory, "module.mjs");
    writeFileSync(
      modulePath,
      runtimeModule({
        data: { list: [1, 2, 3], nested: { ok: true }, absent: null },
        from: new URL("./runtime.mjs", pathToFileURL(modulePath)).href,
        exports: { start: "runtime.start" },
      }),
    );
    const loaded = await import(pathToFileURL(modulePath).href) as { start: () => unknown };
    assert.deepEqual(loaded.start(), { list: [1, 2, 3], nested: { ok: true }, absent: null });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
