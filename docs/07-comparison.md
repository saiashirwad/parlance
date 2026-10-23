# Parser performance: parlance vs langkit

This compares the two checkouts on the same machine, Node 24.22.1, with the
same grammar and the same generated source. It is a **parser throughput**
comparison, not a language-feature comparison.

- parlance: `/Users/texoport/code/langkit-first-principles`
- old langkit: `/Users/texoport/code/langkit`
- 10 cores; load printed with each run.

Reproduce:

```sh
node tools/compare-langkit.mjs
# or: pnpm compare:langkit
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

Stable run, load 5.95:

| corpus | old langkit | parlance | parlance / old |
| --- | ---: | ---: | ---: |
| compile grammar -> parser | 0.43 ms | 0.08 ms | 0.19× |
| 20,000 declarations (0.38 MB) | 10.9 ms (34.8 MB/s) | 17.3 ms (21.8 MB/s) | 1.59× |
| 100,000 declarations (1.98 MB) | 51.3 ms (38.5 MB/s) | 88.1 ms (22.4 MB/s) | 1.72× |
| 200,000 declarations (4.18 MB) | 99.9 ms (41.8 MB/s) | 175.2 ms (23.8 MB/s) | 1.75× |

Across three repetitions the ratio was stable at **1.5–1.75×** for 20k–200k
declarations. The old parserator parser is faster at batch parsing.

Parlance incremental edit on the same corpus:

| corpus | edit | share of full parse |
| --- | ---: | ---: |
| 20,000 declarations | 5.9 ms | 34% |
| 100,000 declarations | 31.4 ms | 36% |
| 200,000 declarations | 64.5 ms | 37% |

Old langkit has no incremental reparse.

## Native workloads

These are each project's own benchmark, so the grammars differ. Use them for
scale, not as a head-to-head result.

Old langkit `grammar-bench` on `domain.grammar` (7 MB corpus):

| parser | median | throughput |
| --- | ---: | ---: |
| generated grammar | 290 ms | 23.7 MB/s |
| hand-written | 389 ms | 17.7 MB/s |
| grammar/hand | 0.75× | |

Old `solver-bench` (different language, HM checking): main 3.38 ms,
synthetic-100 75.7 ms, synthetic-200 189.3 ms.

Parlance `pnpm bench` (2.8 MB calc corpus):

| corpus | lex | full parse | edit | reused |
| --- | ---: | ---: | ---: | ---: |
| calc 100,000 decls | 141 ms | 271 ms (10.6 MB/s) | 82.7 ms (30.5%) | 99,998 |
| schema 500 models | 2.1 ms | 8.5 ms (8.3 MB/s) | 1.9 ms | 997 |

## What this means

1. **The token-array parser did not deliver the expected batch speedup.** On a
   common grammar the old parserator parser is about 1.7× faster. The likely
   cost is the new design's per-token object allocation and its AST/span
   construction, but this needs a profile before claiming a cause. The original
   survey said a token array should be substantially faster; that assumption is
   not supported by this measurement.
2. **Grammar compilation is about 5× faster** in parlance: 0.08 ms vs 0.43 ms
   for the full grammar-to-callable-parser path.
3. **Incremental editing is the clear win** that old langkit lacks: a middle
   edit is 30–37% of a full parse, with 99,998 of 100,000 items reused.
4. The comparison does not measure checking, memory, LSP latency, TypeScript
   content mapping, or cross-file behavior. Those are separate axes and should
   not be inferred from parse throughput.

The old grammar/hand ratio (0.75×) also shows that its generated parser is
faster than its own hand-written parser. The new benchmark has no equivalent
hand-written comparison.

## Follow-up

- Issue #9: profile the token parser and decide whether memoization or a
  generated per-rule backend can close the 1.7× gap.
- Issue #13: resumable lexer state for suffix edits.
- Re-run `node tools/compare-langkit.mjs` on an otherwise idle machine before
  making a public throughput claim. The load average is printed in the output.
