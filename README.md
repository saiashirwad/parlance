# parlance

Small languages that live inside TypeScript and Node.

A language is one value: a grammar, a checker, a TypeScript surface, and a runtime. The editor features, content mapper, and loader are derived.

```ts
export const calc = defineLanguage({
  name: "calc",
  extensions: [".calc"],
  grammar: calcGrammar,
  check: checkCalc,
  typescript: calcTypes,
  runtime: calcRuntime,
});
```

The design record lives in [`docs/`](docs):

- [`00-survey.md`](docs/00-survey.md): what the previous langkit assumed, measured, and what does not hold.
- [`01-architecture.md`](docs/01-architecture.md): the redesigned pipeline and API.
- [`02-grammar.md`](docs/02-grammar.md): the grammar language.
- [`03-incremental.md`](docs/03-incremental.md): reparse algorithm and benchmark.

Work in progress.
