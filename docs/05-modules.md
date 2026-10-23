# Modules and imports

A language declares import syntax. A project owns one `ModuleGraph`. The graph resolves
specifiers, detects cycles, analyzes dependencies before dependents, and exposes exports to the
checker and the editor.

## Language surface

```ts
type Import = { readonly specifier: string; readonly span: Span };

type Language<Ast, Ir, Type> = {
  // ...
  imports?: (file: Ast) => readonly Import[];
  exports?: (module: Ir) => readonly Binding<Type>[];
};

/** Turns a quoted guest string into an import. The span excludes the quotes. */
const importSpecifier = (literal: { readonly text: string; readonly span: Span }): Import;
```

`specifier` is the text between the quotes. `span` is the offset range that diagnostics and
navigation use. An importer resolves the specifier relative to its own document URI.

The example grammars put an import in the root item repetition so incremental parsing still sees
one item rule:

```parl
# schema.parl
schema Catalog
import "./blog.schema";

# calc.parl
use "./lib.calc";

# machine.parl
machine Order {
  import "./base.machine";
  event pay
  // ...
}
```

Schema and calc add `Import` as a `Decl` alternative; machine adds it as an `Event` alternative.
The checkers skip those nodes. Because the root rule is still `Decl*`, the incremental parser keeps
working for the existing single-file examples.

## Graph

```ts
type ModuleGraphOptions = {
  languages: readonly AnyLanguage[];
  read?: (uri: string) => string | null;
  resolve?: (specifier: string, from: string) => string | null;
};

class ModuleGraph {
  constructor(options: ModuleGraphOptions);

  /** Analyze an entry and every reachable dependency. Returns the entry's routed view. */
  analyze(uri: string, options?: {
    source?: string;
    parsed?: ParseResult<unknown>;
    incremental?: IncrementalStats | null;
  }): Analysis;

  node(uri: string): ModuleNode | undefined;
  source(uri: string): string | undefined;

  /** Every analyzed document, dependencies first. */
  order(): readonly string[];

  /** Every analyzed document, sorted. */
  watched(): readonly string[];
}
```

`read` defaults to the filesystem. `resolve` defaults to `new URL(specifier, from)`, so file URIs,
`memory://dir/a.schema`, and absolute paths all work. Paths passed to `analyze` are normalized to
absolute file URLs before use.

`Node` is `{ uri, language, source, analysis, exports, imports }`. Exported bindings carry the URI
of the document that defined them. A dependency's checked IR is available to a language as
`dependency.module`; schema uses it to merge imported models into one SQL artifact.

### Order and caching

The graph is a depth-first post-order walk. A node is recorded after its dependencies, so
`order()` lists `lib.calc` before `imports.calc`. Analysis is cached by URI and source text. When an
entry's source changes, the graph drops that node and every document that transitively imports it.

### Cycles

A DFS stack detects cycles. The first import that closes a cycle produces one diagnostic:

```
Import cycle: a.schema -> b.schema -> a.schema
```

The diagnostic is reported at the specifier of the import that closes the cycle in the file being
visited. That file is analyzed with the cyclic edge omitted, so names from the unresolved edge stay
unknown. The entry's routed view then shows the cycle diagnostic at its own import site. No
recursion continues and the walk terminates.

## Checker view

```ts
type Dependency<Type> = {
  readonly specifier: string;
  readonly uri: string;
  readonly exports: ReadonlyMap<string, Binding<Type>>;
  readonly module: unknown;
};

type Dependencies<Type> = {
  readonly all: readonly Dependency<Type>[];
  readonly of: (specifier: string) => Dependency<Type> | undefined;
};

class Checker<Type> {
  readonly dependencies: Dependencies<Type>;

  /**
   * Binds a name from the first dependency that exports it. The alias keeps the defining
   * document's URI and span but gets a fresh local id, so references stay unambiguous.
   * Records a reference when `at` is supplied.
   */
  imported(name: string, at?: Span | Spanned): Binding<Type> | undefined;
}
```

`analyze` and `analyzeParsed` take an optional `AnalysisContext` with `dependencies` and extra
`diagnostics`. The graph passes unresolved-import and cycle diagnostics through this context, so
they appear in the same `Analysis` and editor facts as checker diagnostics.

## Diagnostic routing

A dependency error keeps its own `origin` and `location` from `withDocument`. The importer routes it
to the import specifier with `route`. The resulting diagnostic has:

- `span` and `location.span` at the specifier in the importer;
- `origin` at the error in the dependency;
- a `related` entry that points back to the dependency.

Warnings are routed too. Info diagnostics stay local.

## Hosts

- **CLI.** `parlance check` and `parlance emit` construct one `ModuleGraph` per invocation and
  analyze the entry through it, so `./parlance check examples/schema/catalog.schema` also analyzes
  `blog.schema`.
- **Node loader.** `registerLanguages` installs one graph. Emitted calc modules contain real
  `import { base as _v0 } from "./lib.calc"` statements, so Node asks the loader for the dependency
  and the graph returns the cached analysis.
- **Content mapper.** Each open project owns a graph. `transform` uses the graph, and the existing
  recursive guest scan lists imported files in `watchedFiles`. Schema's TypeScript surface includes
  imported declarations; names from another file are emitted without source mappings, because a
  mapping must stay inside the transformed document.
- **LSP.** One graph serves every language. Cross-file definition reads a use in file A, finds the
  imported alias with `uri` B, and converts the declaration span against B's open text or the graph
  cache.

## Two-file example

```
examples/schema/blog.schema       models User and Post
examples/schema/catalog.schema    imports "./blog.schema"; adds Catalog with owner: User
examples/calc/lib.calc            let base = 85 + 40;
examples/calc/imports.calc        use "./lib.calc"; let total = base * 2;
```

`catalog.schema` emits one SQL artifact containing `Catalog`, `User`, and `Post`. `imports.calc`
imports `base` and `limit` at runtime.

## Not done

- No re-export syntax and no named import lists: an import exposes every export of the dependency.
- No package or bare-specifier resolution. Only URL-relative specifiers resolve.
- Calc copies binding types from the dependency's `TypeStore`. Primitive and literal types are
  correct; free type variables from another store are printed as unbound variables.
- Machine recognizes and analyzes imports but its checker does not merge imported events or
  states. Schema and calc are the resolved cross-file cases.
- Cross-file references and rename are single-file. Only definition crosses documents.
- A changed dependency invalidates dependents lazily. Open documents in the LSP refresh on their
  next edit, not immediately when another open file changes.
