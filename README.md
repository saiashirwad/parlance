# parlance

Parlance is a toolkit for small languages that live inside TypeScript and Node. A language is one value: a grammar, a checker, a TypeScript surface, a runtime, and optional targets. The grammar is a `.parl` file that also supplies the lexer for highlighting. The same value drives the content mapper, the Node loader, and the language server, so a project writes one definition and gets every host from it.

## Requirements

- Node.js 24.2 or newer (`engines` in `package.json`).
- pnpm 11. CI uses pnpm 11.
- TypeScript 7.1 beta. It is a dev dependency. The `contentMappers` entry needs this version.

## Quickstart

```sh
pnpm install

./parlance check examples/calc/demo.calc examples/schema/blog.schema examples/machine/order.machine

./parlance check examples/schema/catalog.schema examples/calc/imports.calc

node --import ./examples/register.ts examples/typescript/calc.ts

pnpm check
```

The check prints one `ok` line per file. The Node command prints `250` from the `show` in `demo.calc`, then `250 125 true` from `examples/typescript/calc.ts`. `pnpm check` runs the typecheck, the tests, the three example languages through the CLI and the loader, the LSP smoke test, and `tsgo` navigation into guest files.

## Neovim

The repository-local `.nvim.lua` registers one `parlance` client for `.calc`, `.schema`, and `.machine` files, enables semantic tokens, and scopes the servers to this checkout. It also enables `runExternalCode` for the TypeScript content mapper. With `vim.o.exrc = true`, open any example and trust `.nvim.lua` once. `pnpm nvim:check` proves the real startup path in headless Neovim.

See [`docs/06-neovim.md`](docs/06-neovim.md) for keymaps, a global config for other parlance projects, and troubleshooting.

## Define a language

`examples/calc/calc.ts` ends with the real definition:

```ts
import { defineLanguage } from "parlance";
import { TypeStore, type Type } from "parlance/types";
import type { File } from "./calc.ast.ts";

export const calc = defineLanguage<File, CalcModule, Type>({
  name: "calc",
  extensions: [".calc"],
  grammar,
  check,
  typescript: types,
  runtime,
  show: (type) => new TypeStore().show(type),
  describe: (binding) =>
    binding.type === undefined ? undefined : `${binding.kind} ${binding.name}: ${new TypeStore().show(binding.type)}`,
});
```

`grammar` is a `CompiledGrammar<File>` compiled from `examples/calc/calc.parl`. `check` turns the AST into `CalcModule`. `types` returns a `TsDoc`; `runtime` returns an ES module source string. Only `name`, `extensions`, `grammar`, and `check` are required. `typescript`, `runtime`, `targets`, `show`, `describe`, and `checkPartial` are optional. [`docs/04-authoring.md`](docs/04-authoring.md) builds each piece in order.

## Examples

- [`examples/calc`](examples/calc): expression language. Infers `number` and `boolean`, emits JavaScript directly, projects a TypeScript surface, and recovers after a malformed declaration.
- [`examples/schema`](examples/schema): relational DSL. Checks models, enums, fields, references, and query results. Emits SQL, Drizzle, and Kysely targets, and runs queries through an interpreted `node:sqlite` runtime.
- [`examples/machine`](examples/machine): state machine. Checks event and state legality, duplicate transitions, unreachable states, and a missing initial state. Projects a discriminated state and event union, and runs through an interpreted runtime.

## Docs

- [`docs/00-survey.md`](docs/00-survey.md): what the previous langkit assumed, what the measurements showed, and which assumptions failed.
- [`docs/01-architecture.md`](docs/01-architecture.md): the pipeline from grammar to facts, projections, and hosts.
- [`docs/02-grammar.md`](docs/02-grammar.md): the `.parl` language, expressions, static checks, recovery, and generated ASTs.
- [`docs/03-incremental.md`](docs/03-incremental.md): reparse, token reuse, soundness guards, and measurements.
- [`docs/04-authoring.md`](docs/04-authoring.md): a step-by-step guide to adding a language.
- [`docs/05-modules.md`](docs/05-modules.md): imports, the module graph, diagnostic routing, and cross-file navigation.
- [`docs/06-neovim.md`](docs/06-neovim.md): project-local LSP wiring, keymaps, verification, and troubleshooting.

## Status

Working:

- `.parl` compilation with static checks, root-item recovery, and a self-hosted grammar.
- Checker, facts, semantic tokens, and the generic LSP (diagnostics, hover, definition, references, symbols, folding, completion, cross-file definition, references, and rename).
- Cross-file imports through one `ModuleGraph`: schema and calc resolve dependencies, and the CLI, Node loader, content mapper, and LSP all use the graph.
- Source-mapped TypeScript surfaces through a `ts` template and the TypeScript 7.1 content mapper.
- A Node loader that runs guest files without a build step.
- Named targets with `parlance emit`.
- Incremental reparse when the root is an item repetition: a one-character edit in the 2.8 MB calc corpus runs at roughly a third of a full parse (25–38% across runs; load can raise it), with 99,998 of 100,000 items reused. The LSP uses it; the checker still runs over the whole file.
- The calc, schema, and machine examples, exercised by `pnpm check`.

Not built:

- Incremental checking.
- Formatting.
- Workspace symbols and signature help.
- Source maps for runtime stack traces.
- Publishing. The package is private and has no 1.0 milestone.

Open gaps are tracked at <https://github.com/saiashirwad/parlance/issues>.
