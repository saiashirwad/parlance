# Neovim

Parlance ships one generic LSP. A project-local `.nvim.lua` registers it for
`.advanced`, `.calc`, `.schema`, `.machine`, and `.parl` files and enables semantic tokens.
It also attaches to TypeScript buffers, where it answers only inside embedded snippets such as
`` schema("Blog")`...` `` and returns nothing elsewhere, so it runs beside `tsc` (see
[08-embedding.md](08-embedding.md)). This is
the same project-local `exrc` pattern used by the older `langkit` checkout.

## Quick start

Requirements: Neovim 0.11 or newer (0.12.5 was used for the smoke test), Node
24.2 or newer, and `pnpm install` in the repository.

```sh
cd /Users/texoport/code/langkit-first-principles
nvim examples/calc/demo.calc
# or the grammar language itself:
nvim src/grammar/grammar.parl
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
| Grammar files | `.parl` diagnostics, symbols, hover, definition, references, tokens |
| Snippets in `.ts` | diagnostics, hover, definition, completion, tokens inside the template |
| Formatting | not provided by the server |

Cross-file navigation currently covers definition, references, and rename.
Workspace symbols and signature help are not implemented.

## TypeScript imports

`.nvim.lua` also sets `runExternalCode = true` on the `tsc` client when its root
is this checkout. That is required for the TypeScript 7 content mapper to
execute `@parlance/ts-host` while transforming a guest import. With the
`nvim-lspconfig` tsc setup from the dotfiles, open
`examples/typescript/calc.ts` and hover or `gd` on `subtotal`; it resolves into
`examples/calc/demo.calc`.

The first hover can be empty for a second while `tsc` initializes the project.
Retry once diagnostics settle. If no `tsc` client appears, check that the
project's local TypeScript is 7.x and that `nvim-lspconfig`'s `tsc` config is
enabled.

## How the wiring works

`.nvim.lua` registers the filetypes, then one server named `parlance`:

```lua
vim.lsp.config("parlance", {
  cmd = { "node", root .. "/src/lsp/cli.ts", "--config", root .. "/parlance.config.ts" },
  cmd_cwd = root,
  filetypes = { "advanced", "calc", "schema", "machine", "parl", "typescript" },
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
vim.filetype.add({ extension = { advanced = "advanced", calc = "calc", schema = "schema", machine = "machine", parl = "parl" } })

vim.lsp.config("parlance", {
  cmd = function(dispatchers, config)
    local root = config.root_dir
    return vim.lsp.rpc.start({
      "node", vim.env.PARLIANCE_HOME .. "/src/lsp/cli.ts",
      "--config", root .. "/parlance.config.ts",
    }, dispatchers)
  end,
  filetypes = { "advanced", "calc", "schema", "machine", "parl" },
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

- `.advanced`, `.calc`, `.schema`, `.machine`, and `.parl` attach to `parlance`.
- Hover returns `number`; definition lands on line 1.
- Semantic tokens are non-empty and the first token is a keyword.
- Breaking the calc buffer publishes an `Expected number` diagnostic; fixing it
  clears the diagnostic.
- Advanced, schema, machine, and grammar symbols appear; advanced hover shows an ADT.
- Definition from `catalog.schema` reaches `User` in `blog.schema`; `.parl` root rules resolve.
- `examples/embed/app.ts` attaches `parlance`, and hover inside its schema snippet shows `User`.

Passing output:

```
ok nvim: advanced, calc, schema, machine, parl, embedded snippets, hover, definition, tokens, diagnostics
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
