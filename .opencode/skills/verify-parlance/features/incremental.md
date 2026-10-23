# Incremental parsing

## Sub-features

- `reparse(spec, previous, source, edit, options)` reuses root items outside the edit window.
- The result carries `stats`: `fallback`, `reused`, `reparsed`, `window`.
- The LSP calls `reparse` on every change with `mutate: true`.
- Full-parse equality is the oracle; `verify: true` compares and falls back on any difference.
- Soundness guards: resync token equality after the edit, identical shifted suffix, lookbehind fallback, ordered spans, root shape.

## How to get to it (user POV)

An editor types into a large guest file and expects diagnostics and facts to update without a full reparse. On 2026-10-23 the 2.8 MB calc corpus measured roughly a third of a full parse (25–38% across runs; load can raise it), with 99,998 of 100,000 items reused.

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
- On 2026-10-23 the 2.8 MB calc corpus measured roughly 25–38% of a full parse for a middle edit (load can push it toward half), down from ~100% before token reuse. The target is `edit ms` below 50% of `parse ms` on an idle machine, no fallback, and the oracle green. Record every fresh number; do not assume the ratio holds for suffix edits.

## Gotchas

- Reused prefix and suffix items are guarded by one-for-one token comparison, so a lookahead token reclassified by later text falls back to a full parse. Guarded roots compare the footer through EOF.
- A grammar with a parser predicate (`&`/`!`) inside an item rule disables incremental mode; token equality cannot prove what the predicate observed.
- A root with uncaptured header/footer syntax is `guarded` for both array and field shapes; an edit at or outside the item repetition falls back, and the root span keeps the header and footer.
- A `+` item repetition falls back when the spliced list would be empty; the full parser reports the missing item.
- The prefix lex runs from offset 0 to the resync boundary, so the saving depends on edit position: a suffix edit is only ~1.8x faster, a middle edit ~3x.
- A grammar with lookbehind (`(?<=` or `(?<!`) in a token, skip, word, or inline regex disables tail reuse and lexes to the end.
- `mutate: true` shifts reused ASTs in place and discards the previous tree. Use it only where the previous analysis is dropped immediately (the LSP does).
- The root must be a repetition of one item rule; otherwise `reparse` falls back to a full parse and says so.
- Window selection adds one untouched item on each side to absorb token merges and bounded lookahead.
- `docs/03-incremental.md` is the algorithm record; update it with any change to the guards or the window.
