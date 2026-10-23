import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { calc, type CalcModule } from "../examples/calc/calc.ts";
import { schema, type SchemaModule } from "../examples/schema/schema.ts";
import { ModuleGraph } from "../src/modules.ts";

const root = new URL("..", import.meta.url).pathname;

const memory = (
  files: Readonly<Record<string, string>>,
  languages = [schema],
): ModuleGraph =>
  new ModuleGraph({
    languages,
    read: (uri) => files[uri] ?? null,
  });

test("a missing import reports at the specifier span", () => {
  const source = "schema A\nimport \"./missing.schema\";\nmodel A { id: Int @primary }\n";
  const graph = memory({ "memory://dir/a.schema": source });
  const analysis = graph.analyze("memory://dir/a.schema");
  const missing = analysis.diagnostics.find((entry) => /Cannot resolve import/.test(entry.message));
  assert.ok(missing, analysis.diagnostics.map((entry) => entry.message).join("\n"));
  assert.equal(source.slice(missing.span.start, missing.span.end), "./missing.schema");
});

test("an import cycle reports one diagnostic and terminates", () => {
  const files = {
    "memory://dir/a.schema": "schema A\nimport \"./b.schema\";\nmodel A { id: Int @primary }\n",
    "memory://dir/b.schema": "schema B\nimport \"./a.schema\";\nmodel B { id: Int @primary }\n",
  };
  const graph = memory(files);
  const started = performance.now();
  const analysis = graph.analyze("memory://dir/a.schema");
  const elapsed = performance.now() - started;
  const cycles = analysis.diagnostics.filter((entry) => /Import cycle/.test(entry.message));
  assert.equal(cycles.length, 1, analysis.diagnostics.map((entry) => entry.message).join("\n"));
  assert.match(cycles[0]!.message, /a\.schema -> b\.schema -> a\.schema/);
  assert.equal(graph.order().length, 2);
  assert.ok(elapsed < 2000, `cycle took ${elapsed}ms`);
});

test("dependencies are analyzed before dependents", () => {
  const files = {
    "memory://dir/main.schema": "schema Main\nimport \"./base.schema\";\nmodel Main { id: Int @primary }\n",
    "memory://dir/base.schema": "schema Base\nimport \"./enum.schema\";\nmodel Base { id: Int @primary }\n",
    "memory://dir/enum.schema": "schema Enum\nenum Role { Member }\n",
  };
  const graph = memory(files);
  graph.analyze("memory://dir/main.schema");
  assert.deepEqual(graph.order(), [
    "memory://dir/enum.schema",
    "memory://dir/base.schema",
    "memory://dir/main.schema",
  ]);
});

test("dependency errors keep their origin and route to the import site", () => {
  const files = {
    "memory://dir/main.schema": "schema Main\nimport \"./broken.schema\";\nmodel Main { id: Int @primary }\n",
    "memory://dir/broken.schema": "schema Broken\nmodel Broken { name: String }\n",
  };
  const analysis = memory(files).analyze("memory://dir/main.schema");
  const routed = analysis.diagnostics.find((entry) => /needs an @primary field/.test(entry.message));
  assert.ok(routed, analysis.diagnostics.map((entry) => entry.message).join("\n"));
  assert.equal(routed.origin?.uri, "memory://dir/broken.schema");
  assert.equal(routed.location?.uri, "memory://dir/main.schema");
  assert.equal(analysis.source.slice(routed.span.start, routed.span.end), "./broken.schema");
});

test("a two-file schema imports a model and emits one SQL artifact", () => {
  const entry = new URL("../examples/schema/catalog.schema", import.meta.url).pathname;
  const graph = new ModuleGraph({ languages: [schema] });
  const analysis = graph.analyze(entry);
  assert.deepEqual(analysis.diagnostics, []);
  const module = analysis.ir as SchemaModule;
  assert.deepEqual(module.models.map((model) => model.name.text), ["User", "Post", "Catalog"]);
  const sql = schema.targets!.sql!(module).text;
  assert.match(sql, /CREATE TABLE "Catalog"/);
  assert.match(sql, /CREATE TABLE "User"/);
  assert.match(sql, /"owner" INTEGER NOT NULL REFERENCES "User"\("id"\)/);
  const types = schema.typescript!(module).text;
  assert.match(types, /export interface Catalog/);
  assert.match(types, /export interface User/);
  assert.deepEqual(graph.order(), [
    new URL("../examples/schema/blog.schema", import.meta.url).href,
    new URL("../examples/schema/catalog.schema", import.meta.url).href,
  ]);
});

test("calc resolves an imported value and emits a real module import", () => {
  const entry = new URL("../examples/calc/imports.calc", import.meta.url).pathname;
  const graph = new ModuleGraph({ languages: [calc] });
  const analysis = graph.analyze(entry);
  assert.deepEqual(analysis.diagnostics, []);
  const module = analysis.ir as CalcModule;
  assert.equal(module.imports[0]!.specifier, "./lib.calc");
  assert.match(calc.runtime!(module), /import \{ base as _v0, limit as _v1 \} from "\.\/lib\.calc";/);
  assert.deepEqual(graph.order(), [
    new URL("../examples/calc/lib.calc", import.meta.url).href,
    new URL("../examples/calc/imports.calc", import.meta.url).href,
  ]);
});

test("the Node loader runs imported guest files", () => {
  const script = [
    "const calc = await import('./examples/calc/imports.calc');",
    "const schema = await import('./examples/schema/catalog.schema');",
    "console.log(calc.default, schema.sql.includes('Catalog') && schema.sql.includes('User'));",
  ].join("\n");
  const result = spawnSync(
    process.execPath,
    ["--import", "./examples/register.ts", "--input-type=module", "-e", script],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /250 true/);
});
