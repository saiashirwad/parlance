# Checking and diagnostics

## Sub-features

- `parlance check <files>` resolves the language from the config and prints diagnostics with line, column, and a caret.
- The checker is a mutable `Checker`: scopes, bindings, facts, `AbortCheck` recovery.
- Checkers are domain-specific: calc infers number/boolean, schema validates models/enums/FKs/queries, machine validates transitions and reachability.
- Partial results survive parse errors where the language allows it.

## How to get to it (user POV)

Run the CLI from the repo root, or call `analyze(language, source, uri)` from a host. A user edits `examples/calc/demo.calc`, `examples/schema/blog.schema`, or `examples/machine/order.machine` and expects `ok <file>` or a pointed error.

## Driving it with the shell

```sh
./parlance check examples/calc/demo.calc examples/schema/blog.schema examples/machine/order.machine

# A real error must point at the guest span.
cat > /tmp/broken.calc <<'EOF'
let x = 1 + true;
show x;
EOF
./parlance check /tmp/broken.calc; echo "exit=$?"

# Domain errors.
cat > /tmp/broken.machine <<'EOF'
machine Broken {
  event pay;
  state initial Cart { on pay -> Missing; }
}
EOF
./parlance check /tmp/broken.machine; echo "exit=$?"
```

End state: the three examples print three `ok` lines; each broken file exits 1 and prints `file:line:col error:` with a caret under the offending token.

## Gotchas

- The CLI resolves the language by extension and the config by walking only the current directory. Pass `--config` from elsewhere.
- `./parlance`, not `pnpm exec parlance`; the latter may resolve a published binary.
- Checker errors do not throw. Only `abort` unwinds one unit and is caught at the declaration boundary.
