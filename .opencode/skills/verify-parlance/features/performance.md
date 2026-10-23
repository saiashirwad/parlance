# Parser performance comparison

## Sub-features

- `tools/compare-langkit.mjs` compiles the same grammar in both DSLs and parses identical corpora.
- It reports grammar-to-parser compile time, full-parse throughput, and parlance's incremental middle edit.
- `docs/07-comparison.md` records the interpretation and native-workload caveats.

## How to get to it (user POV)

Run `pnpm compare:langkit` from the repository root. The old checkout defaults
to `~/code/langkit`; pass `--langkit <path>` for another checkout, or `--json`.

## Driving it with the shell

```sh
pnpm compare:langkit
pnpm compare:langkit --json
```

Pass criteria: compile succeeds in both DSLs, both parsers return the expected
declaration count at 20k/100k/200k, and no timing run falls back or errors.

## Gotchas

- This is parser throughput, not checking, memory, LSP latency, or feature parity.
- The machine load is printed; re-run on an idle machine before a public claim.
- Old langkit has no incremental reparse, so its incremental column is absent.
- Native benchmarks use different grammars and corpora; only the common-grammar table is head-to-head.
