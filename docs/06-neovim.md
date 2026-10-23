# Neovim

Parlance ships one generic LSP. A project-local `.nvim.lua` registers it for
`.calc`, `.schema`, and `.machine` files and enables semantic tokens. This is
the same project-local `exrc` pattern used by the older `langkit` checkout.

## Quick start

Requirements: Neovim 0.11 or newer (0.12.5 was used for the smoke test), Node
24.2 or newer, and `pnpm install` in the repository.

```sh
cd /Users/texoport/code/langkit-first-principles
nvim examples/calc/demo.calc
```

Your config needs project-local configs enabled:

```lua
vim.o.exrc = true
```

The first time you open a file in the repository Neovim asks whether to trust
`.nvim.lua`. Choose **view** to inspect it, then run:

```vim
:trust
```

The client starts automatically. `:LspInfo` (or
`:lua =vim.lsp.get_clients({ bufnr = 0 })`) should show `parlance` rooted at the
repository.

## What works

| Feature | Neovim |
| --- | --- |
| Diagnostics | published on open and on every edit; survive parse errors |
| Hover | `K` |
| Definition | `gd`; crosses imports |
| References | `gr`; crosses imports |
| Rename | `grn`; crosses imports |
| Document symbols | `gO` |
| Completion | insert mode; grammar keywords and top-level definitions |
| Folding | `textDocument/foldingRange` |
| Semantic tokens | enabled on attach; keywords, strings, numbers, types, properties |
| Formatting | not provided by the server |

Cross-file navigation currently covers definition, references, and rename.
Workspace symbols and signature help are not implemented.

## How the wiring works

`.nvim.lua` registers the filetypes, then one server named `parlance`:

```lua
vim.lsp.config("parlance", {
  cmd = { "node", root .. "/src/lsp/cli.ts", "--config", root .. "/parlance.config.ts" },
  cmd_cwd = root,
  filetypes = { "calc", "schema", "machine" },
  workspace_required = true,
  root_dir = function(bufnr, on_dir)
    if vim.startswith(vim.api.nvim_buf_get_name(bufnr), root .. "/") then
      on_dir(root)
    end
  end,
})
vim.lsp.enable("parlance")
```

The command passes an absolute config path, so the server does not depend on
the editor's working directory. The `root_dir` predicate keeps the guest
servers scoped to this repository, which matters because `.schema` is a common
extension.

The attach callback enables `vim.lsp.semantic_tokens.enable(true, ...)` for the
parlance client. Neovim versions before 0.12 fall back to
`vim.lsp.semantic_tokens.start`.

## Using parlance from another project

Add a global `after/lsp/parlance.lua` (or a file sourced by your config). Set
`PARLIANCE_HOME` to the parlance checkout. The project only needs a
`parlance.config.ts`:

```lua
vim.filetype.add({ extension = { calc = "calc", schema = "schema", machine = "machine" } })

vim.lsp.config("parlance", {
  cmd = function(dispatchers, config)
    local root = config.root_dir
    return vim.lsp.rpc.start({
      "node", vim.env.PARLIANCE_HOME .. "/src/lsp/cli.ts",
      "--config", root .. "/parlance.config.ts",
    }, dispatchers)
  end,
  filetypes = { "calc", "schema", "machine" },
  root_markers = { "parlance.config.ts" },
})

vim.lsp.enable("parlance")

vim.api.nvim_create_autocmd("LspAttach", {
  callback = function(args)
    local client = vim.lsp.get_client_by_id(args.data.client_id)
    if client and client.name == "parlance" then
      if vim.lsp.semantic_tokens.enable then
        vim.lsp.semantic_tokens.enable(true, { bufnr = args.buf, client_id = client.id })
      else
        vim.lsp.semantic_tokens.start(args.buf, client.id)
      end
    end
  end,
})
```

## Verification

Two rerunnable checks:

```sh
pnpm nvim:smoke
pnpm nvim:check
```

`nvim:smoke` sources `.nvim.lua` explicitly with `-u NONE`. `nvim:check` proves
the real startup path: it builds a throwaway `XDG_CONFIG_HOME` and
`XDG_STATE_HOME`, trusts `.nvim.lua` only in that temporary state, starts
Neovim through `exrc`, and runs the same assertions.

Both assert:

- `.calc`, `.schema`, and `.machine` attach to `parlance`.
- Hover returns `number`; definition lands on line 1.
- Semantic tokens are non-empty and the first token is a keyword.
- Breaking the calc buffer publishes an `Expected number` diagnostic; fixing it
  clears the diagnostic.
- Schema and machine symbols appear.
- Definition from `catalog.schema` reaches `User` in `blog.schema`.

Passing output:

```
ok nvim: calc, schema, machine, hover, definition, tokens, diagnostics
```

## Troubleshooting

| symptom | check |
| --- | --- |
| no client | `:set exrc?`, trust `.nvim.lua` with `:trust`, confirm Node 24 |
| client starts on the wrong project | `:lua =vim.lsp.get_clients({ bufnr = 0 })[1].config.root_dir` |
| no colors | `:lua =vim.lsp.semantic_tokens.is_enabled(0)` |
| no diagnostics | `:lua =vim.diagnostic.get(0)`, `:checkhealth vim.lsp` |
| server exits immediately | run `node src/lsp/cli.ts --config ./parlance.config.ts` by hand |
| wrong config | the `cmd` must contain the absolute `--config` path |

Server logs: `:lua vim.lsp.set_log_level("debug")`, then
`:lua =vim.lsp.get_log_path()`.
