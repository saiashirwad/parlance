import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { calc, type CalcModule } from "../examples/calc/calc.ts";
import { schema, type SchemaModule } from "../examples/schema/schema.ts";
import { ModuleGraph } from "../src/modules.ts";
import { definitionAt } from "../src/check/index.ts";
import type { AnyLanguage } from "../src/language.ts";

const root = new URL("..", import.meta.url).pathname;

const memory = (
  files: Readonly<Record<string, string>>,
  languages: readonly AnyLanguage[] = [schema],
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

test("a changed dependency invalidates the entry and its dependents", () => {
  const files: Record<string, string> = {
    "memory://dir/base.schema": "schema Base\nmodel Base {\n  id: Int @primary\n}\n",
    "memory://dir/main.schema": "schema Main\nimport \"./base.schema\";\nmodel Main {\n  id: Int @primary\n  owner: Base\n}\n",
    "memory://dir/other.schema": "schema Other\nimport \"./base.schema\";\nmodel Other {\n  id: Int @primary\n  owner: Base\n}\n",
  };
  const graph = new ModuleGraph({ languages: [schema], read: (uri) => files[uri] ?? null });
  const first = graph.analyze("memory://dir/main.schema");
  assert.deepEqual(first.diagnostics, []);
  assert.deepEqual(
    (first.ir as SchemaModule).models.find((model) => model.name.text === "Base")!.fields.map((field) => field.name.text),
    ["id"],
  );

  files["memory://dir/base.schema"] = "schema Base\nmodel Base {\n  id: Int @primary\n  name: String\n}\n";
  const second = graph.analyze("memory://dir/main.schema");
  assert.notEqual(second, first);
  assert.deepEqual(second.diagnostics, []);
  assert.deepEqual(
    (second.ir as SchemaModule).models.find((model) => model.name.text === "Base")!.fields.map((field) => field.name.text),
    ["id", "name"],
  );

  files["memory://dir/base.schema"] = "schema Base\nmodel Base {\n  id: Int @primary\n  label: String\n}\n";
  graph.analyze("memory://dir/other.schema");
  assert.equal(graph.node("memory://dir/main.schema"), undefined, "another importer's rebuild left a stale dependent cached");
});

test("a missing dependency that appears later is re-analyzed", () => {
  const files: Record<string, string> = {
    "memory://dir/main.schema": "schema Main\nimport \"./later.schema\";\nmodel Main {\n  id: Int @primary\n}\n",
  };
  const graph = new ModuleGraph({ languages: [schema], read: (uri) => files[uri] ?? null });
  const first = graph.analyze("memory://dir/main.schema");
  assert.match(first.diagnostics.map((entry) => entry.message).join("\n"), /Cannot resolve import/);

  files["memory://dir/later.schema"] = "schema Later\nmodel Later {\n  id: Int @primary\n}\n";
  const second = graph.analyze("memory://dir/main.schema");
  assert.deepEqual(second.diagnostics, []);
  assert.ok((second.ir as SchemaModule).models.some((model) => model.name.text === "Later"));
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
  const runtime = calc.runtime!(module);
  assert.match(runtime, /import \{ base as _v0, limit as _v1 \} from "\.\/lib\.calc";/);
  const surface = calc.typescript!(module).text;
  assert.match(surface, /export declare const total/);
  assert.doesNotMatch(surface, /export declare const base/, "the runtime does not re-export imported values");
  assert.deepEqual(graph.order(), [
    new URL("../examples/calc/lib.calc", import.meta.url).href,
    new URL("../examples/calc/imports.calc", import.meta.url).href,
  ]);
});

test("transitive imports keep the original defining URI", () => {
  const files = {
    "memory://dir/c.schema": "schema C\nenum Role { Admin }\nmodel User {\n  id: Int @primary @auto\n  role: Role\n}\n",
    "memory://dir/b.schema": "schema B\nimport \"./c.schema\";\nmodel B {\n  id: Int @primary @auto\n  owner: User\n}\n",
    "memory://dir/a.schema": "schema A\nimport \"./b.schema\";\nquery admins(): User[] =\n  User |> where role == Admin |> all;\n",
  };
  const analysis = memory(files).analyze("memory://dir/a.schema");
  assert.deepEqual(analysis.diagnostics, []);
  const source = files["memory://dir/a.schema"];
  const fieldAt = source.indexOf("where role") + "where ".length;
  const field = definitionAt(analysis.facts, fieldAt);
  assert.equal(field?.uri, "memory://dir/c.schema");
  assert.equal(files["memory://dir/c.schema"].slice(field.span.start, field.span.end), "role");
  const memberAt = source.indexOf("Admin");
  const member = definitionAt(analysis.facts, memberAt);
  assert.equal(member?.uri, "memory://dir/c.schema");
  assert.equal(files["memory://dir/c.schema"].slice(member.span.start, member.span.end), "Admin");
});

test("conflicting imported declarations report at the second specifier", () => {
  const files = {
    "memory://dir/one.schema": "schema One\nmodel User {\n  id: Int @primary\n}\n",
    "memory://dir/two.schema": "schema Two\nmodel User {\n  id: Int @primary\n  name: String\n}\n",
    "memory://dir/main.schema": "schema Main\nimport \"./one.schema\";\nimport \"./two.schema\";\n",
  };
  const analysis = memory(files).analyze("memory://dir/main.schema");
  const conflict = analysis.diagnostics.find((entry) => /also exports "User" from a different declaration/.test(entry.message));
  assert.ok(conflict, analysis.diagnostics.map((entry) => entry.message).join("\n"));
  assert.equal(analysis.source.slice(conflict.span.start, conflict.span.end), "./two.schema");
});

test("two imports exporting the same name report at the second specifier", () => {
  const files = {
    "memory://dir/lib1.calc": "let base = 1;\n",
    "memory://dir/lib2.calc": "let base = 2;\n",
    "memory://dir/main.calc": 'use "./lib1.calc";\nuse "./lib2.calc";\nshow base;\n',
  };
  const graph = memory(files, [calc]);
  const analysis = graph.analyze("memory://dir/main.calc");
  const conflict = analysis.diagnostics.find((entry) => /also exports "base"/.test(entry.message));
  assert.ok(conflict, analysis.diagnostics.map((entry) => entry.message).join("\n"));
  assert.equal(analysis.source.slice(conflict.span.start, conflict.span.end), "./lib2.calc");
  const runtime = calc.runtime!(analysis.ir as CalcModule);
  assert.match(runtime, /from "\.\/lib1\.calc"/);
  assert.doesNotMatch(runtime, /from "\.\/lib2\.calc"/);
});

test("imported fields and enum members navigate to their defining file", () => {
  const blog = "schema Blog\nenum Role { Member Admin }\nmodel User {\n  id: Int @primary @auto\n  role: Role\n}\n";
  const main = "schema Main\nimport \"./blog.schema\";\nquery admins(): User[] =\n  User |> where role == Admin |> all;\n";
  const files = {
    "memory://dir/blog.schema": blog,
    "memory://dir/main.schema": main,
  };
  const analysis = memory(files).analyze("memory://dir/main.schema");
  assert.deepEqual(analysis.diagnostics, []);

  const fieldAt = main.indexOf("where role") + "where ".length;
  const field = definitionAt(analysis.facts, fieldAt);
  assert.equal(field?.name, "role");
  assert.equal(field?.uri, "memory://dir/blog.schema");
  assert.equal(blog.slice(field.span.start, field.span.end), "role");

  const memberAt = main.indexOf("Admin");
  const member = definitionAt(analysis.facts, memberAt);
  assert.equal(member?.name, "Admin");
  assert.equal(member?.kind, "enumMember");
  assert.equal(member?.uri, "memory://dir/blog.schema");
  assert.equal(blog.slice(member.span.start, member.span.end), "Admin");
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
