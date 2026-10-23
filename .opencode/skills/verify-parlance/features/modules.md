# Cross-file imports

## Sub-features

- `Language.imports` declares import specifiers; `Language.exports` exposes bindings.
- One `ModuleGraph` per project resolves specifiers, detects cycles, analyzes dependencies first, and routes dependency diagnostics to the import site.
- The CLI, Node loader, content mapper, and LSP all analyze through the graph.
- Schema merges imported models and enums into one SQL/TS artifact; calc resolves imported values and emits real ES module imports.
- LSP go-to-definition crosses files; the target document is read from the open buffer or the graph cache.

## How to get to it (user POV)

A language author adds an `Import` declaration to the grammar and implements `imports`/`exports` on the language value. A user writes `import "./blog.schema";` (schema), `use "./lib.calc";` (calc), or `import "./base.machine";` (machine) and expects the imported names to resolve.

## Driving it with the shell

```sh
# CLI resolves the dependency and checks both files.
./parlance check examples/schema/catalog.schema examples/calc/imports.calc

# One SQL artifact contains the imported models and the local model.
./parlance emit --target sql examples/schema/catalog.schema | grep 'CREATE TABLE'

# Node loader: imported calc values and imported schema tables.
node --import ./examples/register.ts -e "const calc = await import('./examples/calc/imports.calc'); const schema = await import('./examples/schema/catalog.schema'); console.log(calc.default, schema.sql.includes('Catalog') && schema.sql.includes('User'));"

# Content mapper: a .ts file imports the two-file schema.
node --import ./examples/register.ts examples/typescript/catalog.ts

# Module graph oracle: missing imports, cycles, order, routing, duplicate exports, loader.
node --test tests/modules.test.ts

# Real LSP definition from a use in one file to a declaration in another.
node --test tests/lsp.test.ts
```

End state:
- CLI prints `ok` for both entries.
- SQL contains `CREATE TABLE "User"`, `CREATE TABLE "Post"`, and `CREATE TABLE "Catalog"` with `"owner" INTEGER NOT NULL REFERENCES "User"("id")`.
- The loader prints `250 true`; catalog prints `1 1 Tools`.
- `tests/modules.test.ts` passes 9 tests, including a cycle, a duplicate-export diagnostic at the second specifier, and cross-file field/member navigation.
- The LSP test resolves the definition to `blog.schema` line 1.

## Gotchas

- Specifiers are URL-relative. There is no package/bare-specifier resolution and no named import list.
- An import exposes every export of the dependency. Two dependencies exporting the same name from different declarations report at the second specifier; the same declaration through a diamond is allowed.
- Machine recognizes and analyzes imports but does not merge events or states yet.
- Cross-file references and rename match definitions by URI and span across every analyzed node; open documents are the source when available.
- Content mapper `watchedFiles` comes from the recursive guest scan under the config root, so an import outside that root is analyzed but not watched.
- The graph re-reads the entry and reachable dependencies on every analyze, including cached intermediate nodes reached from a new entry; a changed dependency invalidates every transitive dependent.
- An edit to one open LSP document refreshes open dependents whose graph nodes were invalidated before the next request. Closing a document calls `graph.forget` and refreshes importers from disk.
- Aliases are keyed by defining URI and declaration span, not checker-local ids, so a transitive model name cannot collide with an intermediate field alias.
- Calc's TypeScript surface exports only locally declared values; imported values are re-imported by the runtime but not re-exported.
- Imported schema declarations have no source mappings in the importer's TS surface; a mapping must stay inside the transformed document.
