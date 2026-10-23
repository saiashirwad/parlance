# Parser and LSP performance: parlance vs langkit

This compares the two checkouts on the same machine, Node 24.22.1, with the
same grammar and the same generated source. It is a **parser throughput**
comparison, not a language-feature comparison.

- parlance: `/Users/texoport/code/langkit-first-principles`
- old langkit: `/Users/texoport/code/langkit`
- 10 cores; load printed with each run.

Reproduce:

```sh
node tools/compare-langkit.mjs   # parser vs old langkit
node tools/bench.ts              # calc and schema corpora
node tools/bench-lsp.ts          # edit, analyze, semantic tokens, folding
```

The harness defines the same language in both grammar DSLs:

```parl
grammar Common
skip /\s+/
word /[A-Za-z_][A-Za-z0-9_]*/
token Number /\d+/
root File
rule File = { @file declarations:Decl* };
rule Decl = { @let "let" ~ name:Name "=" value:$Number ";" };
rule Name = { word };
```

It parses the same lines, asserts both produce the expected declaration count,
warms up twice, and reports the median of seven runs. The old side compiles
`checkSource` + `wire` + `define`; the new side compiles `parseGrammar` +
`compileGrammar`.

## Common grammar

Stable run, load 2.2:

| corpus | old langkit | parlance | parlance / old |
| --- | ---: | ---: | ---: |
| compile grammar -> parser | 0.43 ms | 0.09 ms | 0.21× |
| 20,000 declarations (0.38 MB) | 11.2 ms (33.7 MB/s) | 4.9 ms (76.4 MB/s) | 0.44× |
| 100,000 declarations (1.98 MB) | 49.7 ms (39.8 MB/s) | 25.3 ms (78.2 MB/s) | 0.51× |
| 200,000 declarations (4.18 MB) | 102.5 ms (40.8 MB/s) | 54.1 ms (77.2 MB/s) | 0.53× |

Parlance is now **1.9× faster than the old parserator parser** at batch parsing,
at 77–78 MB/s. Before this work it was 1.7× slower (175 ms at 200k). The
turnaround came from the data shape, not from a faster interpreter:

- **Interned integer keys.** Terminals are `KeyId`s. First sets are `Uint8Array`
  bitsets, so dispatch is an array load instead of string hashing.
- **Columnar token buffer.** Tokens are parallel typed arrays (`kind`, `keyId`,
  `start`, `end`, with the highlight packed into `kind`). The lexer writes no
  per-token objects and slices no token text. The parser reads the arrays
  directly; a `LexToken` is materialized only for hosts and tests.
- **Allocation-free lexer paths.** Keyword lookup is a length-indexed array, not
  a growing `Map` of `word:${text}` keys. Single-character symbols use a code
  unit table; longer symbols are tried first for maximal munch. Simple digit
  tokens scan without a regex. Fast whitespace and line comments skip the
  general regex loop entirely.
- **Parser fast paths.** Terminal runs inside a sequence match in place, a
  single-terminal rule returns its leaf directly, rule references dispatch
  without the generic expression switch, and operator probes no longer re-enter
  the machine for a literal that cannot match.

## Incremental editing

Parlance incremental edit on the same corpus (one digit replaced in the middle):

| corpus | edit | share of full parse |
| --- | ---: | ---: |
| 20,000 declarations | 3.2 ms | 64% |
| 100,000 declarations | 7.8 ms | 31% |
| 200,000 declarations | 14.6 ms | 27% |

Old langkit has no incremental reparse. The small-corpus ratio is dominated by
fixed work (validation, window parse, splice); the large-corpus ratio is the
useful one.

The edit path keeps the previous design's soundness rules. It still lexes from
offset 0 because a token regex can reach across the edit (see
[`03-incremental.md`](03-incremental.md)), but the prefix comparison is fused
into the lex scan instead of a second pass, and the reused tail is copied with
typed-array `set` rather than per-token pushes. A same-length edit whose token
boundaries do not change reuses the previous token arrays outright. The AST
shift uses `for...in` instead of allocating a key array per node.

## LSP path

`tools/bench-lsp.ts` measures the work the editor server does on the calc
corpus: a full analyze, an edit plus `analyzeParsed`, an insertion plus
`analyzeParsed`, a semantic-tokens encode, and a folding request. Medians:

| corpus | full analyze | edit + analyze | insert + analyze | semantic tokens | folding |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2,000 declarations (50 KB) | 6.0 ms | 1.6 ms | 2.2 ms | 0.7 ms | 0.05 ms |
| 20,000 declarations (543 KB) | 33.5 ms | 12.0 ms | 20.1 ms | 6.4 ms | 0.5 ms |
| 100,000 declarations (2.8 MB) | 217 ms | 94 ms | 126 ms | 43 ms | 2.6 ms |

The LSP no longer materializes semantic tokens on every keystroke. `analyze`
checks the tree and leaves `analysis.tokens` lazy; the semantic-tokens request
encodes straight from the columnar buffer and the check facts. At 100k
declarations the remaining edit cost is mostly the language checker, not the
parser: reparse is about 19 ms and `analyzeParsed` about 70 ms.

The semantic-token encoder is one forward pass over the source and sorted
spans, with line starts computed once. The previous implementation sliced every
token, ran `matchAll` per slice, built a part object per line segment, and
sorted the parts.

## Native workloads

These are each project's own benchmark, so the grammars differ. Use them for
scale, not as a head-to-head result.

Parlance `pnpm bench` (2.8 MB calc corpus, 900,006 tokens):

| corpus | lex | full parse | edit | reused |
| --- | ---: | ---: | ---: | ---: |
| calc 100,000 decls | 57 ms | 126 ms (22.8 MB/s) | 20 ms (16%) | 99,998 |
| schema 500 models | 0.95 ms | 2.6 ms (26.9 MB/s) | 0.56 ms | 997 |

Old langkit `grammar-bench` on `domain.grammar` (7 MB corpus):

| parser | median | throughput |
| --- | ---: | ---: |
| generated grammar | 290 ms | 23.7 MB/s |
| hand-written | 389 ms | 17.7 MB/s |

Old `solver-bench` (different language, HM checking): main 3.38 ms,
synthetic-100 75.7 ms, synthetic-200 189.3 ms.

The calc grammar is precedence-heavy and builds a larger AST per declaration,
so it runs at 22.8 MB/s against the common grammar's 77 MB/s. The old
generated grammar's 23.7 MB/s is on a different language and corpus.

## What this means

1. **The token-array design now wins.** The earlier measurement said a token
   array should be faster but was not. The missing piece was object shape: one
   `LexToken` plus a nested `Span` per token dominated both lexing and GC. A
   columnar buffer keeps the single-pass design and removes the allocation.
2. **Grammar compilation remains about 5× faster**: 0.09 ms vs 0.43 ms for the
   full grammar-to-callable-parser path.
3. **Incremental editing is the structural win** old langkit lacks: 27–31% of a
   full parse at 100k–200k declarations, with 99,998 of 100,000 items reused.
4. **Editor latency is dominated by checking on large files.** At 2,000
   declarations a change round-trips in under 2 ms. At 100,000 declarations the
   checker is the next target; the parser and token buffer are no longer the
   bottleneck.
5. This comparison does not measure memory, cross-file behavior, or TypeScript
   content mapping. Those are separate axes.

## Follow-up

- Issue #9: the batch parser is now faster than parserator; keep the comparison
  as the regression gate.
- Issue #13: resumable lexer state for suffix edits. The prefix lex is still
  linear in the edit distance because a token regex can reach across the edit.
  Removing it needs a proof that a grammar's token regexes cannot cross a
  boundary, or a resumable lexer that can revalidate a checkpoint.
- The checker now dominates large-file LSP edits; profile `examples/calc` check
  work next.
- Re-run both benchmark tools on an otherwise idle machine before making a
  public throughput claim. Load averages move the numbers by 10–20%.
