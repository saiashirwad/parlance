-- Loaded through trusted project-local configuration ('exrc').
-- Neovim 0.12+: one generic parlance server serves every registered language.
local source = debug.getinfo(1, "S").source:sub(2)
local root = vim.fs.dirname(vim.fn.fnamemodify(source, ":p"))

vim.filetype.add({
  pattern = {
    [vim.pesc(root) .. "/.*%.calc"] = "calc",
    [vim.pesc(root) .. "/.*%.schema"] = "schema",
    [vim.pesc(root) .. "/.*%.machine"] = "machine",
  },
})

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

-- The generic server publishes semantic tokens; enable them for this client.
-- Neovim 0.12 renamed start/stop to enable; keep the older call as a fallback.
vim.api.nvim_create_autocmd("LspAttach", {
  callback = function(args)
    local client = vim.lsp.get_client_by_id(args.data.client_id)
    if client and client.name == "parlance" and client:supports_method("textDocument/semanticTokens/full") then
      if vim.lsp.semantic_tokens.enable then
        vim.lsp.semantic_tokens.enable(true, { bufnr = args.buf, client_id = client.id })
      else
        vim.lsp.semantic_tokens.start(args.buf, client.id)
      end
    end
  end,
})
