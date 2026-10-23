import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { analyze } from "../src/language.ts";
import { schema, type SchemaModule } from "../examples/schema/schema.ts";

const root = new URL("..", import.meta.url).pathname;
const source = readFileSync(new URL("../examples/schema/blog.schema", import.meta.url), "utf8");

const errors = (input: string): string =>
  analyze(schema, `schema Test\n\n${input}`).diagnostics.map((entry) => entry.message).join("\n");

type Failure = { readonly message: string; readonly text: string };

const failures = (input: string): readonly Failure[] => {
  const analysis = analyze(schema, `schema Test\n\n${input}`);
  return analysis.diagnostics
    .filter((entry) => entry.severity === "error")
    .map((entry) => ({
      message: entry.message,
      text: analysis.source.slice(entry.span.start, entry.span.end),
    }));
};

const firstFailure = (input: string): Failure => {
  const [failure] = failures(input);
  assert.ok(failure, `expected a diagnostic for\n${input}`);
  return failure;
};

const analyzeModule = (program: string): SchemaModule => {
  const analysis = analyze(schema, program, "memory://schema/test");
  assert.deepEqual(analysis.diagnostics, []);
  return analysis.ir as SchemaModule;
};

const loadRuntime = async (program: string) => {
  const module = analyzeModule(program);
  const directory = mkdtempSync(join(tmpdir(), "parlance-schema-"));
  const file = join(directory, "schema.module.ts");
  writeFileSync(file, schema.runtime!(module));
  const loaded = await import(`${pathToFileURL(file).href}?${Date.now()}`);
  return {
    db: loaded.open(":memory:") as Record<string, (params?: Record<string, unknown>) => any> & {
      close(): void;
    },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
};

test("the schema language checks models, enums, references, queries, and mutations", () => {
  const analysis = analyze(schema, source, "blog.schema");
  assert.deepEqual(analysis.diagnostics, []);
  const module = analysis.ir as SchemaModule;
  assert.deepEqual(module.models.map((model) => model.name.text), ["User", "Post"]);
  assert.deepEqual(module.queries.map((query) => query.name.text), [
    "userByEmail",
    "publishedPosts",
    "allPosts",
    "draftCount",
  ]);
  assert.deepEqual(
    module.mutations.map((mutation) => `${mutation.kind}:${mutation.name.text}`),
    [
      "insert:insertUser",
      "insert:insertPost",
      "update:updatePost",
      "delete:deletePost",
    ],
  );
  assert.equal(module.models[1]!.fields.find((field) => field.name.text === "authorId")!.type.kind, "model");
  assert.deepEqual(
    module.models[1]!.fields.find((field) => field.name.text === "status")!.defaultValue,
    { kind: "literal", value: "Draft" },
  );
  assert.deepEqual(
    module.models[1]!.fields.find((field) => field.name.text === "createdAt")!.defaultValue,
    { kind: "now" },
  );
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

test("mutation errors point at the offending token", () => {
  const base = `enum Role { Member Admin }
model User {
  id: Int @primary @auto
  email: String
  role: Role @default(Member)
}
`;

  const check = (statement: string) => firstFailure(`${base}${statement}`);

  assert.deepEqual(check("insert Nope { email: \"a\" }"), {
    message: 'Unknown model "Nope"',
    text: "Nope",
  });
  assert.deepEqual(check("insert User { email: \"a\", nope: 1 }"), {
    message: 'Unknown field "nope"',
    text: "nope",
  });
  assert.deepEqual(check("insert User { }"), {
    message: 'Insert User is missing required field "email"',
    text: "User",
  });
  assert.deepEqual(check("insert User { email: 1 }"), {
    message: "Expected String, found a different literal",
    text: "1",
  });
  assert.deepEqual(check("insert User { id: 1, email: \"a\" }"), {
    message: 'The @auto primary field "id" is generated; omit it',
    text: "id",
  });
  assert.deepEqual(check("insert User { email: \"a\", email: \"b\" }"), {
    message: 'Duplicate assignment to "email"',
    text: "email",
  });
  assert.deepEqual(check("insert User { email: \"a\", role: Nope }"), {
    message: 'Unknown enum member "Nope"',
    text: "Nope",
  });
  assert.deepEqual(check("update User |> where id == $id |> set id = 1"), {
    message: 'The @primary field "id" cannot be updated',
    text: "id",
  });
  assert.deepEqual(check("update User |> where id == $id |> set nope = 1"), {
    message: 'Unknown field "nope"',
    text: "nope",
  });
  assert.deepEqual(check("update User |> set email = \"a\""), {
    message: "Update User needs a where stage",
    text: "User",
  });
  assert.deepEqual(check("update User |> where id == $id"), {
    message: "Update User needs a set stage",
    text: "User",
  });
  assert.deepEqual(check("update User |> where id == $id |> set email = \"a\", email = \"b\""), {
    message: 'Duplicate assignment to "email"',
    text: "email",
  });
  assert.deepEqual(check("update User |> where id == $x |> set email = $x"), {
    message: 'Parameter "x" is used for both Int and String',
    text: "x",
  });
  assert.deepEqual(check("delete User"), {
    message: "Delete User needs a where stage",
    text: "User",
  });
  assert.deepEqual(check("delete User |> where nope == 1"), {
    message: 'Unknown field "nope"',
    text: "nope",
  });
  assert.deepEqual(check("delete User |> where id == \"x\""), {
    message: "Expected Int, found a different literal",
    text: "\"x\"",
  });
});

test("default errors point at the attribute or its argument", () => {
  const attribute = firstFailure("model Bad {\n  id: Int @primary @default(0)\n}\n");
  assert.match(attribute.message, /Defaults are not allowed on @primary or @auto fields/);
  assert.equal(attribute.text, "@default(0)");

  assert.deepEqual(firstFailure("model Bad {\n  id: Int @primary\n  x: Int @default(nope)\n}\n"), {
    message: 'Unknown default "nope"',
    text: "nope",
  });
  assert.deepEqual(firstFailure("model Bad {\n  id: Int @primary\n  x: Int @default(\"x\")\n}\n"), {
    message: "Expected a Int default, found a different literal",
    text: "\"x\"",
  });
  assert.deepEqual(firstFailure("model Bad {\n  id: Int @primary\n  x: DateTime @default(0)\n}\n"), {
    message: "Expected a DateTime default, found a different literal",
    text: "0",
  });
  assert.deepEqual(firstFailure("model Bad {\n  id: Int @primary\n  x: Int @default(now)\n}\n"), {
    message: "@default(now) is only valid for DateTime",
    text: "now",
  });
  assert.deepEqual(firstFailure("model Bad {\n  id: Int @primary(1)\n}\n"), {
    message: "@primary does not take an argument",
    text: "1",
  });
});

test("mutation parameters do not leak into the module scope", () => {
  const program = [
    "schema Scope",
    "",
    "model User {",
    "  id: Int @primary @auto",
    "  email: String",
    "}",
    "",
    "model Post {",
    "  id: Int @primary @auto",
    "  title: String",
    "}",
    "",
    "insert User { email: $Post }",
    "insert Post { title: $title }",
    "",
  ].join("\n");
  const analysis = analyze(schema, program, "memory://schema/scope");
  assert.deepEqual(analysis.diagnostics, []);
  const model = analysis.facts.definitions.find((definition) =>
    definition.name === "Post" && definition.kind === "class"
  );
  const parameter = analysis.facts.definitions.find((definition) =>
    definition.name === "Post" && definition.kind === "parameter"
  );
  assert.ok(model, "missing the Post model binding");
  assert.ok(parameter, "missing the $Post parameter binding");
  const at = program.indexOf("insert Post") + "insert ".length;
  const reference = analysis.facts.references.find((entry) => entry.span.start === at);
  assert.ok(reference, "missing a reference on the second mutation's model name");
  assert.equal(reference.id, model.id, "the model name resolved to the previous mutation's parameter");
  const parameterUse = program.indexOf("$Post") + 1;
  assert.deepEqual(parameter.span, { start: parameterUse, end: parameterUse + "Post".length });
});

test("type references ignore query parameter names", () => {
  const program = `schema Types

enum Kind { Sale Rent }

model Item {
  id: Int @primary
  kind: Kind
}

query byKind(Kind: Int, k: Kind): Item[] =
  Item |> where id == Kind |> all;
`;
  const analysis = analyze(schema, program, "memory://schema/type-scope");
  assert.deepEqual(analysis.diagnostics, []);
  const enumeration = analysis.facts.definitions.find((definition) =>
    definition.name === "Kind" && definition.kind === "enum"
  );
  assert.ok(enumeration, "missing the Kind enum binding");
  const at = program.indexOf("k: Kind") + "k: ".length;
  const reference = analysis.facts.references.find((entry) => entry.span.start === at);
  assert.ok(reference, "missing a reference on the parameter type");
  assert.equal(reference.id, enumeration.id, "the parameter type resolved to the parameter called Kind");
});

test("accepted mutations mix literals, enum members, and bound parameters", () => {
  const program = `schema Accepted

enum Role { Member Admin }

model User {
  id: Int @primary @auto
  email: String @unique
  role: Role @default(Member)
}

model Post {
  id: Int @primary @auto
  title: String
}

insert User { email: $email, role: Admin }
insert Post { title: "hello" }
update User |> where id == $id |> set role = $role
update Post |> where title == "hello" |> set title = "renamed"
delete User |> where id == $id
delete Post |> where title == "hello"
`;
  const module = analyzeModule(program);
  assert.equal(module.mutations.length, 6);
  const ts = schema.typescript!(module).text;
  assert.match(ts, /insertUser\(params: \{ readonly email: string; \}\): number;/);
  assert.match(ts, /insertPost\(params: \{ \}\): number;/);
  assert.match(
    ts,
    /updateUser\(params: \{ readonly where: \{ readonly id: number; \}; readonly set: \{ readonly role: Role; \} \}\): number;/,
  );
  assert.match(ts, /updatePost\(params: \{ readonly where: \{ \}; readonly set: \{ \} \}\): number;/);
  assert.match(ts, /deleteUser\(params: \{ readonly id: number; \}\): number;/);
  assert.match(ts, /deletePost\(params: \{ \}\): number;/);
  const sql = schema.targets!.sql!(module).text;
  assert.match(sql, /INSERT INTO "User" \("email", "role"\) VALUES \(:v0, :v1\);/);
  assert.match(sql, /UPDATE "User"\nSET "role" = :v1\nWHERE "id" = :v0;/);
  assert.match(sql, /DELETE FROM "User"\nWHERE "id" = :v0;/);
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
  assert.match(
    types.text,
    /insertUser\(params: \{ readonly email: string; readonly role: Role; readonly createdAt\?: string; \}\): number;/,
  );
  assert.match(
    types.text,
    /insertPost\(params: \{ readonly title: string; readonly status: PostStatus; readonly authorId: number; readonly views\?: number; readonly createdAt\?: string; \}\): number;/,
  );
  assert.match(
    types.text,
    /updatePost\(params: \{ readonly where: \{ readonly id: number; \}; readonly set: \{ readonly status: PostStatus; \} \}\): number;/,
  );
  assert.match(types.text, /deletePost\(params: \{ readonly id: number; \}\): number;/);

  const sql = schema.targets!.sql!(module).text;
  assert.match(sql, /CREATE TABLE "User"/);
  assert.match(sql, /"id" INTEGER PRIMARY KEY AUTOINCREMENT/);
  assert.match(sql, /REFERENCES "User"\("id"\)/);
  assert.match(sql, /SELECT COUNT\(\*\) AS "count"/);
  assert.match(sql, /WHERE "status" = :lit0/);
  assert.match(sql, /"role" TEXT NOT NULL DEFAULT 'Member'/);
  assert.match(sql, /"views" INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /"createdAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP/);
  assert.match(sql, /INSERT INTO "Post" \("title", "status", "authorId"\) VALUES \(:v0, :v1, :v2\);/);
  assert.doesNotMatch(sql, /INSERT INTO "Post" \([^)]*"views"/);
  assert.match(sql, /UPDATE "Post"\nSET "status" = :v1\nWHERE "id" = :v0;/);
  assert.match(sql, /DELETE FROM "Post"\nWHERE "id" = :v0;/);

  const drizzle = schema.targets!.drizzle!(module).text;
  assert.match(drizzle, /import \{ sql \} from "drizzle-orm";/);
  assert.match(drizzle, /export const user = sqliteTable\("User"/);
  assert.match(drizzle, /integer\("id"\)\.primaryKey\(\{ autoIncrement: true \}\)/);
  assert.match(drizzle, /text\("role"\)\.\$type<Role>\(\)\.notNull\(\)\.default\("Member"\)/);
  assert.match(drizzle, /integer\("views"\)\.notNull\(\)\.default\(0\)/);
  assert.match(drizzle, /text\("createdAt"\)\.notNull\(\)\.default\(sql`CURRENT_TIMESTAMP`\)/);

  const kysely = schema.targets!.kysely!(module).text;
  assert.match(kysely, /export interface UserTable/);
  assert.match(kysely, /readonly id: Generated<number>;/);
  assert.match(kysely, /readonly role: Generated<Role>;/);
  assert.match(kysely, /readonly views: Generated<number>;/);
  assert.match(kysely, /readonly createdAt: Generated<string>;/);
});

test("the SQL target is a deterministic snapshot for mutations and defaults", () => {
  const module = analyzeModule(`schema Shop

enum Role { Member Admin }

model User {
  id: Int @primary @auto
  name: String
  role: Role @default(Member)
  active: Bool @default(true)
  createdAt: DateTime @default(now)
}

insert User { name: $name }
update User |> where id == $id |> set name = $name
delete User |> where id == $id
`);
  assert.equal(
    schema.targets!.sql!(module).text,
    `-- generated by parlance
CREATE TABLE "User" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "name" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'Member',
  "active" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);


-- insertUser
INSERT INTO "User" ("name") VALUES (:v0);

-- updateUser
UPDATE "User"
SET "name" = :v1
WHERE "id" = :v0;

-- deleteUser
DELETE FROM "User"
WHERE "id" = :v0;
`,
  );
});

test("the schema runtime inserts, reads, updates, deletes, and counts SQLite rows", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "./examples/register.ts", "examples/typescript/schema.ts"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "sai@example.com 1 1 0 1 1 1 0\n");
});

test("property: generated mutation parameters bind by name and apply defaults", async () => {
  const program = `schema Property

model Item {
  id: Int @primary @auto
  name: String
  qty: Int
  active: Bool @default(true)
  status: String @default("ready")
  createdAt: DateTime @default(now)
  note: String?
}

insert Item { name: $name, qty: $qty }
update Item |> where id == $id |> set qty = $qty
delete Item |> where id == $id

query itemById(id: Int): Item? = Item |> where id == id |> first;
query allItems(): Item[] = Item |> orderBy id asc |> all;
query itemCount(): Int = Item |> count;
`;
  const { db, cleanup } = await loadRuntime(program);
  try {
    let state = 0x5eed;
    const random = () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    const inserts = 40;
    const names: string[] = [];
    for (let index = 0; index < inserts; index++) {
      const name = `item-${index}-${Math.floor(random() * 1_000_000)}`;
      const qty = Math.floor(random() * 500);
      const status = random() < 0.3 ? `custom-${index}` : undefined;
      const note = random() < 0.2 ? `note-${index}` : undefined;
      names.push(name);
      const params: Record<string, unknown> = { name, qty };
      if (status !== undefined) params.status = status;
      if (note !== undefined) params.note = note;
      const id = db.insertItem!(params);
      assert.equal(id, index + 1);
      const row = db.itemById!({ id }) as Record<string, unknown>;
      assert.equal(row.name, name);
      assert.equal(row.qty, qty);
      assert.equal(row.status, status ?? "ready");
      assert.equal(Number(row.active), 1);
      assert.equal(row.note ?? undefined, note);
      assert.equal(typeof row.createdAt, "string");
    }
    assert.equal(db.itemCount!({}), inserts);
    assert.deepEqual(
      (db.allItems!({}) as Record<string, unknown>[]).map((row) => row.name),
      names,
    );

    let updated = 0;
    for (let index = 0; index < inserts; index += 4) {
      const qty = 1000 + index;
      assert.equal(db.updateItem!({ where: { id: index + 1 }, set: { qty } }), 1);
      assert.equal((db.itemById!({ id: index + 1 }) as Record<string, unknown>).qty, qty);
      updated++;
    }
    assert.equal(db.itemCount!({}), inserts);

    for (let index = 1; index < inserts; index += 3) {
      assert.equal(db.deleteItem!({ id: index + 1 }), 1);
      assert.equal(db.itemById!({ id: index + 1 }), undefined);
    }
    const deleted = Math.floor((inserts - 2) / 3) + 1;
    assert.equal(db.itemCount!({}), inserts - deleted);
    assert.equal(updated, Math.ceil(inserts / 4));
  } finally {
    db.close();
    cleanup();
  }
});

const generated = (seed: number): string => {
  let state = seed >>> 0;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const names = Array.from({ length: 3 }, (_, index) => `M${seed}_${index}`);
  const scalar = () => ["Int", "String", "Bool", "DateTime"][Math.floor(random() * 4)]!;
  const defaultFor = (type: string): string =>
    type === "Int" ? "@default(0)" : type === "Bool" ? "@default(true)" : type === "DateTime" ? "@default(now)" : "@default(\"x\")";
  const lines: string[] = ["schema Generated", ""];
  const modelFields: string[][] = [];
  for (const [index, name] of names.entries()) {
    lines.push(`model ${name} {`, `  id: Int @primary @auto`);
    const count = 1 + Math.floor(random() * 3);
    const fields: string[] = [];
    for (let field = 0; field < count; field++) {
      const type = scalar();
      const nullable = random() < 0.2;
      const fallback = !nullable && random() < 0.3 ? ` ${defaultFor(type)}` : "";
      fields.push(`f${field}`);
      lines.push(`  f${field}: ${type}${nullable ? "?" : ""}${fallback}`);
    }
    if (index > 0) {
      fields.push("parentId");
      lines.push(`  parentId: ${names[index - 1]}`);
    }
    modelFields.push(fields);
    lines.push("}", "");
  }
  for (const [index, name] of names.entries()) {
    const fields = modelFields[index]!;
    lines.push(
      `insert ${name} { ${fields.map((field) => `${field}: $${field}`).join(", ")} }`,
      `update ${name} |> where id == $id |> set f0 = $f0`,
      `delete ${name} |> where id == $id`,
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
    assert.equal(module.mutations.length, 9);
    const types = schema.typescript!(module).text;
    const sql = schema.targets!.sql!(module).text;
    for (const model of module.models) {
      assert.ok(types.includes(`export interface ${model.name.text}`));
      assert.ok(sql.includes(`CREATE TABLE "${model.name.text}"`));
      assert.ok(sql.includes(`INSERT INTO "${model.name.text}"`));
      assert.ok(sql.includes(`UPDATE "${model.name.text}"`));
      assert.ok(sql.includes(`DELETE FROM "${model.name.text}"`));
    }
  }
});
