# Emit targets

## Sub-features

- A language declares `targets: Record<string, (module) => Artifact>`.
- `parlance emit --target <name> <file>` prints the artifact, or writes it with `--out`.
- Schema ships `sql`, `drizzle`, and `kysely`.
- Targets receive checked IR, never raw source.

## How to get to it (user POV)

A project checks a `.schema` file, then emits SQL for a database, Drizzle table definitions, or Kysely table types.

```sh
./parlance emit --target sql examples/schema/blog.schema
./parlance emit --target drizzle examples/schema/blog.schema
./parlance emit --target kysely examples/schema/blog.schema
```

## Driving it with the shell

```sh
./parlance emit --target sql examples/schema/blog.schema > /tmp/blog.sql
grep -E 'CREATE TABLE|INSERT|SELECT' /tmp/blog.sql

./parlance emit --target drizzle examples/schema/blog.schema > /tmp/blog.drizzle.ts
grep -E 'sqliteTable|primaryKey|references' /tmp/blog.drizzle.ts

./parlance emit --target kysely examples/schema/blog.schema > /tmp/blog.kysely.ts
grep -E 'interface .*Table|interface DB|Generated<' /tmp/blog.kysely.ts

# SQLite executes the emitted DDL and the runtime query path.
node --import ./examples/register.ts examples/typescript/schema.ts

# Unknown target: non-zero exit and the available names.
./parlance emit --target nope examples/schema/blog.schema; echo "exit=$?"
```

End state: SQL contains `CREATE TABLE "User"` and the `userByEmail`/`draftCount`/`publishedPosts` queries; Drizzle contains `sqliteTable`; Kysely contains `interface DB`; the runtime prints `sai@example.com 0 0`; the unknown target exits 1 and lists `sql, drizzle, kysely`.

## Gotchas

- Emitted Drizzle/Kysely source is not typechecked yet (issue #7). Treat it as text until that lands.
- `--out` writes relative to the process cwd, not the input file.
- A target is only called when the analysis is valid and `ir` is non-null.
- Table and column names are quoted; schema names are case-sensitive.
