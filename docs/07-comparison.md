# Parser and LSP performance: parlance vs langkit

This compares the two checkouts on the same machine, Node 24.22.1, with the
same grammar and the same generated source. It is a **parser throughput**
comparison, not a language-feature comparison.

- parlance: `/Users/texoport/code/langkit-first-principles`
- old langkit: `/Users/texoport/code/langkit`
- 10 cores; load printed with each run.

Reproduce:

```sh
node tools/compare-langkit.mjs        # parser vs old langkit
node tools/compare-langkit.mjs --gate # fail if parlance exceeds 0.75x the old parser
node tools/bench.ts                   # calc and schema corpora
node tools/bench-lsp.ts               # edit, analyze, semantic tokens, folding
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
warms up twice, and reports the median of seven runs. Old and new are measured
alternately so machine load hits both sides. The old side compiles `checkSource`
+ `wire` + `define`; the new side compiles `parseGrammar` + `compileGrammar`.

## Common grammar

Medians of three runs, load 2.9–3.6:

| corpus | old langkit | parlance | parlance / old |
| --- | ---: | ---: | ---: |
| compile grammar -> parser | 0.41 ms | 0.09 ms | 0.22× |
| 20,000 declarations (0.38 MB) | 10.4 ms (36.5 MB/s) | 4.8 ms (78.0 MB/s) | 0.46× |
| 100,000 declarations (1.98 MB) | 52.4 ms (37.8 MB/s) | 25.2 ms (78.5 MB/s) | 0.48× |
| 200,000 declarations (4.18 MB) | 101.6 ms (41.1 MB/s) | 47.9 ms (87.2 MB/s) | 0.47× |

Parlance is now **about 2.1× faster than the old parserator parser** at batch
parsing, at 78–87 MB/s. Before this work it was 1.7× slower (175 ms at 200k).
The turnaround came from the data shape, not from a faster interpreter:

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
| 20,000 declarations | 2.2 ms | 45% |
| 100,000 declarations | 7.3 ms | 29% |
| 200,000 declarations | 14.4 ms | 30% |

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
corpus: a full analyze, a check of an already parsed tree, an edit plus
`analyzeParsed`, the same edit through `ModuleGraph`, an insertion, a
semantic-tokens encode, and a folding request. Medians of three runs:

| corpus | full analyze | check only | edit + analyze | graph edit | insert + analyze | semantic tokens | folding |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2,000 declarations (50 KB) | 4.2 ms | 0.5 ms | 1.2 ms | 1.0 ms | 1.8 ms | 0.7 ms | 0.05 ms |
| 20,000 declarations (543 KB) | 30.5 ms | 7.0 ms | 9.5 ms | 9.7 ms | 15.5 ms | 6.6 ms | 0.5 ms |
| 100,000 declarations (2.8 MB) | 221 ms | 51 ms | 64 ms | 69 ms | 103 ms | 45 ms | 2.5 ms |

The LSP no longer materializes semantic tokens on every keystroke. `analyze`
checks the tree and leaves `analysis.tokens` lazy; the semantic-tokens request
encodes straight from the columnar buffer and the check facts. At 100k
declarations the remaining edit cost is the language checker, not the parser:
reparse is about 20 ms, checking is about 45–50 ms, and graph bookkeeping adds a
few milliseconds. The checker no longer allocates an `{ ir, type }` wrapper per
expression, interns base and literal types, and replaces snapshot closures with
integer marks. `ModuleGraph` computes a node's exports on first use.

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
| calc 100,000 decls | 56 ms | 119 ms (24.2 MB/s) | 16 ms (14%) | 99,998 |
| schema 500 models | 1.0 ms | 2.6 ms (27.5 MB/s) | 0.53 ms | 997 |

Old langkit `grammar-bench` on `domain.grammar` (7 MB corpus):

| parser | median | throughput |
| --- | ---: | ---: |
| generated grammar | 290 ms | 23.7 MB/s |
| hand-written | 389 ms | 17.7 MB/s |

Old `solver-bench` (different language, HM checking): main 3.38 ms,
synthetic-100 75.7 ms, synthetic-200 189.3 ms.

The calc grammar is precedence-heavy and builds a larger AST per declaration,
so it runs at 24.2 MB/s against the common grammar's 78–87 MB/s. The old
generated grammar's 23.7 MB/s is on a different language and corpus.

## What this means

1. **The token-array design now wins.** The earlier measurement said a token
   array should be faster but was not. The missing piece was object shape: one
   `LexToken` plus a nested `Span` per token dominated both lexing and GC. A
   columnar buffer keeps the single-pass design and removes the allocation.
2. **Grammar compilation remains about 4.5× faster**: 0.09 ms vs 0.41 ms for the
   full grammar-to-callable-parser path.
3. **Incremental editing is the structural win** old langkit lacks: 29–30% of a
   full parse at 100k–200k declarations, with 99,998 of 100,000 items reused.
4. **Editor latency is still dominated by checking on large files.** At 2,000
   declarations a change round-trips in about 1 ms. At 100,000 declarations
   checking is roughly half the edit cost; the parser and token buffer are no
   longer the bottleneck.
5. This comparison does not measure memory, cross-file behavior, or TypeScript
   content mapping. Those are separate axes.

## Follow-up

- Issue #9: the batch parser is now faster than parserator. Run
  `pnpm compare:gate` before landing parser changes. The gate refuses to run
  above 0.75 load per core unless `--force` is passed, and fails when any corpus
  exceeds 0.75× the old parser.
- Issue #13: resumable lexer state for suffix edits. The prefix lex is still
  linear in the edit distance because a token regex can reach across the edit.
  Removing it needs a proof that a grammar's token regexes cannot cross a
  boundary, or a resumable lexer that can revalidate a checkpoint.
- Checking still dominates large-file LSP edits. The next wins are incremental
  checking or avoiding the lowered IR when only facts are requested; per-node
  allocations in `examples/calc` have already been reduced.
- Retained heap for the columnar buffer is still unmeasured.
- Re-run both benchmark tools on an otherwise idle machine before making a
  public throughput claim. Load averages move the numbers by 10–20%.
