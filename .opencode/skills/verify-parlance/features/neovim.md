# Neovim

## Sub-features

- Project-local `.nvim.lua` registers one `parlance` LSP for `.calc`, `.schema`, and `.machine`.
- `root_dir` scopes the server to this checkout; `.schema` is not hijacked elsewhere.
- Semantic tokens are enabled on attach (Neovim 0.12 `enable`, 0.11 `start`).
- Real `exrc` startup path, including trust, is exercised by `pnpm nvim:check`.

## How to get to it (user POV)

Enable project-local configs with `vim.o.exrc = true`, open any example under the repository, trust `.nvim.lua` once, and use the normal Neovim LSP keys: `K` hover, `gd` definition, `gr` references, `grn` rename, `gO` symbols. `:LspInfo` shows the `parlance` client.

## Driving it with the shell

```sh
# Explicit config path; no exrc trust involved.
pnpm nvim:smoke

# Real startup: temp XDG dirs, trusted .nvim.lua, exrc, same assertions.
pnpm nvim:check
```

Both print:

```
ok nvim: calc, schema, machine, hover, definition, tokens, diagnostics
```

They assert a client on each filetype, hover `number`, definition line 1, non-empty semantic tokens with a keyword at 0,0, an `Expected number` diagnostic that clears after the fix, schema/machine symbols, and `catalog.schema` definition into `blog.schema`.

## Gotchas

- `nvim -u NONE -l` skips `exrc`; `nvim:smoke` therefore sources `.nvim.lua` explicitly. `nvim:check` is the proof of the real startup path.
- An untrusted `.nvim.lua` silently does nothing in headless runs. Interactively, choose view and run `:trust`; `nvim:check` trusts only a throwaway state directory.
- `vim.lsp.semantic_tokens.start` is deprecated on 0.12; the config uses `enable` and falls back for 0.11.
- The server does not format. Formatting stays with Conform or another tool.
- Completion is grammar keywords plus top-level definitions; local-scope filtering is still open.
- The global-config snippet in `docs/06-neovim.md` needs `PARLIANCE_HOME` pointing at this checkout.
