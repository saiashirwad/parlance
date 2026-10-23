# Incremental parsing

## Sub-features

- `reparse(spec, previous, source, edit, options)` reuses root items outside the edit window.
- The result carries `stats`: `fallback`, `reused`, `reparsed`, `window`.
- The LSP calls `reparse` on every change with `mutate: true`.
- Full-parse equality is the oracle; `verify: true` compares and falls back on any difference.
- Soundness guards: token equality outside the edit, reused item text equality, ordered spans, root shape.

## How to get to it (user POV)

An editor types into a large guest file and expects diagnostics and facts to update without a full reparse. The CLI and library do not expose a latency promise yet; this map records the honest number.

## Driving it with the shell

```sh
# Random oracle: 80 seeds x 30 randomized edits, compare to a full parse.
node --test tests/incremental.test.ts

# The benchmark reports full parse vs edit and the reuse count.
pnpm bench

# LSP edit path, including a change that breaks and fixes the file.
node tools/lsp-smoke.ts
```

Pass criteria:
- Oracle: all 2,400 edits match the full parse for value, diagnostics, `ok`, tokens, and trivia; fewer than 30% fall back; previous results are never mutated.
- Benchmark: `reused + reparsed` equals the item count; no fallback; the `edit ms` column is recorded, not assumed.
- On 2026-10-23 the 2.8 MB calc corpus measured ~232 ms full parse and ~243 ms edit. The edit path is correct but not faster yet (issue #1). Do not claim a latency win until `edit ms` is materially below `parse ms`.

## Gotchas

- `mutate: true` shifts reused ASTs in place and discards the previous tree. Use it only where the previous analysis is dropped immediately (the LSP does).
- Full relex is still O(file); a broken quote or comment can change tokenization far past the edit, which is why the token guard is global.
- The root must be a repetition of one item rule; otherwise `reparse` falls back to a full parse and says so.
- Window selection adds one untouched item on each side to absorb token merges and bounded lookahead.
- `docs/03-incremental.md` is the algorithm record; update it with any change to the guards or the window.
