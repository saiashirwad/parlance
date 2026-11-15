# Embedding snippets in TypeScript

A guest language can live inside a real `.ts` file as a keyed tagged template:

```ts
import { calc, schema } from "./parlance.embeds";

const Blog = schema("Blog")`
schema Blog
model User {
  id: Int @primary @auto
  email: String @unique
}
query userByEmail(email: String): User? =
  User |> where email == email |> first;
`;

const user = Blog.open(":memory:").userByEmail({ email: "a@b.c" }); // User | undefined
```

`examples/embed/app.ts` is the full example; `examples/embed/kernel.ts` runs a `gpu("Saxpy")` shade kernel on the CPU. A language opts in with a tag:

```ts
defineLanguage({ name: "schema", extensions: [".schema"], embed: { tag: "schema" }, ... });
```

## Why a key

TypeScript 7.1 does not let a content mapper own `.ts` files (TS18066), and a bare tagged
template cannot be typed from its text. So each snippet carries a key, `schema("Blog")`, and the
types come from a stub module the mapper does own.

## The stub

`parlance.embeds` is a file the TypeScript files import. Its content is ignored. Register the
extension with the content mapper:

```json
"contentMappers": [{ "package": "@parlance/ts-host", "extensions": [".schema", ".embeds"], "options": { "config": "./parlance.config.ts" } }]
```

When tsgo transforms the stub, the mapper scans every `.ts` file under the stub's directory
(skipping `node_modules` and dot directories), finds `tag("Key")` templates with the TypeScript
scanner, analyzes each one through the project's `ModuleGraph` as `<file>#embed=<tag>:<key>`, and
emits:

- a `declare namespace` per snippet holding the language's `typescript(ir)` surface (imports are
  hoisted and aliased, relative specifiers rebased to the stub);
- `interface SchemaEmbeds { readonly "Blog": typeof __schema0 }`;
- `declare function schema<K extends keyof SchemaEmbeds>(key: K): (strings: TemplateStringsArray, ...holes: unknown[]) => SchemaEmbeds[K]`.

The scanned files are in `watchedFiles`, and the project identity hashes only their snippets, so
ordinary TypeScript edits do not reload the project. Keys must be unique per tag under one stub.

## Text and offsets

Snippet text is the cooked template value: escapes such as `\n`, `\u0041`, and `` \` `` are applied,
CR LF becomes LF, and a line continuation disappears. A piecewise offset map takes every snippet
offset back to the `.ts` file; a span over an escape covers the whole escape sequence.
`${}` holes are not supported yet: each hole is replaced by one space and reported as an error.

## Runtime

Under the Node loader (`registerLanguages`), resolving `./parlance.embeds` from `app.ts` gives
`parlance.embeds?importer=app.ts`. That module imports each of the importer's snippets from
`app.ts?parlance-embed=schema:Blog`, which the loader compiles with `runtime(ir)`, and exports one
tag function per language that returns the keyed module. The template text is read from the file
when it loads, not from the call; the call only selects the key. A guest error stops the import
with `app.ts(line,col): message`; a `TsDoc` runtime gets a source map into `app.ts`.

## Editor

The parlance LSP attaches to TypeScript buffers too. Inside a snippet it serves diagnostics,
hover, definition, completion, and semantic tokens, mapped to `.ts` positions. Outside snippets
it returns nothing, so tsgo's own server answers there. Diagnostics follow unsaved edits.

## Known limits

- Snippet types refresh on save. tsgo ignores disk events for files open in the editor, so on
  save the LSP writes a stamp file in the OS temp directory that the mapper lists in
  `watchedFiles`; the editor's file watcher must report it. Without the parlance LSP, types
  refresh when a closed host file changes or the project reloads.
- tsc and tsgo report guest errors against the stub (`parlance.embeds(1,1): app.ts(16,17): ...`),
  not at the snippet. tsc stops at these, as at syntax errors, so TypeScript type errors appear
  once the snippets are clean. The parlance LSP reports guest errors in place.
- There is no go-to-definition from a TypeScript use (`db.userByEmail`) into the snippet.
- A snippet is recognized only as `tag("Key")` followed directly by a template; `x.tag("Key")` is
  not one. The tag is matched by name, not by resolving the import.
- Holes are opaque, see above. A default import in a language's TypeScript surface is hoisted
  under its own name and can collide across snippets.
- Embedding needs the `typescript` 7.1 package installed (its `typescript/ast/scanner`).