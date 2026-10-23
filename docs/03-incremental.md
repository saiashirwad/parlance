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
- The new token has the same kind, text, and name as the old token at that boundary.
- Its span equals the old span shifted by `delta`.

From that boundary the lexer sees identical text with no stored state, so the shifted old tail is the exact tokenization. When no boundary qualifies, the run reaches end of file and no tail is reused. The result is still correct, just not incremental on the token side.

Tokens before the edit are not reused. A regex match can reach across the edit even when the grammar has no lookaround. Take `token T /a[^z]*z|a/` on `a; a; a; a;`. Every `a` is a one-character `T` token because no `z` follows. Change the last `a` to `z` and the first `a` becomes one token spanning the whole line. A restart near the edit would keep the stale prefix. Lexing from 0 catches it. The same holds for a greedy `.*` that can absorb a later terminator. A local restart measured 12 ms on the benchmark edit, but it was not sound for these grammars, so it is not in the code.

Lookbehind is the one regex feature that can read text before the resync boundary. When a token, skip, word, or inline regex contains `(?<=` or `(?<!`, `reusableTail` returns false and the run goes to end of file.

## Span shifting

When `delta` is 0, no span moves. `reparse` reuses the previous item nodes by reference, the same way it already reuses the items before the window. The result is structurally identical to a full parse and shares nodes with `previous`.

When `delta` is not 0, every span after the edit needs a new number. The value uses plain objects, so the only correct result is a clone with shifted spans. The clone copies keys with `Object.keys` instead of allocating an entry pair per node with `Object.entries`. `mutate: true` still shifts the previous nodes in place and does not allocate.

The root span starts and ends where a full parse would put it, including recovery tokens that the root repetition skipped and a header before the item list.

## Measurements

Machine: macOS, Node 24.22.0, 2026-10-23. Commands are `pnpm bench` for the table and a throwaway timing copy of `reparse` for the phase split and the other edit positions.

Before this work, at 100,000 calc declarations (2.8 MB, 900,006 tokens):

| phase | ms |
| --- | --- |
| lex the whole file | 144 |
| token guard | 15 |
| select and parse the window | 1.3 |
| clone the reused tail | 91 |
| diagnostics and splice | 11 |
| full parse, for comparison | 250 to 279 |

After, for the benchmark edit (a same-length replacement in the middle):

| phase | ms |
| --- | --- |
| validation before lexing | 6.3 |
| lex from 0 to the resync boundary | 68.7 |
| select and parse the window | 1.7 |
| shift spans | 0.1 |
| splice and diagnostics | 2.9 |
| full parse, for comparison | 219 to 285 |

Three final `pnpm bench` runs gave `edit ms` of 75.4, 73.3, and 73.7 against `parse ms` of 284.8, 282.2, and 275.2. That is 26% to 27% of a full parse.

The saving depends on where the edit is, because lexing runs from offset 0 to the resync boundary.

| edit | ms |
| --- | --- |
| same-length, offset 4 | 13.7 |
| same-length, middle | 79.7 |
| same-length, last line | 130 |
| one character inserted, middle | 154 |

A full parse of the same file measured 219 to 285 ms across runs. An insertion pays two extra costs. The reused tail tokens and trivia need shifted copies, and every AST span after the edit is cloned. On the same file the AST clone alone measured 63 ms. The remaining bottleneck for suffix edits is the prefix lex. It is linear in the distance from the start of the file to the edit. Removing it needs either a lexer with resumable state or a proof that a grammar's token regexes cannot reach across a boundary. `mutate: true` avoids the AST clone for the LSP.

## Verification

```
node --test tests/incremental.test.ts   # 2,400 randomized edits plus targeted cases
pnpm test
pnpm typecheck
node tools/check.ts --bench             # 9 steps, including the LSP edit scenario
pnpm bench
```

`tests/incremental.test.ts` compares value, diagnostics, `ok`, tokens, and trivia against a full parse for every edit. It also freezes `previous` and checks that no node moved.
