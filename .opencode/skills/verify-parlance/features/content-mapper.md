# TypeScript content mapper

## Sub-features

- One package, `@parlance/ts-host`, serves every language in `parlance.config.ts`.
- A `.ts` file can `import` a `.calc`, `.schema`, or `.machine` file and see a source-mapped TypeScript surface.
- Hover and go-to-definition from TypeScript cross into guest source using mappings.
- Guest diagnostics are returned as mapper diagnostics at guest offsets.

## How to get to it (user POV)

`tsconfig.json` declares the content mapper. A TypeScript user writes `import answer from "../calc/demo.calc"` and runs the compiler or an editor. No generated `.ts` file appears on disk.

## Driving it with the shell

```sh
# The repository typecheck includes examples/typescript/*.ts, so this drives the real mapper.
pnpm typecheck

# Explicit tsgo navigation: hover and definition from .ts into .calc and .schema.
node --test tests/tsgo.test.ts

# Mapping oracle: every verbatim mapping slices the same guest text; ranges stay in bounds.
node --test tests/ts-mappings.test.ts

# The mapper resolves an imported dependency and emits the importer's surface.
node --import ./examples/register.ts examples/typescript/catalog.ts

# Inspect the mapped surface without a compiler.
node -e '
import("./examples/calc/calc.ts").then(async ({ calc }) => {
  const { readFileSync } = await import("node:fs");
  const { analyze } = await import("./src/language.ts");
  const source = readFileSync("examples/calc/demo.calc", "utf8");
  const analysis = analyze(calc, source, "file:///demo.calc");
  console.log(calc.typescript(analysis.ir).text);
});'
```

End state: `pnpm typecheck` exits 0; the tsgo test reports two passing tests; the catalog run prints `1 1 Tools`; the printed surface contains `export declare const` and `export default` with calc names.

## Gotchas

- The mapper resolves `options.config` relative to the `tsconfig.json` that names the package, not the process cwd.
- `source(node)` emits verbatim guest text; `synth(text, span)` emits generated text with an atom mapping. Generated type text without an origin cannot navigate back.
- The config module is cache-busted by mtime; a same-millisecond write can be missed. Restart the compiler after editing `parlance.config.ts` by hand.
- The mapper hashes guest files on disk for `configIdentity`; unsaved dependency edits are not visible yet (issue #12).
