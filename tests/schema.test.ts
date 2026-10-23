import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { analyze } from "../src/language.ts";
import { schema, type SchemaModule } from "../examples/schema/schema.ts";

const root = new URL("..", import.meta.url).pathname;
const source = readFileSync(new URL("../examples/schema/blog.schema", import.meta.url), "utf8");

const errors = (input: string): string =>
  analyze(schema, `schema Test\n\n${input}`).diagnostics.map((entry) => entry.message).join("\n");

test("the schema language checks models, enums, references, and query results", () => {
  const analysis = analyze(schema, source, "blog.schema");
  assert.deepEqual(analysis.diagnostics, []);
  const module = analysis.ir as SchemaModule;
  assert.deepEqual(module.models.map((model) => model.name.text), ["User", "Post"]);
  assert.deepEqual(module.queries.map((query) => query.name.text), ["userByEmail", "publishedPosts", "draftCount"]);
  assert.equal(module.models[1]!.fields.find((field) => field.name.text === "authorId")!.type.kind, "model");
});

test("schema errors point at the offending guest span", () => {
  const uncertain = "model User {\n  email: String\n}\nquery byEmail(email: String): User? = User |> where email == email |> first;\n";
  assert.match(errors(uncertain), /needs an @primary field/);
  assert.match(errors("model User {\n  id: Int @auto\n}\n"), /@auto requires @primary/);
  assert.match(errors("model User {\n  id: Int @primary\n  id: String\n}\n"), /Duplicate field/);
  assert.match(errors("model User {\n  id: Int @primary\n  role: Nope\n}\n"), /Unknown type/);
  assert.match(
    errors("model User {\n  id: Int @primary\n}\nquery bad(nope: Int): User? = User |> where nope == nope |> first;\n"),
    /Unknown field/,
  );
  assert.match(
    errors("model User {\n  id: Int @primary\n  role: Role\n}\nenum Role { Member Admin }\nquery bad(id: Int): User[] = User |> where id == id |> first;\n"),
    /Query result is User\?/,
  );
});

test("schema emits TypeScript, SQL, Drizzle, and Kysely from one module", () => {
  const analysis = analyze(schema, source, "blog.schema");
  const module = analysis.ir as SchemaModule;
  const types = schema.typescript!(module);
  assert.ok(!types.text.includes("\\n"));
  assert.match(types.text, /export type Role = "Member" \| "Admin";/);
  assert.match(types.text, /readonly authorId: number;/);
  assert.match(types.text, /userByEmail\(params: \{ readonly email: string; \}\): User \| undefined;/);
  assert.match(types.text, /publishedPosts\(params: \{ readonly limit: number; \}\): readonly Post\[\];/);

  const sql = schema.targets!.sql!(module).text;
  assert.match(sql, /CREATE TABLE "User"/);
  assert.match(sql, /"id" INTEGER PRIMARY KEY AUTOINCREMENT/);
  assert.match(sql, /REFERENCES "User"\("id"\)/);
  assert.match(sql, /SELECT COUNT\(\*\) AS "count"/);
  assert.match(sql, /WHERE "status" = :lit0/);

  const drizzle = schema.targets!.drizzle!(module).text;
  assert.match(drizzle, /export const user = sqliteTable\("User"/);
  assert.match(drizzle, /integer\("id"\)\.primaryKey\(\{ autoIncrement: true \}\)/);
  assert.match(drizzle, /text\("role"\)\.\$type<Role>\(\)/);

  const kysely = schema.targets!.kysely!(module).text;
  assert.match(kysely, /export interface UserTable/);
  assert.match(kysely, /readonly id: Generated<number>;/);
});

test("the schema runtime seeds and queries SQLite through the Node loader", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "./examples/register.ts", "examples/typescript/schema.ts"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "sai@example.com 0 0\n");
});

const generated = (seed: number): string => {
  let state = seed >>> 0;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const names = Array.from({ length: 3 }, (_, index) => `M${seed}_${index}`);
  const scalar = () => ["Int", "String", "Bool"][Math.floor(random() * 3)]!;
  const lines: string[] = ["schema Generated", ""];
  for (const [index, name] of names.entries()) {
    lines.push(`model ${name} {`, `  id: Int @primary @auto`);
    const count = 1 + Math.floor(random() * 3);
    for (let field = 0; field < count; field++) {
      lines.push(`  f${field}: ${scalar()}${random() < 0.2 ? "?" : ""}`);
    }
    if (index > 0) lines.push(`  parentId: ${names[index - 1]}`);
    lines.push("}", "");
  }
  for (const [index, name] of names.entries()) {
    lines.push(
      `query first${index}(id: Int): ${name}? = ${name} |> where id == id |> first;`,
      `query all${index}(): ${name}[] = ${name} |> all;`,
      `query count${index}(): Int = ${name} |> count;`,
      "",
    );
  }
  return lines.join("\n");
};

test("property: generated schemas check and project without internal errors", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const program = generated(seed);
    const analysis = analyze(schema, program, `memory://schema/${seed}`);
    assert.deepEqual(
      analysis.diagnostics,
      [],
      `seed ${seed}\n${program}\n${analysis.diagnostics.map((entry) => entry.message).join("\n")}`,
    );
    const module = analysis.ir as SchemaModule;
    assert.equal(module.models.length, 3);
    const types = schema.typescript!(module).text;
    const sql = schema.targets!.sql!(module).text;
    for (const model of module.models) {
      assert.ok(types.includes(`export interface ${model.name.text}`));
      assert.ok(sql.includes(`CREATE TABLE "${model.name.text}"`));
    }
  }
});
