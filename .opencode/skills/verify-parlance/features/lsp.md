# Language server

## Sub-features

- One generic server for every language in the config (`parlance lsp --config ./parlance.config.ts`).
- Incremental text sync; a change reparses with the incremental path and rechecks.
- Semantic tokens, hover, definition, references, document symbols, completion, rename, diagnostics, folding.
- Features are derived from facts and the grammar; a language adds `show`/`describe`, not a server.

## How to get to it (user POV)

An editor starts `parlance lsp` over stdio, opens a `.calc`, `.schema`, or `.machine` document, and expects diagnostics and navigation. The repo's smoke client uses the same protocol.

## Driving it with the shell

```sh
# Live edit scenario: open valid, break it, fix it, hover, definition, tokens.
node tools/lsp-smoke.ts

# The unit-level protocol tests.
node --test tests/lsp.test.ts
```

`tools/lsp-smoke.ts` asserts, in order:
1. `initialize` advertises hover and full semantic tokens.
2. `didOpen` v1 publishes zero diagnostics.
3. Hover at the use of `x` contains `number`; definition starts at line 0.
4. `didChange` v2 to `let x = 1 + true;` publishes one `Expected number` error.
5. `didChange` v3 back to valid publishes zero diagnostics and hover still resolves.
6. `textDocument/semanticTokens/full` returns a non-empty array.

End state: `ok lsp edit scenario (...) 123ms`, exit 0.

Manual protocol drive, for a new feature:

```sh
# Start the server and speak the framing by hand only if a helper cannot express the case.
node src/lsp/cli.ts --config ./parlance.config.ts
# Send: Content-Length: N\r\n\r\n{...jsonrpc...}
```

## Gotchas

- The server writes framed JSON-RPC on stdout. Never print debug output to stdout; use stderr.
- Completion is keywords + top-level definitions only; there is no local-scope filtering yet (issue #4).
- Definition, references, and rename cross documents through the module graph. An edit to one open file refreshes invalidated open dependents before the next request; closing a file drops its graph node and refreshes importers from disk. Workspace symbols and formatting are open gaps (issue #4).
- The smoke driver kills its own child. Do not kill by process name.
