# Architecture

## One value, six derived artifacts

```text
                    ┌──────────────┐
 source text ──────►│   grammar    │──► tokens ───────────────► highlighting
                    │  (lossless)  │──► CST/AST ──────────────► selection, folding, symbols
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────┐
                    │   checker    │──► diagnostics
                    │  (plain fn)  │──► facts (defs, refs, types) ─► LSP
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────┐
                    │  checked IR  │
                    └──┬────┬───┬──┘
                       │    │   │
            TypeScript │    │   │ JavaScript module
             surface   │    │   └──────────────► Node loader
                       │    └──────────────────► targets (SQL, Drizzle, ...)
                       └───────────────────────► content mapper
```

A language is a single value:

```ts
export const calc = defineLanguage({
  name: "calc",
  extensions: [".calc"],
  grammar: calcGrammar,
  check: (file, cx) => checkCalc(file, cx),
  typescript: (module) => calcTypes(module),
  runtime: (module) => calcModule(module),
  targets: {
    json: (module) => ({ text: JSON.stringify(module) }),
  },
});
```

Everything the project needs is read from that value:

- `parlance lsp --config ./parlance.config.ts` serves every language.
- `@parlance/ts-host` is one content mapper package for every project; the project supplies `options.config`.
- `registerLanguages([calc])` installs Node loader hooks for every extension.
- `analyze(calc, source, uri)` is the entry point for editors and hosts. `analyzeParsed` takes a parse you already have, such as the LSP's incremental reparse.

## Stage 1: grammar

A grammar is a `.parl` file compiled by the library. It is lossless and token-based.

```parl
grammar Calc

skip /\s+/
skip /\/\/[^\n]*/

word /[A-Za-z_][A-Za-z0-9_]*/
token Number /\d+(?:\.\d+)?/

root File

rule File = {
  @file declarations:Decl*
};

rule Decl = {
  | @let "let" ~ name:Name "=" value:Expr ";"
  | @show "show" value:Expr ";"
};

rule Expr = precedence {
  left "+" | "-"
  left "*" | "/"
  prefix "-"
  atom
    | @number value:$Number
    | @name value:Name
    | "(" value:Expr ")"
};

rule Name = { word };
```

The compiler produces:

```ts
type CompiledGrammar<Ast> = {
  readonly name: string;
  readonly valid: boolean;
  readonly diagnostics: readonly Diagnostic[];
  parse(source: string, options?: ParseOptions): ParseResult<Ast>;
  lex(source: string): TokenList;
  highlight(source: string): readonly Token[];
  highlightTokens(tokens: readonly LexToken[], trivia: readonly Trivia[]): readonly Token[];
  readonly spec: GrammarSpec;  // parser tables and the incremental item window
};
```

The grammar language is itself written in `.parl` and parsed by the compiled grammar (`tests/grammar.test.ts`). The bootstrap parser exists only to break the cycle; it is not part of the API.

### Terminals

- `skip` patterns run between tokens. They are not part of nodes but are retained in `TokenList.trivia`.
- `word` is the identifier pattern. Identifier-shaped string literals (`"let"`) are keywords and only match a whole word.
- `token Name /regex/` adds a named terminal. A token match wins over symbols, identifiers, and keywords in a maximal-munch pass.
- Any other string literal (`"+"`, `"->"`) is a symbol, matched longest-first.
- The union of these rules is the only lexer. Highlighting cannot drift.

### Expressions

| Syntax | Value | Notes |
| --- | --- | --- |
| `"text"` | nothing | a terminal |
| `/regex/` | `Text` | matched source text + span |
| `$Token` | `Text` | named token |
| `ident` | `Text` | default word |
| `Rule` | rule value | rule reference |
| `a b c` | single child value, array if several, `null` if none | untagged sequence |
| `@tag a:Rule b:"x"` | `{ kind: "tag", a, b, span }` | tagged sequence |
| `e*`, `e+`, `e?` | `e[]`, non-empty `e[]`, `e \| null` | repetition |
| `sep(e, ",")`, `sep1` | `e[]` | separated lists |
| `sepEnd(e, ",")`, `sepEnd1` | `e[]` | trailing separator allowed |
| `&e`, `!e` | nothing | lookahead predicates |
| `~` | nothing | commit to the current alternative |
| `precedence { ... }` | tagged binary/prefix/postfix nodes | Pratt parser |

Every `Text` and every tagged node carries a `span` in UTF-16 offsets.

### Static checks

Before a grammar is usable, the compiler reports:

- unreachable rules (not reachable from the root)
- unused tokens and skip rules
- left recursion (direct and indirect)
- nullable loops (a repetition whose body can match nothing)
- duplicate tags in one rule
- duplicate field labels
- alternatives that cannot be distinguished by their first token set
- unknown rule/token references

Ordered choice is legal, including alternatives with overlapping first sets; the compiler warns only when an earlier alternative is nullable, which would make later ones unreachable. Keywords are contextual: the lexer emits words, and a literal matches by text, so `state` can be a field name in one place and a keyword in another. Tags are scoped to the rule that declares them, so two rules can both use `@token` with different fields.

A grammar that fails these checks never produces a parser. They are diagnostics with grammar spans, not exceptions.

### Recovery

The parser recovers automatically at the root item repetition:

1. Parse an item. If it fails, report the expected set at the farthest token.
2. Skip from the item start until a token in the item's sync set (first sets of its alternatives), tracking delimiter depth so a token inside `{...}` cannot end the item.
3. Force progress, then continue. The malformed item is absent from the tree; the next declaration is not.

Only the root's declaration repetition recovers. Nested failures propagate to it, so one malformed declaration yields one diagnostic instead of a cascade. A cut inside the item does not suppress statement recovery: the item is abandoned, not the file. This is what keeps editor facts alive while typing.

### Incremental parsing

When the root rule is a repetition of one item rule (`@file items:Decl*`), the compiler exposes item spans and enables incremental mode. `reparse(previous, previousSource, source, edit)`:

1. Relex the new text in full. Lexing is linear; incremental lexing is a later optimization.
2. Select the items intersecting the edit plus one untouched item on each side. The margin absorbs token merges at boundaries and bounded lookahead.
3. Reuse items before the window. Deep-clone and shift items after the window by the edit delta; never mutate the previous tree.
4. Parse only the new token range covering the window, using the same item loop and recovery as a full parse.
5. Splice, then verify structural invariants. If invariants fail, or a reused item's text no longer matches, fall back to a full parse and say so in the stats.

Soundness rests on four conditions the compiler enforces: the root has one item repetition, the item is productive, no parser state crosses an item boundary, and recovery is item-local. Lookahead beyond one item is the remaining gap; the window margin covers bounded lookahead, and the tests include predicates at boundaries. Full-parse equality is the oracle for every randomized edit. The implementation is in `src/parser/incremental.ts`; `docs/03-incremental.md` will record the limits and measurements.

## Stage 2: checking

`check(ast, cx)` is an ordinary function. `cx` is mutable analysis state, not a monad.

```ts
type Checker = {
  readonly uri: string;
  readonly source: string;

  error(message: string, at: Span | Node, options?: CheckOptions): void;
  warn(message: string, at: Span | Node, options?: CheckOptions): void;

  scope<T>(body: () => T): T;
  bind(binding: Binding): void;
  declare(name: string, span: Span, kind: DefinitionKind, type?: unknown): Binding;
  resolve(name: string, span: Span): Binding | undefined;
  alias(binding: Binding, uri: string, span?: Span): Binding;
  imported(name: string, span?: Span): Binding | undefined;
  readonly dependencies: Dependencies<T>;
  typed(span: Span, type: unknown): void;

  check<T>(at: Span | Node, body: () => T): T | undefined;  // abort+recover one unit
  abort(message: string, at: Span | Node, options?: CheckOptions): never;

  readonly facts: Facts;
};
```

- `declare` records a definition; `resolve` records a reference when it finds a binding. LSP gets both without extra calls.
- `alias` registers a binding from another document as a local definition with a fresh id, keeping the defining `uri`; `imported` is shorthand for an exported name from the first dependency that provides it. `dependencies` is the read-only view the module graph supplies. See [`05-modules.md`](05-modules.md).
- `scope` isolates bindings. `bind` adds to the current scope. Declarations are hoisted explicitly by the language (call `declare` during a pre-pass, bind during elaboration).
- `abort` records the diagnostic and throws `AbortCheck`; `check` catches it and returns `undefined`. This gives declaration-level recovery without a monad. `abort` is for "cannot continue this unit", not for ordinary type errors; ordinary errors call `error` and return a placeholder.
- `facts` is the editor contract: diagnostics, definitions, references, typed spans, tokens.

Bindings are opaque and language-defined:

```ts
type Binding<T = unknown> = {
  readonly id: number;
  readonly name: string;
  readonly kind: DefinitionKind;
  readonly span: Span;
  readonly type?: T;
  readonly uri?: string;
};
```

The core does not know what `T` is. `Language` fixes it. `showType` renders it for hover.

### Imports

A language declares `imports(file)` and `exports(module)`. One `ModuleGraph` per project resolves
specifiers relative to the importer, detects cycles, analyzes dependencies first, and hands the
checker a read-only `dependencies` view. `cx.imported(name, at)` binds a dependency binding under a
local id while keeping its defining URI and span, so definition can cross files. Details:
`docs/05-modules.md`.

### Type checking kit

`parlance/types` is optional. It provides:

- a structural `Type` union (unknown, primitive, literal, array, record, union, function, ref, variable)
- a mutable `TypeStore` with `fresh`, `bind`, `unify`, `snapshot`, `rollback`
- `printType(type): TsType`

A language can use it, ignore it, or bring its own. Schema and machine do not use HM; calc uses the store to infer `number`/`boolean`. The core never imports it.

## Stage 3: projections

### TypeScript surface

`typescript(module)` returns a `TsDoc`, built with a mapped template:

```ts
import { source, synth, ts } from "parlance/ts";

const calcTypes = (module: CalcModule) => ts`
  ${module.declarations.map((decl) => ts`
    export declare const ${source(decl.name)}: ${show(decl.type)};
  `)}
  export default ${show(module.result)};
`;
```

`source(node)` emits the guest text with a **verbatim** mapping (kind 0, all features). `synth(text, span)` emits synthesized text with an **atom** mapping (kind 1, hover/definition/references only). A plain interpolation is unmapped text. Nested templates and arrays flatten. The builder tracks virtual offsets, so the author supplies spans but never sums lengths. Mapping edge cases that need language care: escaped or renamed identifiers should use `synth`; generated type text has no guest origin, so a compiler error inside it cannot navigate back; imports should be emitted with real specifiers so the content mapper sees dependency edges.

A `TsDoc` is `{ text, mappings }`, exactly what the content mapper needs.

### Runtime

`runtime(module)` returns an ES module source string. Two idioms:

**Emitted** — the language compiles its IR to JavaScript itself. Best for expression languages and performance.

**Interpreted** — the module embeds serialized IR and imports a runtime factory:

```ts
runtimeModule({
  data: module,
  from: new URL("./runtime.ts", import.meta.url).href,
  imports: ["create"],
  factory: "create(data)",
  exports: { start: "runtime.start" },
});
```

The loader registers every guest extension, reads the file, analyzes it, and returns the emitted module. If a runtime module imports another guest file, the loader handles it recursively. If analysis produced any diagnostic, loading throws a `SyntaxError` with rendered guest positions.

### Schema mutations and defaults

The schema example writes as well as reads:

```parl
insert User { email: $email, role: Admin }
update Post |> where id == $id |> set status = $status
delete Post |> where id == $id
```

`$name` is a bound parameter. A bare name is a literal for an enum or Bool field (`Admin`, `true`), which keeps parameters and enum members distinguishable without guessing from field names. `update` keeps the query pipeline and adds two stages: `where` filters, `set` assigns a comma-separated field list. The mutation's generated name is `insert<Model>`, `update<Model>`, or `delete<Model>`, so one mutation of each kind is legal per model.

The checker enforces that a model exists, every field exists, required fields appear exactly once, `@auto` primaries are omitted, and `@primary` fields are never updated. Bound parameters inherit the field type; reusing one name at two types is an error. Diagnostics point at the model name, field name, or value token that caused the error.

The TypeScript surface exposes writes next to reads:

```ts
insertUser(params: { email: string; role: Role; createdAt?: string }): number;
updatePost(params: { where: { id: number }; set: { status: PostStatus } }): number;
deletePost(params: { id: number }): number;
```

`insert` returns `lastInsertRowid`; `update` and `delete` return the number of changed rows. `update` nests `where` and `set` because the same field name may legitimately occur in both positions. Parameters bind by name; values are never interpolated into SQL.

`@default(...)` accepts a string or number literal, an enum member, a Bool literal, and `now` for `DateTime`. The DDL emits `DEFAULT`, the TypeScript insert type marks the field optional, and the SQL target omits the field from INSERT so SQLite applies the default. If a caller supplies an omitted defaulted or nullable field, the runtime composes a second named-parameter INSERT from schema metadata. Defaults are rejected on `@primary` and `@auto` fields, and a default whose kind does not match the field type is an error.

The Drizzle target emits `.default(...)` (and `sql\`CURRENT_TIMESTAMP\`` for `now`); the Kysely target marks defaulted columns as `Generated<T>`. Both remain schema targets: mutation call sites are the runtime methods above, not emitted query builders. Typechecking generated Drizzle/Kysely output is a separate issue.

### Targets

A target is a function from checked IR to an artifact:

```ts
type Artifact = { readonly text: string; readonly fileName?: string };
type Target<Ir> = (module: Ir) => Artifact;
```

`parlance emit --target sql --config ... file.schema` prints it. Targets are language-owned; the core only discovers and invokes them. This is how one schema language emits SQL, Drizzle, Kysely, or Effect SQL without the core knowing any of them.

## Stage 4: hosting

### Content mapper

One package, `@parlance/ts-host`, for every project:

```json
{
  "contentMappers": [{
    "package": "@parlance/ts-host",
    "extensions": [".calc", ".machine", ".schema"],
    "options": { "config": "./parlance.config.ts" }
  }]
}
```

`openProject` resolves `options.config` relative to `configFileName`, imports it, and keeps a registry per `projectHandle`. `transform` receives the current file content (including unsaved editor content), runs `analyze` + `typescript`, maps diagnostics to guest offsets, and returns `{ text, extension: ".ts", mappings, diagnostics }`. `openProject` returns an identity over the config and guest files on disk; TypeScript uses it to reopen the project when a dependency changes. The transform itself never reads the changed file from disk; it uses the content in the request.

### Node loader

`registerLanguages([calc, machine])` reads the extension registry, analyzes, checks diagnostics, and returns the runtime module. Diagnostics are rendered with line/column and context. The loader analyzes each load; it does not cache.

### LSP

`serve(languages)` implements:

- incremental text sync
- semantic tokens (lexer tokens refined by facts)
- diagnostics, including related locations
- hover (`describe(binding)` or `show(type)`)
- definition and references (from facts)
- document symbols (from definitions)
- folding ranges (matching bracket tokens)
- completion (grammar keywords + top-level definitions; local-scope completion awaits recorded scope ranges)
- rename (single file)

Features are derived. A language that wants a custom hover adds `describe(binding)`. It does not write a server. Definition crosses documents through the module graph (`docs/05-modules.md`). Ranges not yet promised: workspace symbols, incremental rename, formatting, and cross-file references.

## Package layout

```text
src/
  source.ts        Source, Span, Text, edits
  diagnostic.ts    Diagnostic, render, routing
  language.ts      Language, defineLanguage, analyze, analyzeParsed
  modules.ts       ModuleGraph, import resolution, cycle detection
  grammar/
    ast.ts         grammar AST
    parse.ts       bootstrap parser for .parl
    compile.ts     lexer/parser compiler, static checks
    types.ts       AST type generation
    grammar.parl   the grammar language in itself
  parser/
    lex.ts         token array, trivia
    parse.ts       token parser, recovery
    incremental.ts reparse + reuse
  check/
    checker.ts     Checker, scopes, facts
    facts.ts       definitions, references, types, symbols
  types/
    structural.ts  optional type store + unifier
  ts/
    template.ts    mapped ts`` builder
    type.ts        TS type printer
    host.ts        content mapper server
    loader.ts      Node loader
  lsp/
    server.ts      generic LSP
  runtime/
    index.ts       interpreted-module helper
```

Examples prove each layer:

- `examples/calc` — expression language, inferred types, emitted JS, TS surface.
- `examples/machine` — domain checker (states/events), interpreted runtime, discriminated-union TS surface.
- `examples/schema` — relational DSL, SQL target, interpreted SQLite runtime, TS surface.

## Deliberate non-goals for the first cut

- Code formatting.
- Multi-file rename and workspace symbols.
- Incremental type checking (incremental parsing is enough for editor latency).
- Source maps for runtime stack traces.
- Publishing. The repo is private until the API settles.

These are tracked as issues, not hand-waved.
