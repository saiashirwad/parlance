# Survey: what langkit is today

This is a read of `saiashirwad/langkit` at the commit cloned on 2026-10-23, before any redesign. It separates what is essential from what is incidental.

## The current surface in one page

A language is a `HostLanguage`:

```ts
type HostLanguage = {
  extension: `.${string}`;
  host: (source: string, uri: string) => {
    declarations: readonly Piece[];
    javascript: (() => string) | undefined;
    diagnostics: readonly Diagnostic[];
  };
};
```

That is the whole public contract. Everything else is assembled by the language author:

| Capability | How it is wired today | Required by |
| --- | --- | --- |
| Syntax | `parserator` combinators in `*-syntax.ts` | author |
| Semantic checking | `Check` monad in `check.ts` | author |
| Highlighting | separate `TokenRule[]` in `analysis.ts` | author, duplicated from lexer |
| TypeScript surface | manual `Piece[]` offsets in `*-host.ts` | author |
| Runtime | hand-built `ir` + `javascript.ts`, or custom | author |
| Editor LSP | `analysis.ts` facts + `lsp.ts` adapter + `*-lsp.ts` | author, 3 files |
| Imports | `modules.ts` + an `imports` parser + masked source | author |
| Content mapper | `host/content-mapper.ts` + a package with one JSON entry | project |
| Node loading | `host/loader.ts` + `registerHostLanguages` | project |
| Grammar | `examples/grammar` only; not part of the library | example |

A language therefore spans five to seven files, and each file can disagree with the others. The schema language is 1,500 lines of syntax, model, host, checker, SQL, and runtime. The domain language is more. The grammar language is ~1,300 lines plus a 272-line runtime parser. None of those files know about the others as a single definition.

## What the 464 tests actually protect

The test suite is strong in two places and thin in two others.

Strong:

- The content mapper protocol: `openProject` identity, mappings, diagnostics.
- End-to-end TypeScript behavior: hover, definition, misuse errors, runtime output (`tools/editor-check.ts`, `tests/host.test.ts`).
- Check semantics: rollback, generator cleanup, deep stacks.
- Type contracts for HM and row polymorphism.

Thin:

- No incremental parsing or re-analysis test.
- No performance regression test in CI. `grammar-bench.ts` exists but is not a check.
- No test that a grammar's highlighter and parser use the same lexical rules.
- Almost every test is about one example language, not a reusable abstraction.

The 464 tests are evidence that the individual mechanisms work. They are not evidence that the abstractions compose.

## Measured baseline

On this machine (10 cores, Node 24.22, `tsgo` 7.1.0-beta):

- `grammar-bench`: 7 MB corpus, 22.6 MB/s generated grammar parser; hand-written parser 16.8 MB/s; generated/hand ratio 0.74. At 7 MB the grammar parser takes 285 ms.
- `domain-bench`: 1,000,000 reachable states explored in 408 ms; 6,030,000 transitions in 14.6 ms; peak heap +371 MB.
- `solver-bench`: 3.2 ms for the sample program, 182 ms for the synthetic 200 case.
- Full test suite: 17.3 s.

These are single-machine medians from the scripts above, not repeated trials across machines, and no CPU profile was captured. Treat them as orders of magnitude, not precise claims. The parser is not pathologically slow, but it is not the foundation for incremental parsing either: every rule call re-enters parserator, re-runs trivia and token regexes, allocates a reply, and only sometimes memoizes. Which share of the 285 ms is regex work versus allocation is unmeasured; the redesign's benchmark is meant to answer that.

## Assumptions that hold

1. **The content mapper is the right seam for TypeScript.** It lets guest files participate in the real compiler without codegen on disk. Mappings back to source spans give hover, definition, and references. This is the key insight of the project and should remain the center.
2. **Node loader hooks are the right seam for execution.** In-memory compilation avoids a build step and keeps editor behavior and runtime behavior on the same IR.
3. **Editor facts are separate from editor protocol.** `Analysis<T>` (definitions, references, types, tokens, diagnostics) is a good boundary. LSP should consume facts, not language internals.
4. **Language services must survive broken input.** Highlighting from the lexer while parsing fails is correct. Facts that survive resolution errors are correct. Any redesign must keep partial results.
5. **Diagnostics belong to the guest file, with routed origins.** Cross-module errors need an origin and a route, not a flattened message.
6. **A language can have several targets.** Schema already emits types, SQL, and a runtime; the library should make that normal rather than a one-off.
7. **Type systems differ.** HM is useful for expression languages, but schema and state machines need domain-specific checks. The core must not require HM, rows, or higher rank.

## Assumptions that do not hold

### 1. That `Check` needs generators

`Check<A>` is a generator-based effect system with an explicit continuation stack, scoped frames, a journal, and recovery. It is clever and it is tested. It is also the wrong default for a library that agents will author languages with:

- Every operation must be yielded. A checker reads as `yield*` plumbing rather than domain logic.
- Stack safety requires a hand-written evaluator (about 250 lines) that is harder to debug than ordinary recursion.
- Scopes, spans, documents, and facts are ambient state reached through combinators; it is hard to answer "what is in scope here?" from a stack trace.
- Generators allocate and suspend. We have not profiled this cost in isolation, so it is a hypothesis, not a measured bottleneck.
- Error recovery is coupled to the monad. A language that wants a different recovery policy has to reimplement it.

Verdict: **drop generators from the public checker API.** Use plain functions over an explicit `Checker` context: `cx.error`, `cx.declare`, `cx.resolve`, `cx.scope`, `cx.typed`. Depth is handled by normal recursion over syntax trees, with a parser nesting limit and a diagnostic instead of a stack overflow; the old stack-safety test was protecting a 30k-deep synthetic tree, not a real language. Hard failures use a private `AbortCheck` exception caught at declaration boundaries, not a monad.

The rollback behavior is still needed for inference. It moves into the type store as `mark` / `restore`, where it belongs, and is tested there.

### 2. That parserator is the parsing foundation

parserator is a good combinator library. It is not the right foundation here:

- It re-runs trivia and token regexes at every rule call. The baseline is consistent with this being expensive, but the split between regex work and allocation is unprofiled.
- It has no token array, so there is nothing stable to memoize against and nothing to reuse across edits.
- Error recovery is limited to cuts and expected sets. A language author cannot say "skip to the next declaration" without writing it.
- The self-hosted grammar interpreter maps grammar expressions to parserator closures at runtime. Static first sets are possible over that structure, but the current implementation does not compute or dispatch on them. Self-hosting alone is not the performance win; the token array and dispatch are.
- The API is a large combinator surface that language authors must learn in addition to their own grammar.

Verdict: **remove parserator as a dependency of the core.** Parse the grammar metalanguage with a small hand-written bootstrap parser, compile grammars to token-based parsers, and keep the runtime parser internal. The bootstrap parser is fixed and testable; generated parsers are data-driven and fast.

### 3. That one generic IR can serve every language

`ir.ts` defines literals, binary operators, calls, closures, records, variants, `match`, and `print`, and `javascript.ts` emits JavaScript for them. Schema uses `data` and `field`; domain and grammar use none of it; HM uses it heavily. The IR encodes JavaScript semantics in the core:

- `==` becomes `===`.
- Records become prototype-less objects.
- `print` is `console.log`.
- `match` is a JS `switch`.

That is fine for an expression language. It is wrong for SQL, state machines, and query planners, and it forces languages that do not fit to bypass the IR (schema does exactly that with a custom `data` blob and runtime).

Verdict: **remove the generic JS IR from the core.** Each language defines its own checked IR. The library provides a runtime seam: `runtime(ir) => string` for JS emission, and a helper for interpreted languages that embeds serialized IR and imports a runtime factory. A small JS expression printer can live in an example, not in the core.

### 4. That HM belongs in the library

The higher-rank HM implementation is 429 lines of subtle code (levels, skolemization, row lacks constraints, instantiation). It is excellent work. It is used by two examples and by no other language. It is a separate import, so it does not force itself on anyone, but its presence sets the default gravity of the library: "type checking" reads as "HM with rows." Four of six examples do not need it.

Verdict: **make type checking a kit, not a requirement.** Core provides diagnostics, spans, bindings, scopes, and facts. `parlance/types` provides an optional small unification-based type store and a TS printer. Domain-specific checkers (schema field types, machine transition legality) use the same `Checker` API without pretending to be HM.

### 5. That projection should be manual offset arithmetic

`Piece[]` is a low-level representation: `verbatim(text, span)`, `atom(text, span)`, and a list the author assembles by hand. `project` already accumulates virtual offsets correctly, so the problem is not that authors add integers. The problem is ergonomics: the schema host is 295 lines of piece assembly, `verbatim` throws on any length mismatch, and an atom with the wrong span silently misnavigates. The representation invites a class of mistakes without making the correct shape obvious.

Verdict: **replace pieces with a source-mapped template builder.** A tagged template (`ts\`export interface ${id(name)} { ... }\``) records the virtual offset of every interpolated source node as it builds the text. Nested templates flatten. This keeps the same mapping model, removes the manual assembly, and makes the common case one line per declaration.

### 6. That the lexer is separate from the grammar

Most examples declare highlighter rules separately from parser tokens. Reactor is the exception: its token table is derived from the checked grammar. The schema and domain examples keep two descriptions that can drift. That is a correctness bug waiting to happen: the editor colors a word as a keyword while the parser treats it as an identifier.

Verdict: **derive tokens, highlighting, and parser terminals from one grammar.** A grammar declares `skip`, `word`, `token`, and literals; the compiler emits one lexer. Highlighting is a mapping from terminal to token kind, refined by semantic facts.

### 7. That each language needs its own host and LSP script

`HostLanguage` only knows how to produce declarations, JS, and diagnostics. Everything else is out-of-band: `analyze`, `show`, `serve`, `registerHostLanguages`, a content-mapper entry, a CLI. This is the largest source of boilerplate in `examples/`.

Verdict: **one `Language` value should carry every capability.** The generic host, content mapper, LSP, and loader read it. A project writes one config file listing languages; it does not write a server per language.

## The parser question, specifically

Should parsing be self-hosted through a grammar DSL?

**Yes, as a compiler frontend, not as a universal runtime interpreter.**

The useful version of self-hosting is:

1. Write the grammar metalanguage in its own syntax.
2. Bootstrap it with a small hand-written parser.
3. Compile that grammar to a token-based parser.
4. Parse the grammar definition with the compiled parser and compare the AST to the bootstrap AST.
5. Use the same compiler for every user language.

That gives grammar authors a declarative frontend and gives the library one parser implementation. It does not require interpreting grammar expressions on every token, and it does not prevent later code generation to JavaScript.

Performance comes from three choices, not from self-hosting by itself:

- **Lex once.** A token array removes regex and trivia work from the parser hot loop.
- **Static dispatch.** First sets let a choice skip alternatives that cannot start at the current token; most backtracking disappears.
- **Reuse.** Token-indexed nodes and top-level item spans make incremental reparse possible.

An interpreted grammar over a token array should be substantially faster than parserator. If it is not, the fallback is to emit a specialized recursive-descent function per rule. That decision is settled by the benchmark in `docs/07-comparison.md` and `tools/bench.ts`, not by taste.

## What survives, rewritten

| Old | New |
| --- | --- |
| `Check` generator monad | `Checker` context, plain functions, scoped bindings, `AbortCheck` |
| `parserator` | grammar compiler + token parser + recovery + incremental reparse |
| `ir` + `javascript` | language-owned IR; `runtime` seam; interpreted-module helper |
| `types/higher-rank` | optional `types` kit; domain checkers in examples |
| `Piece[]` / `project` | mapped `ts` template + `TsDoc` |
| `analysis.ts` token rules | grammar-derived lexer + fact refinement |
| `Analysis<T>` | `Analysis` with typed facts and tokens |
| `lsp.ts` + per-language LSP | generic LSP driven by `Language` |
| `host/content-mapper` | generic host package + `parlance.config.ts` |
| `modules.ts` | generic module graph over `Language.parse`/`imports` |
| `HostLanguage` | `Language<Ast, Ir>` with check, ts, runtime, targets |

## Non-negotiables for the redesign

- A guest file still imports into TypeScript through the real content mapper, with source-mapped declarations.
- A guest file still runs under Node without a build step.
- Errors still point at the guest span, including through imports.
- Highlighting and basic editor facts still work on syntactically invalid input.
- One definition per language. No parallel highlighter, no per-language host script.
- The core has no required type system, no required runtime, and no required target.

## Follow-up measurement: the parser bet

On 2026-10-23 the redesigned parser was compared with this checkout on the same
grammar and corpus (`docs/07-comparison.md`). A first token-array version was
still about 1.7× slower than parserator. The measured cause was per-token
`LexToken` and nested `Span` allocation, not the token array. After moving
tokens into parallel typed arrays, parlance parses about 2.1× faster at batch
sizes from 20k to 200k declarations (about 78–87 MB/s versus 36–41 MB/s).
Grammar-to-callable-parser compilation is about 4.5× faster (0.09 ms versus
0.41 ms), and incremental edits are 29–45% of a full parse, which the old
checkout does not have.

The survey was right about the token-array direction but wrong about where the
time went: allocation shape dominated. `tools/compare-langkit.mjs --gate` keeps
the head-to-head ratio at or below 0.75× on an idle machine. Issue #13 covers
the remaining prefix lexing.
