# Incremental reparse

`reparse` turns a previous `ParseResult` plus one edit into a new result without parsing the whole file. It lives in `src/parser/incremental.ts`. The LSP calls it on every document change, and `tools/bench.ts` measures it.

## The edit path

1. Check that `previous.value` has the item list named by `spec.incremental` and that item spans are ordered inside `previousSource`.
2. Reuse the token stream around the edit.
3. Pick the item window whose spans touch the edit, plus one neighbour on each side.
4. Parse only that window with `parseItemRange`.
5. Splice the new window values between the reused items before and after it. Shift spans after the edit when the edit changes the source length.

`stats.reused + stats.reparsed` equals the new item count. `stats.fallback` is true only when the caller gets a full parse.

## Token reuse

The lexer has no state at a token boundary. If the text before a token is unchanged, the tokenization from that boundary is unchanged too. That gives a local restart and a local stop.

The restart is the last token that ends at or before `edit.start`. The token that straddles the edit start is lexed again, so a character inserted at the boundary can merge with it. The lexer then runs forward and stops at the first token boundary where three things hold.

- The boundary is at or after `edit.start + edit.insert.length`, so the rest of the new source equals the rest of the old source shifted by `delta`.
- The new token has the same kind, text, and name as the old token at that boundary.
- Its span equals the old span shifted by `delta`.

From that boundary the lexer sees identical text with no stored state, so the shifted old tail is the exact tokenization. The function stops early when it finds no such boundary.

Two hazards get explicit handling.

- An `error` token before the restart can grow into a real token after the edit. The classic case is an unclosed quote that pairs with a quote inserted later. When any reused token is an `error`, lexing restarts at the first one.
- A regex with a lookaround can decide a token from text outside the token. For those grammars `locallyLexable` is false and `reparse` falls back to a full lex plus the old full-stream guard.

Comments and strings without lookaround need no extra check. An unclosed block comment runs to end of file, so an edit after it is inside trivia and the restart lands before it. A line comment can only change text after its newline, which is inside the relexed region. An unclosed token regex produces an `error` token, which the restart rule covers.

## Span shifting

When `delta` is 0, no span moves. `reparse` reuses the previous item nodes by reference, the same way it already reuses the items before the window. The result is structurally identical to a full parse and shares nodes with `previous`.

When `delta` is not 0, every span after the edit needs a new number. The value uses plain objects, so the only correct result is a clone with shifted spans. The clone copies keys with `Object.keys` instead of allocating an entry pair per node with `Object.entries`. `mutate: true` still shifts the previous nodes in place and does not allocate.

The root span grows to cover recovery tokens the window parser skipped. A full parse computes the root span from the last token the root repetition consumed, not from the last item, and a repaired tail can pass the last item.

## Measurements

Machine: macOS, Node 24.22.0, 2026-10-23. Commands are `pnpm bench` for the table and the same script with a throwaway probe for the edit kinds the table does not cover.

Before this work, at 100,000 calc declarations (2.8 MB, 900,006 tokens):

| phase | ms |
| --- | --- |
| lex the whole file | 144 |
| token guard | 15 |
| select and parse the window | 1.3 |
| clone the reused tail | 91 |
| diagnostics and splice | 11 |
| full parse, for comparison | 250 to 279 |

After:

| phase | ms |
| --- | --- |
| reuse tokens and trivia | 4 |
| validation before lexing | 5 |
| select and parse the window | 1.4 |
| shift spans | 0 for a same-length edit |
| splice and diagnostics | 2.7 |
| full parse, for comparison | 224 to 237 |

The benchmark edit is a same-length replacement, so it takes the no-shift path. Three runs gave `edit ms` of 12.6, 12.8, and 11.9 against `parse ms` of 236.8, 224.1, and 226.7. That is 5.3% to 5.7% of a full parse.

Edits that change the length still shift every later span. A throwaway probe on the same 100,000 declaration file measured one character inserted in the middle at 83 ms and one character deleted at 98 ms. An insertion at offset 0 measured 206 ms, because all 100,000 items and 900,000 tokens need new spans. The remaining bottleneck is that clone. It is linear in the file size and cannot disappear while `ParseResult.value` exposes absolute spans as plain objects. `mutate: true` avoids it for the LSP.

## Verification

```
node --test tests/incremental.test.ts   # 2,400 randomized edits plus targeted cases
pnpm test
pnpm typecheck
node tools/check.ts --bench             # 9 steps, including the LSP edit scenario
pnpm bench
```

`tests/incremental.test.ts` compares value, diagnostics, `ok`, tokens, and trivia against a full parse for every edit. It also freezes `previous` and checks that no node moved.
