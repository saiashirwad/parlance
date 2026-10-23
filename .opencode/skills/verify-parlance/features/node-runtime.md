# Node runtime

## Sub-features

- `registerLanguages([...])` installs `module.registerHooks` for every guest extension.
- Guest files load in memory, are analyzed and checked, then emit an ES module.
- Guest imports recurse through the same loader.
- A language with errors throws a `SyntaxError` with rendered guest positions.

## How to get to it (user POV)

A Node user writes ordinary TypeScript that imports a guest file. `examples/register.ts` installs the hooks; `examples/typescript/*.ts` are the consumers.

```sh
node --import ./examples/register.ts examples/typescript/calc.ts
node --import ./examples/register.ts examples/typescript/schema.ts
node --import ./examples/register.ts examples/typescript/machine.ts
```

## Driving it with the shell

| command | expected stdout |
| --- | --- |
| calc | `250` on one line, then `250 125 true` |
| schema | `sai@example.com 0 0` |
| machine | `Paid Checkout Paid pay 50` |

For a failure, point the loader at a file with a checker error:

```sh
cat > /tmp/bad.calc <<'EOF'
let x = 1 + true;
EOF
node --import ./examples/register.ts -e 'import("/tmp/bad.calc")' 2>&1 | head -8; echo "exit=$?"
```

End state: the three examples print the table values; the broken import throws `SyntaxError` containing `/tmp/bad.calc: 1:9 error: Expected number` (line/column may shift with the expression).

## Gotchas

- The loader reads from disk. Unsaved editor content goes through the content mapper, not Node.
- The schema example opens `node:sqlite`; Node may print an experimental warning on stderr. It does not affect exit status.
- `registerHooks` requires Node >= 22.15/24; the repo targets >= 24.2.
- Errors in the runtime module itself (not the guest source) point at the generated module. Source maps are issue #5.
