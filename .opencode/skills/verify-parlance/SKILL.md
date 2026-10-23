---
name: verify-parlance
description: Drive the parlance compiler, CLI, TypeScript content mapper, Node loader, LSP, and emit targets on their real paths and capture evidence. Use before merging any change to src/, examples/, or the grammar, and when a report claims a language feature works.
---

# Verify parlance

Parlance is a TypeScript library plus a CLI. There is no web UI and no long-running server except the LSP, which speaks JSON-RPC over stdio. Every drive below is a short-lived process; evidence is captured to disk and survives cleanup.

The repository is `saiashirwad/parlance`. Run everything from the repository root.

## Launch

```sh
pnpm install
node --version    # must be >= 24.2; the repo is ESM with type stripping
```

No build step. `./parlance` is the shipped CLI; `node src/cli.ts` is the same entry point. The project config is `parlance.config.ts`; it lists `calc`, `schema`, and `machine`.

## Doctor

One read-only check. If it fails, stop and fix the checkout before driving anything else.

```sh
./parlance check examples/calc/demo.calc
```

Pass: prints `ok examples/calc/demo.calc` and exits 0. Failure modes: missing `node_modules`, a config that does not export `languages`, or a grammar that no longer compiles.

## Drive

The one-command sweep is the default proof:

```sh
node tools/check.ts              # typecheck, tests, CLI, loader, LSP edit, tsgo navigation
node tools/check.ts --bench      # adds the benchmark table
node tools/check.ts --json       # machine-readable step results
```

Pass: every step prints `ok`, the summary says `all N steps passed`, exit 0. A failing step prints the command and the tail of its output.

Individual paths, for narrowing a failure:

```sh
pnpm typecheck
pnpm test
./parlance check examples/calc/demo.calc examples/schema/blog.schema examples/machine/order.machine
./parlance check examples/schema/catalog.schema examples/calc/imports.calc
node --import ./examples/register.ts examples/typescript/calc.ts
node --import ./examples/register.ts examples/typescript/catalog.ts
node --import ./examples/register.ts examples/typescript/schema.ts
node --import ./examples/register.ts examples/typescript/machine.ts
node --test tests/tsgo.test.ts
node tools/lsp-smoke.ts
pnpm bench
```

Expected runtime output:

| command | stdout |
| --- | --- |
| calc | `250` then `250 125 true` |
| schema | `sai@example.com 1 1 0 1 1 1 0` |
| machine | `Paid Checkout Paid pay 50` |

`examples/typescript/*.ts` import guest files through the Node loader. If one fails, the thrown `SyntaxError` carries the guest line and column.

`tests/tsgo.test.ts` starts the real TypeScript 7.1 content mapper, opens a project, and asserts hover and go-to-definition from a `.ts` import into `.calc` and `.schema`. It does not use a mock mapper.

`tools/lsp-smoke.ts` spawns `src/lsp/cli.ts`, opens a calc document, breaks it, fixes it, and asserts diagnostics, hover, definition, and semantic tokens across the edit. It kills only the child it started.

## Evidence

Capture each run under `.opencode/skills/verify-parlance/evidence/<UTC timestamp>/`:

```sh
stamp=$(date -u +%Y%m%dT%H%M%SZ)
dir=".opencode/skills/verify-parlance/evidence/$stamp"
mkdir -p "$dir"
git rev-parse HEAD > "$dir/rev.txt"
node --version > "$dir/node.txt"
node tools/check.ts --bench > "$dir/check.txt" 2>&1; echo "exit=$?" >> "$dir/check.txt"
```

Proof standards:
- Exercise the real path: the CLI binary, the Node loader hooks, the stdio LSP, the real content mapper. Do not substitute an in-process helper for the path a user takes.
- Capture the action and the result. A hover assertion needs the position, the returned contents, and the definition line.
- Verify side effects, not just stdout: emitted files exist and contain the expected DDL, SQLite rows are returned, the LSP diagnostics version matches the edit.
- A green `tools/check.ts` is the minimum, not the whole proof. For a feature change, also run the map entry that covers it.

Never commit `evidence/`; it is ignored. Never delete it during cleanup.

## Cleanup

- `tools/lsp-smoke.ts` and `tools/check.ts` kill their own children. Do not `pkill` by name.
- Remove scratch emit output (for example `schema.sql` written with `--out`) only if you created it in the repo root.
- Leave `node_modules`, evidence, and generated example artifacts in place; they make the next run cheap.

## Helpers

| helper | invocation | proves |
| --- | --- | --- |
| `tools/check.ts` | `node tools/check.ts [--bench] [--json]` | every shipped path in one sweep |
| `tools/grammar-check.ts` | `node tools/grammar-check.ts` | every grammar compiles, every generated AST is current, self-host matches |
| `tools/lsp-smoke.ts` | `node tools/lsp-smoke.ts` | live LSP edit, diagnostics, hover, definition, tokens |
| `tools/bench.ts` | `pnpm bench` | lex/parse/edit medians and reuse counts |
| `src/grammar/cli.ts` | `node src/grammar/cli.ts gen <grammar.parl> <out.ts>` | typed AST generation |

## Feature map

Start at [`features/README.md`](features/README.md). Each file names the user-visible feature, how to reach it, the exact drive, and the observable end state.
