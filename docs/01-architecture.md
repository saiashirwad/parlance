# Architecture

## One value, six derived artifacts

```
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
- `analyze(calc, source, uri)` is the only entry point for editors and hosts.

## Stage 1: grammar

A grammar is a `.parl` file compiled by the library. It is lossless and token-based.

```parl
grammar Calc

skip /\s+/ | /\/\/[^\n]*/

word /[A-Za-z_][A-Za-z0-9_]*/
token Number /\d+/

root File

File = declarations:Decl* @file

Decl =
  | @let "let" name:Name "=" value:Expr
  | @show "show" value:Expr

Expr = precedence {
  left "+" | "-"
  left "*" | "/"
  prefix "-"
  atom
    | @number value:Text
    | @name value:Name
    | "(" value:Expr ")"
}
```

The compiler produces:

```ts
type CompiledGrammar<Ast> = {
  parse(source: string, options?: ParseOptions): ParseResult<Ast>;
  lex(source: string): TokenList;
  ast: AstSchema;          // used by codegen and editor features
  incremental: boolean;    // root is a repetition of items
  highlight: HighlightMap;
};
```

The grammar language is itself written in `.parl` and parsed by the compiled grammar (`tests/self-host.test.ts`). The bootstrap parser exists only to break the cycle; it is not part of the API.

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

A grammar that fails these checks never produces a parser. They are diagnostics with grammar spans, not exceptions.

### Recovery

The parser recovers automatically inside repetitions:

1. Parse an item. If it fails, report the expected set at the farthest token.
2. Skip tokens until a token in the item's first set or the repetition's follow set.
3. Continue the loop.

This keeps `Decl*` producing a partial file after a malformed declaration, and it is what makes editor facts survive typing. A language can override the sync set with `@sync(Token, ...)` on a repetition.

### Incremental parsing

When the root rule is a repetition (`File = items:Decl*`), the compiler exposes item spans. `reparse(previous, edit)`:

1. Relex the new text (lexing is linear and cheap; incremental lexing is a later optimization).
2. Find the old items intersecting the edit.
3. Reuse untouched items before the edit. Shift untouched items after the edit by the edit delta.
4. Parse only the token range covering the change, using the item rule.
5. Splice and return `{ tree, stats }`.

Reuse is sound because top-level items are independent: no indentation-sensitive state, no parser state crosses an item boundary. The compiler rejects incremental mode for grammars that do not satisfy this shape. `tests/incremental.test.ts` asserts tree equality against a full parse after random edits, and `tools/bench.ts` reports the reuse ratio and timing.

## Stage 2: checking

`check(ast, cx)` is an ordinary function. `cx` is mutable analysis state, not a monad.

```ts
type Checker = {
  readonly uri: string;
  readonly source: string;

  error(at: Span | Node, message: string, options?: DiagnosticOptions): void;
  warn(at: Span | Node, message: string, options?: DiagnosticOptions): void;

  scope<T>(body: () => T): T;
  bind(binding: Binding): void;
  declare(name: string, span: Span, kind: DefinitionKind, type?: unknown): Binding;
  resolve(name: string, span: Span): Binding | undefined;
  typed(span: Span, type: unknown): void;

  check<T>(at: Span | Node, body: () => T): T | undefined;  // abort+recover one unit
  abort(at: Span | Node, message: string): never;

  readonly facts: Facts;
};
```

- `declare` records a definition; `resolve` records a reference when it finds a binding. LSP gets both without extra calls.
- `scope` isolates bindings. `bind` adds to the current scope. Declarations are hoisted explicitly by the language (call `declare` during a pre-pass, bind during elaboration).
- `check` catches `AbortCheck`, records the diagnostic, and returns `undefined`. This gives declaration-level recovery without a monad. `abort` is for "cannot continue this unit", not for ordinary type errors; ordinary errors call `error` and return a placeholder.
- `facts` is the editor contract: diagnostics, definitions, references, typed spans, document symbols.

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
import { ts, id } from "parlance/ts";

const calcTypes = (module: CalcModule) => ts`
  ${module.declarations.map((decl) => ts`
    export declare const ${id(decl.name)}: ${show(decl.type)};
  `)}
  export default ${show(module.result)};
`;
```

`id(node)` emits `node.text` and maps the virtual range back to `node.span`. Plain interpolations are text with no mapping. Nested templates and arrays flatten. The builder tracks virtual offsets, so there is no manual arithmetic and no `verbatim` length assertion.

A `TsDoc` is `{ text, mappings }`, exactly what the content mapper needs.

### Runtime

`runtime(module)` returns an ES module source string. Two idioms:

**Emitted** — the language compiles its IR to JavaScript itself. Best for expression languages and performance.

**Interpreted** — the module embeds serialized IR and imports a runtime factory:

```ts
runtimeModule({
  data: module,
  from: new URL("./runtime.ts", import.meta.url).href,
  imports: ["createMachine"],
  exports: [["start", "createMachine(machine)"]],
});
```

The loader registers every guest extension, reads the file, analyzes it, and returns the emitted module. Guest imports work because the emitted module imports the guest specifier and the loader handles it recursively. If analysis produced errors, loading throws a `SyntaxError` with rendered guest positions.

### Targets

A target is a function from checked IR to an artifact:

```ts
type Artifact = { readonly text: string; readonly fileName?: string; readonly mappings?: readonly Mapping[] };
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

`openProject` resolves `options.config` relative to `configFileName`, imports it, and keeps a registry per `projectHandle`. `transform` runs `analyze` + `typescript`, maps diagnostics to guest offsets, and returns `{ text, extension: ".ts", mappings, diagnostics }`. `openProject` watches guest files so unsaved edits invalidate the transform.

### Node loader

`registerLanguages([calc, machine])` reads the extension registry, analyzes, checks diagnostics, and returns the runtime module. Diagnostics are rendered with line/column and context. Analysis caches by URL + mtime so repeated imports do not reparse.

### LSP

`serve(language)` implements:

- incremental text sync
- semantic tokens (lexer tokens refined by facts)
- diagnostics, including related locations
- hover (`showType` or a language `describe`)
- definition and references (from facts)
- document symbols (from definitions)
- folding ranges (matching bracket tokens and top-level item spans)
- completion (keywords + visible definitions)
- rename (single file; workspace edits for known dependencies later)

Features are derived. A language that wants a custom hover adds `describe(binding)`. It does not write a server.

## Package layout

```
src/
  source.ts        Source, Span, Text, edits
  diagnostic.ts    Diagnostic, render, routing
  language.ts      Language, defineLanguage, analyze
  grammar/
    model.ts       grammar AST, compiled grammar
    parse.ts       bootstrap parser for .parl
    compile.ts     lexer/parser compiler, static checks
    types.ts       AST type generation
    self.parl      the grammar language in itself
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
    module.ts      interpreted-module helper
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
