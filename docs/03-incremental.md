# Incremental reparse

`reparse` turns a previous `ParseResult` plus one edit into a new result without parsing the whole file. It lives in `src/parser/incremental.ts`. The LSP calls it on every document change, and `tools/bench.ts` measures it.

## The edit path

1. Check that `previous.value` has the item list named by `spec.incremental` and that item spans are ordered inside `previousSource`.
2. Lex the new source from offset 0. Stop as soon as the token stream has resynchronized with the previous one.
3. Reuse the previous token tail from the resync boundary, shifted by `delta`.
4. Pick the item window whose spans touch the edit, plus one neighbour on each side.
5. Parse only that window with `parseItemRange`.
6. Splice the new window values between the reused items before and after it. Shift spans after the edit when the edit changes the source length.

`stats.reused + stats.reparsed` equals the new item count. `stats.fallback` is true only when the caller gets a full parse.

## Token reuse

The lexer carries no state across tokens. A match reads text before its start only through lookbehind, an anchor, or a word boundary. The first reused token is compared against the previous stream, so its left context is checked. Later tokens see the same preceding characters inside the identical suffix. Lookbehind can read further back, so it disables tail reuse.

`relex` lexes the new source from offset 0 and stops at the first token boundary where three things hold.

- The boundary is at or after `edit.start + edit.insert.length`, so the rest of the new source equals the rest of the old source shifted by `delta`.
- The new token has the same kind, key, text, and span as the old token at that boundary, shifted by `delta`.
- Every token before the window matched the previous stream during the same scan.

From that boundary the lexer sees identical text with no stored state, so the shifted old tail is the exact tokenization. When no boundary qualifies, the run reaches end of file and no tail is reused. The result is still correct, just not incremental on the token side.

The prefix comparison is fused into the lex loop: each token before the window is checked against the old token at the same index as it is produced, so a mismatch aborts the scan without a second pass. Tokens are written once into the final buffer; the reused tail is appended with typed-array `set` and shifted in place when `delta` is not zero. A same-length edit that leaves every token boundary and key unchanged returns a new `TokenList` over the previous arrays with the new source string, so it copies nothing.

Tokens before the edit are not reused. A regex match can reach across the edit even when the grammar has no lookaround. Take `token T /a[^z]*z|a/` on `a; a; a; a;`. Every `a` is a one-character `T` token because no `z` follows. Change the last `a` to `z` and the first `a` becomes one token spanning the whole line. A restart near the edit would keep the stale prefix. Lexing from 0 catches it. The same holds for a greedy `.*` that can absorb a later terminator. A local restart measured 12 ms on the benchmark edit, but it was not sound for these grammars, so it is not in the code.

### Reuse guards

Lexing from 0 is not enough by itself. The AST items before and after the window are reused, so their tokens must still be the same ones the item parser saw.

- **Prefix.** For every item retained before the window, the new token stream is compared one-for-one with the previous stream. A token that changes class without changing text (a lookahead token, for example) forces a full parse. This was a real bug: `token Special /a(?=[\s\S]*z)/` on `a; b; c; d; z;`, changing `z` to `y`, leaves the text of the first `a` unchanged but turns it into a word.
- **Suffix.** Items retained after the window are compared against the previous stream until the resync token. If lexing never resyncs, every suffix token is compared. A guarded root compares everything from the window end to EOF, so a footer token whose classification changes (for example through lookbehind) forces a fallback. A mismatch falls back.
- **Root syntax.** A root may have uncaptured header or footer syntax outside the item repetition, such as `"begin" items:Decl* "end"`. `incremental.guarded` records that for both array-shaped and field-shaped roots. When it is set, an edit at or outside the item range falls back, and the previous root span and captured extras bound the result. Without this, deleting the footer would be accepted by an item-only reparse while a full parse rejects the file.
- **Parser predicates.** A predicate inside an item (`&(...)` or `!(...)`, including through a referenced rule) can inspect tokens beyond that item. Token equality cannot prove what it observed, so such grammars disable incremental mode and reparse fully. The randomized oracle covers a predicate that inspects four later items. Predicates in root syntax outside the repetition disable it for the same reason.
- **Guarded diagnostics.** If a guarded window parse reports an error, the reparse falls back. A malformed item could otherwise make the window parser skip into header or footer syntax that was never revalidated.
- **Non-empty roots.** A root `Decl+` requires at least one item. If the spliced result has none, the reparse falls back so the full parser reports the minimum.
- **Custom word.** The non-ASCII custom-word path advances the lexer by the match length. Before the fix it did not advance, so a grammar with `word /[a-z]+/` looped forever.

Lookbehind is the one regex feature that can read text before the resync boundary. When a token, skip, word, or inline regex contains `(?<=` or `(?<!`, `reusableTail` returns false and the run goes to end of file.

## Span shifting

When `delta` is 0, no span moves. `reparse` reuses the previous item nodes by reference, the same way it already reuses the items before the window. The result is structurally identical to a full parse and shares nodes with `previous`.

When `delta` is not 0, every span after the edit needs a new number. The value uses plain objects, so the only correct result is a clone with shifted spans. The clone walks own keys with `for...in`, which does not allocate a key array per node. `mutate: true` shifts the previous nodes in place and does not allocate.

The root span starts and ends where a full parse would put it, including recovery tokens that the root repetition skipped and a header before the item list.

## Measurements

Machine: macOS, Node 24.22.1, 2026-10-23. Commands are `pnpm bench` for the calc
and schema tables, `node tools/bench-lsp.ts` for the editor path, and
`node tools/compare-langkit.mjs` for the head-to-head parser comparison.

At 100,000 calc declarations (2.8 MB, 900,006 tokens), `pnpm bench` reports:

| phase | ms |
| --- | ---: |
| lex the whole file | 57 |
| full parse | 126 (22.8 MB/s) |
| middle edit | 20 (16% of a full parse) |
| reused items | 99,998 of 100,000 |

The old comparison grammar (4.18 MB, 1,000,001 tokens) measures 54 ms, or
77 MB/s, and a middle edit takes 14.6 ms (27% of a full parse). The old langkit
parserator parser measures 102 ms on the same corpus.

The edit path is still linear in the distance from offset 0 to the edit, because
the token stream is re-lexed from the start. The fused prefix check and typed
array copies cut the constant, but a middle edit still scans half the file.
Removing that needs resumable lexer state or a static proof that no token regex
can reach across a boundary; a local restart was measured at 12 ms but was not
sound for `token T /a[^z]*z|a/` and similar grammars.

`node tools/bench-lsp.ts` measures the editor path on the same corpus:

| corpus | full analyze | edit + analyze | semantic tokens | folding |
| --- | ---: | ---: | ---: | ---: |
| 2,000 declarations (50 KB) | 6.0 ms | 1.6 ms | 0.7 ms | 0.05 ms |
| 20,000 declarations (543 KB) | 33.5 ms | 12.0 ms | 6.4 ms | 0.5 ms |
| 100,000 declarations (2.8 MB) | 217 ms | 94 ms | 43 ms | 2.6 ms |

`analyzeParsed` leaves semantic tokens lazy, so a keystroke does not pay for
them. On the 100k file the edit path is mostly the language checker (about
70 ms) rather than reparse (about 19 ms).

## Verification

```
node --test tests/incremental.test.ts   # 2,400 randomized edits plus targeted cases
pnpm test
pnpm typecheck
node tools/check.ts --bench             # 14 steps, including the LSP edit scenario
pnpm bench
pnpm bench:lsp
```

`tests/incremental.test.ts` compares value, diagnostics, `ok`, tokens, and trivia against a full parse for every edit. It also freezes `previous` and checks that no node moved.
