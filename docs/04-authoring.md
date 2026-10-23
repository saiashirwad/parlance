# Author a language

This guide adds a language end to end, using `calc` as the worked example. You write a grammar, generate AST types, write a checker, project a TypeScript surface, emit a runtime, add targets, register the language, and test each layer. The result is one `defineLanguage` value that the CLI, the Node loader, the content mapper, and the LSP all read.

The language itself is three files: `examples/calc/calc.parl`, `examples/calc/calc.ast.ts` (generated), and `examples/calc/calc.ts`.

## Step 1: Write the grammar

Start with the syntax that carries the structure you need. `examples/calc/calc.parl` is one page:

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
  | @let "let" ~ name:Name "=" ~ value:Expr ";"
  | @show "show" ~ value:Expr ";"
};

rule Expr = precedence {
  left "==" | "!="
  left "+" | "-"
  left "*" | "/"
  prefix "-" | "!"
  atom
    | @number value:$Number
    | @boolean value:BooleanLit
    | @name value:Name
    | "(" value:Expr ")"
};

rule BooleanLit = {
  | value:"true"
  | value:"false"
};

rule Name = {
  word
};
```

The declarations set the lexer:

- `skip` consumes trivia between tokens. Comments and whitespace are the usual two.
- `word` is the identifier shape. A string literal shaped like a word, such as `"let"`, is a contextual keyword: it matches a whole word token with that text.
- `token Number /regex/` adds a named terminal. The token's pattern wins over a word or a symbol at the same position.
- Every other string literal, such as `"+"`, is a symbol. Symbols match longest first.
- `root File` names the start rule. It defaults to the first rule.

A rule body is a list of alternatives, optionally wrapped in braces, or a `precedence` block. Inside a braced body:

- `@tag` makes a node with `kind: "tag"`.
- `label:Expr` becomes a field of that node.
- `_` discards a value. Unlabeled values are parsed and dropped.
- `~` commits to the current alternative after the preceding token.
- `a*`, `a+`, `a?`, `sep(a, ",")`, `sep1(a, ",")`, `sepEnd(a, ",")`, and `sepEnd1(a, ",")` repeat and separate.
- `&a` and `!a` are lookahead predicates.

A `precedence` block lists levels from low to high. `left`, `right`, `none`, `prefix`, and `postfix` set associativity. Each level's operators are expressions, so a literal operator keeps its source span. The parser produces `{ kind: "binary", operator, left, right, span }`, `{ kind: "prefix", operator, operand, span }`, or `{ kind: "postfix", operator, operand, span }`.

The compiler rejects a grammar with grammar spans for these conditions:

- left recursion, direct or indirect
- a repetition or separated list that can match nothing
- an unused rule or token
- duplicate rule or token names
- duplicate field labels in one tagged alternative
- unknown rules, tokens, or root
- a pattern that can match the empty string

A rule named `word` is also rejected, because `word` is a built-in expression.

Recovery depends on the root. Only the root's item repetition recovers. In calc, `@file declarations:Decl*` is that repetition. On a failed item the parser reports the expected set at the farthest token, skips to the next token in the item's sync set at delimiter depth zero, forces progress, and continues. The malformed declaration is omitted from the tree. Nested failures propagate to the root repetition, so one bad declaration produces one diagnostic rather than a cascade.

To check the grammar and preview the AST types without writing a file:

```sh
node src/grammar/cli.ts types examples/calc/calc.parl
```

## Step 2: Generate typed ASTs

Generate the TypeScript module for the values that your parser returns:

```sh
node src/grammar/cli.ts gen examples/calc/calc.parl examples/calc/calc.ast.ts
```

The generated module starts with the helper types and one interface per tagged alternative:

```ts
export type Span = { readonly start: number; readonly end: number };

export type Text = { readonly text: string; readonly span: Span };

export interface FileFileNode {
  readonly kind: "file";
  readonly declarations: readonly Decl[];
  readonly span: Span;
}

export type File = FileFileNode;

export interface DeclLetNode {
  readonly kind: "let";
  readonly name: Name;
  readonly value: Expr;
  readonly span: Span;
}
```

The naming rules are mechanical:

- A tagged alternative becomes `<Rule><Tag>Node`, so `@let` in `Decl` becomes `DeclLetNode`.
- A rule becomes a union of its alternatives, or an alias when it has one shape. `Decl` is the union of `DeclLetNode` and `DeclShowNode`.
- A precedence rule also gets `<Rule>BinaryNode`, `<Rule>PrefixNode`, and `<Rule>PostfixNode`.
- A rule named `Text` or `Span` becomes `TextRule` or `SpanRule` with a warning, because those names are taken by the helpers. A rule that is a TypeScript reserved word gets the same suffix.

Rerun `gen` after every grammar change and check in the result. `tests/grammar-types.test.ts` asserts that `examples/calc/calc.ast.ts` is current.

## Step 3: Write the checker

The language's `check` field receives the parsed AST and a `Checker` from `parlance/check`:

```ts
readonly check: (file: Ast, cx: Checker<Type>) => Ir;
```

The function returns checked IR. It reports errors through `cx`; it does not throw for guest errors. `examples/calc/calc.ts` walks expressions and resolves names:

```ts
case "name": {
  const binding = cx.resolve(expr.value.text, expr.value.span);
  if (!binding) {
    cx.error(`Unknown name ${JSON.stringify(expr.value.text)}`, expr.value);
    return { ir: { kind: "number", value: 0 }, type: store.unknown() };
  }
  const type = binding.type ?? store.unknown();
  cx.typed(expr, type);
  return { ir: { kind: "name", binding }, type };
}
```

The `Checker` methods you will use:

- `declare(name, span, kind, type?, extra?)` records a definition. It does not put the name in scope.
- `bind(binding)` adds a binding to the current scope. `bindAll` adds several.
- `resolve(name, span)` searches from the innermost scope outward. It records a reference when it finds a binding.
- `reference(binding, span)` records a reference without a lookup. Use it when you already have the binding, as the machine checker does for transitions.
- `scope(body)` runs `body` in a child scope and restores the parent scope even when `body` throws.
- `typed(span, type)` attaches a type to a span for hover and semantic tokens.
- `error(message, span, options?)`, `warn(...)`, and `info(...)` append a diagnostic. The span may be a `Span` or any node with a `span` field.
- `abort(message, span, options?)` records an error and throws. `check(body)` and `check(span, body)` catch that throw and return `undefined`.

Hoist before you elaborate. Declare and bind every top-level name in a first pass, then resolve references in a second pass. `examples/schema/schema.ts` does this in `claim`, which is called once per enum, model, and query before fields or query stages are checked:

```ts
const binding = cx.declare(
  name.text,
  name.span,
  kind === "enum" ? "enum" : kind === "model" ? "class" : "function",
  type,
  { detail: kind },
);
cx.bind(binding);
```

Recovery is per unit. `analyze` already wraps the whole `check` call in `cx.check`, so an uncaught `abort` becomes one diagnostic and a null IR. For declaration-level recovery, wrap each declaration yourself:

```ts
for (const declaration of file.declarations) {
  cx.check(() => checkDeclaration(declaration, cx));
}
```

`cx.scope` is not recovery. Use it for parameters and locals. `examples/schema/schema.ts` opens a scope around each query so parameters and fields do not leak into the next query.

Facts are the editor contract. After `check`, `analyze` exposes `diagnostics`, `definitions`, `references`, `types`, and `tokens`. The LSP reads composed facts, not your AST. Optional fields improve hover and completion:

- `show(type)` renders a checked type.
- `describe(binding)` renders a definition, with `show` as the fallback.
- `completions` adds words the grammar lexes as `Name`, such as `@primary` attributes or scalar types. Items may set `insertText` when the displayed label should not be inserted verbatim.

The type kit is optional. `parlance/types` exports `TypeStore`, a mutable store with `mark` and `restore`, and `printType`. Calc uses it to infer `number` and `boolean`. Schema and machine use their own domain types.

Set `checkPartial: false` only when your checker cannot tolerate a tree with parse errors. The default is `true`, so editor facts survive while the user types.

## Step 4: Project to TypeScript

`typescript` returns a `TsDoc`, which is `{ text, mappings }`. Build it with the `ts` tagged template from `parlance/ts`. These excerpts leave out local helpers such as `show` in `calc.ts` and `fieldTs` in `schema.ts`. Calc emits one declaration per `let`:

```ts
import { source, ts } from "parlance/ts";

const types = (module: CalcModule) =>
  ts`${
    module.declarations.flatMap((declaration) =>
      declaration.kind === "let"
        ? [ts`export declare const ${source(declaration.name)}: ${show(declaration.binding.type ?? null)};
`]
        : []
    )
  }${
    module.resultType
      ? ts`declare const _default: ${show(module.resultType)};
export default _default;
`
      : ""
  }`;
```

Schema uses the same template for interfaces and query methods:

```ts
module.models.map((model) =>
  ts`export interface ${source(model.name)} {
${
    model.fields.map((field) => ts`  readonly ${source(field.name)}: ${fieldTs(field)};
`)
  }}
`
)
```

Two interpolations carry mappings:

- `source(node)` emits the node's own text with a verbatim mapping. The text must have the same UTF-16 length as `node.span`. `source` throws `RangeError` when it does not.
- `synth(text, span, features?)` emits different text mapped to a guest span. Use it for a renamed or escaped identifier, a generated type name, or any text whose length differs from the span. Machine builds its union names this way:

```ts
export type ${synth(`${prefix}State`, module.name.span)} = ${
  module.states.map((state, index) => ts`${index ? " | " : ""}"${source(state.name)}"`)
};
```

A plain string interpolation is unmapped text. Nested templates and arrays flatten in order, and the builder shifts every nested mapping by its virtual offset. You supply spans; you never add lengths.

The escaped-identifier rule follows from the length check. If a guest name is a TypeScript reserved word, or you need to escape it, the emitted text is not the guest text. Emit the escaped text with `synth` and keep the original span, so hover and go-to-definition still land on the guest identifier. Calc and schema take the other valid route: they reject reserved names with a diagnostic and keep every emitted identifier verbatim. Do not emit an escaped name with `source`.

`parlance/ts` also exports `typeText`, which prints a `TsType` deterministically. `parlance/types` exports `TypeStore.show`, which prints a checked guest type. Use one of them in `show` so hover text and the TypeScript surface agree.

## Step 5: Emit a runtime

`runtime` returns an ES module source string. There are two idioms.

Emitted: compile your checked IR to JavaScript. Calc prints expressions and exports the `let` names:

```ts
case "binary":
  return `(${expr(value.left)} ${value.operator === "==" ? "===" : value.operator === "!=" ? "!==" : value.operator} ${
    expr(value.right)
  })`;
```

Interpreted: embed the IR as JSON and import a runtime factory. `runtimeModule` from `parlance/runtime` builds the module. Machine uses it:

```ts
const runtime = (module: MachineModule): string =>
  runtimeModule({
    data: {
      name: module.name.text,
      initial: module.initial.name.text,
      events: module.events.map((event) => ({
        name: event.name.text,
        fields: event.fields.map((field) => ({ name: field.name.text, type: field.type })),
      })),
      transitions: module.states.flatMap((state) =>
        state.transitions.map((transition) => ({
          state: state.name.text,
          event: transition.event.name.text,
          target: transition.target.name.text,
        }))
      ),
    },
    from: new URL("./runtime.ts", import.meta.url).href,
    imports: ["create"],
    factory: "create(data)",
    exports: { start: "runtime.start" },
  });
```

`data` must be JSON-serializable: no functions, symbols, `bigint`, `undefined`, or cycles. `from` is the import specifier for the factory. `exports` maps export names to expressions evaluated with `runtime` in scope; the name `default` becomes the default export.

Install the loader once per process, before importing guest files:

```ts
import { registerLanguages } from "parlance/ts/loader";
import { advanced } from "./advanced/advanced.ts";
import { calc } from "./calc/calc.ts";
import { machine } from "./machine/machine.ts";
import { schema } from "./schema/schema.ts";

registerLanguages([advanced, calc, machine, schema]);
```

The loader reads a guest file from disk, analyzes it, and returns `language.runtime(ir)` as a module. It throws a `SyntaxError` with rendered guest positions when analysis reports any diagnostic, including a warning, or when the language has no `runtime`. A language without a runtime can still use the CLI and the content mapper.

Run a guest file without a build step:

```sh
node --import ./examples/register.ts examples/typescript/calc.ts
```

## Step 6: Add targets

A target is a function from checked IR to an `Artifact`:

```ts
export type Artifact = {
  readonly text: string;
  readonly fileName?: string;
};
```

`fileName` is metadata for hosts. `parlance emit` writes the text to stdout unless you pass `--out`, and then it writes to that path. The core never imports SQL, Drizzle, or Kysely. Schema defines three targets next to its language value:

```ts
targets: {
  sql: (module) => ({ text: sql(module), fileName: "schema.sql" }),
  drizzle: (module) => ({ text: drizzle(module), fileName: "schema.drizzle.ts" }),
  kysely: (module) => ({ text: kysely(module), fileName: "schema.kysely.ts" }),
},
```

Emit one:

```sh
./parlance emit --target sql examples/schema/blog.schema
```

Targets see checked IR, not source text. If a target needs a guest span, carry it in the IR.

## Step 7: Register and drive

Add the language to `parlance.config.ts` at the project root:

```ts
import { advanced } from "./examples/advanced/advanced.ts";
import { calc } from "./examples/calc/calc.ts";
import { machine } from "./examples/machine/machine.ts";
import { schema } from "./examples/schema/schema.ts";

export default { languages: [advanced, calc, machine, schema] };
```

The config may default-export a `Language[]` or `{ languages }`. The CLI looks for `parlance.config.ts`, `.mts`, `.js`, or `.mjs` in the current directory, or takes `--config <path>`.

A language can also resolve imports. Add `imports(file)` and `exports(module)` to the language value; the project's `ModuleGraph` resolves specifiers, analyzes dependencies first, and exposes exported bindings through `cx.imported` and `cx.dependencies`. The CLI, Node loader, content mapper, and LSP already read the graph, so no host code changes. [`docs/05-modules.md`](../docs/05-modules.md) is the design record.

The commands:

```sh
./parlance check examples/calc/demo.calc
./parlance emit --target sql examples/schema/blog.schema
./parlance lsp --config ./parlance.config.ts
```

`check` prints `ok <file>` on success and renders each diagnostic with a line, column, source line, and caret. `emit` prints the artifact. `lsp` serves every language in the config over stdio.

For the TypeScript import path, add the content mapper to `tsconfig.json`:

```json
{
  "contentMappers": [{
    "package": "@parlance/ts-host",
    "extensions": [".calc", ".machine", ".schema"],
    "options": { "config": "./parlance.config.ts" }
  }]
}
```

TypeScript 7.1 beta runs the mapper process. The mapper loads `options.config`, analyzes the requested guest file with the content in the request, and returns `{ text, extension: ".ts", mappings, diagnostics }`. That is how this works:

```sh
node --import ./examples/register.ts examples/typescript/calc.ts
```

and how `tsgo` hovers and navigates from a `.ts` file into a `.calc`, `.schema`, or `.machine` file.

## Step 8: Test the language

Test each layer on its real path. These are the files to copy from.

Grammar and AST:

- `tests/grammar.test.ts` parses `src/grammar/grammar.parl` with the bootstrap parser, compiles it, parses the same file with the compiled parser, and compares the ASTs. Do the same for your grammar to prove self-hosting.
- `tests/grammar.test.ts` also asserts that recovery keeps declarations after a malformed one.
- `tests/grammar-types.test.ts` checks that generated interfaces cover every field and kind in a parsed AST and that the checked-in `calc.ast.ts` is current.

Checker diagnostics:

- `tests/calc.test.ts` asserts the diagnostic message and that its span slices the offending guest text: `assert.equal(source.slice(span.start, span.end), "true")`.
- `tests/machine.test.ts` checks legality errors at the transition or declaration.
- `tests/schema.test.ts` checks duplicate fields, unknown types, missing primary keys, and query result mismatches.

Projections and targets:

- `tests/ts-template.test.ts` uses exact text snapshots and checks mapping coordinates, including nested templates and UTF-16 lengths.
- `tests/schema.test.ts` asserts the TypeScript text and all three target outputs from one module.
- `tests/tsgo.test.ts` drives the real compiler through the content mapper and asserts hover and definition into a guest file.

Runtime:

- `tests/calc.test.ts` runs the emitted module through the Node loader and checks stdout. It also asserts that a guest type error becomes a loader `SyntaxError` with a position.
- `tests/machine.test.ts` starts a machine, sends a discriminated event with a payload, and asserts that a missing payload or an illegal transition throws.
- `tests/schema.test.ts` seeds and queries SQLite through the loader.

LSP:

- `tests/lsp.test.ts` starts the server, opens a document, and checks diagnostics, semantic tokens, hover, definition, references, symbols, completion, and rename.
- `tools/lsp-smoke.ts` drives the real `parlance lsp` process over stdio through open, break, fix, hover, and definition. `pnpm check` runs it.

Incremental parsing:

- Incremental mode needs a root that is one alternative whose sequence contains a repetition of one item rule. The last repetition becomes the item window. With a tag, the repetition must have a field label. Without a tag, it must be the sequence's only captured value. Calc's `@file declarations:Decl*` meets this.
- `tests/incremental.test.ts` runs targeted edits and a randomized oracle: 80 seeds times 30 edits, each compared with a full parse. Use the same oracle for your grammar. `reparse` falls back to a full parse when the root does not qualify or when invariants fail, and records `stats.fallback`.

Run the suite:

```sh
pnpm test
pnpm check
```

`pnpm test` runs `node --test tests/*.test.ts`. `pnpm check` runs the typecheck, the tests, all four example languages through the CLI and the loader, the LSP smoke test, and `tsgo` navigation. A new language is ready when its grammar, checker, projection, runtime, targets, and LSP behavior each have a test on the path a user takes.
