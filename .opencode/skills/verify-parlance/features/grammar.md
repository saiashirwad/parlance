# Grammar authoring and typed ASTs

## Sub-features

- `.parl` grammar files compile to a token-array lexer and parser.
- Static checks: left recursion, nullable loops, unknown refs, unused rules, duplicate tags/fields.
- `parlance gen` emits TypeScript interfaces and unions for tagged nodes and precedence nodes.
- The grammar language parses itself; the compiled parser must produce the same AST as the bootstrap parser.

## How to get to it (user POV)

A language author writes `examples/<lang>/<lang>.parl`, runs `parlance gen` once to produce `<lang>.ast.ts`, then imports the compiled grammar in `<lang>.ts`. The CLI command is:

```sh
node src/grammar/cli.ts gen examples/calc/calc.parl /tmp/calc.ast.ts
```

## Driving it with the shell

```sh
# 1. Generated types match what is checked in, for every example.
node tools/grammar-check.ts

# 2. Generate one AST explicitly and diff it.
node src/grammar/cli.ts gen examples/calc/calc.parl /tmp/calc.ast.ts
diff -u examples/calc/calc.ast.ts /tmp/calc.ast.ts

# 3. The grammar language parses itself and the AST matches the bootstrap.
node --test tests/grammar.test.ts

# 4. Generated types match parsed values.
node --test tests/grammar-types.test.ts

# 5. A grammar with a static error is rejected with a grammar span.
cat > /tmp/bad.parl <<'EOF'
grammar Bad
skip /\s+/
root File
rule File = { File };
EOF
node src/grammar/cli.ts gen /tmp/bad.parl /tmp/bad.ast.ts; echo "exit=$?"
```

End state: step 1 reports every grammar and AST current; step 2 diff is empty; steps 3 and 4 pass; step 5 exits nonzero and names `File` as left-recursive.

## Gotchas

- Rules end with `;`. A missing semicolon produces a parse error at the next rule.
- Tags are contextual per rule; the same tag name in two rules is fine, two field sets in one rule is not.
- Keywords are contextual: `"state"` matches a word token with that text, so it can also be a field name elsewhere.
- Checked-in `.ast.ts` files are consumed by `tsc`; regenerate them when a grammar changes or the typecheck fails on a missing field.
