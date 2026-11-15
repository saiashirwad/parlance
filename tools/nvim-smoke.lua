-- Headless Neovim proof for the project-local .nvim.lua.
-- Run from the repository root:
--   nvim --headless -u NONE -l tools/nvim-smoke.lua
local source = debug.getinfo(1, "S").source:sub(2)
local root = vim.fs.dirname(vim.fs.dirname(vim.fn.fnamemodify(source, ":p")))

local function fail(message)
  io.stderr:write("FAIL " .. message .. "\n")
  vim.cmd("cquit 1")
end

local function assert(condition, message)
  if not condition then fail(message) end
end

local function wait_for(predicate, message, timeout)
  if not vim.wait(timeout or 10000, predicate, 20) then fail(message) end
end

local function request(method, params)
  local responses = vim.lsp.buf_request_sync(0, method, params, 5000)
  assert(responses ~= nil, "no response for " .. method)
  for _, response in pairs(responses) do
    assert(response.result ~= nil, method .. " returned an error: " .. vim.inspect(response.err))
    return response.result
  end
  fail("empty response map for " .. method)
end

local function open(relative)
  vim.cmd("edit " .. vim.fn.fnameescape(root .. "/" .. relative))
  wait_for(function()
    return #vim.lsp.get_clients({ bufnr = 0 }) > 0
  end, "no parlance client for " .. relative)
end

local function position(line, character)
  return { line = line, character = character }
end

local ok, failure = pcall(function()
  vim.cmd("filetype on")
  vim.cmd("cd " .. vim.fn.fnameescape(root))
  if vim.env.PARLIANCE_NVIM_EXRC ~= "1" then
    vim.cmd("luafile " .. vim.fn.fnameescape(root .. "/.nvim.lua"))
  end

  open("examples/calc/demo.calc")
  assert(vim.bo.filetype == "calc", "expected filetype calc, got " .. vim.bo.filetype)
  local clients = vim.lsp.get_clients({ bufnr = 0 })
  assert(#clients == 1 and clients[1].name == "parlance", "parlance client did not attach")
  assert(#vim.diagnostic.get(0) == 0, "valid calc file has diagnostics")

  local hover = request("textDocument/hover", {
    textDocument = { uri = vim.uri_from_bufnr(0) },
    position = position(2, 6),
  })
  assert(hover and hover.contents and hover.contents.value, "hover returned no contents")
  assert(hover.contents.value:find("number") ~= nil, "hover did not show number: " .. hover.contents.value)

  local definition = request("textDocument/definition", {
    textDocument = { uri = vim.uri_from_bufnr(0) },
    position = position(2, 6),
  })
  assert(definition and definition.range and definition.range.start.line == 0, "definition did not point at line 0")

  local tokens = request("textDocument/semanticTokens/full", {
    textDocument = { uri = vim.uri_from_bufnr(0) },
  })
  assert(tokens and tokens.data and #tokens.data > 0, "semantic tokens are empty")
  local token = vim.lsp.semantic_tokens.get_at_pos(0, { 0, 0 })
  assert(token and token[1] and token[1].type == "keyword", "semantic token at 0,0 is not keyword: " .. vim.inspect(token))

  vim.api.nvim_buf_set_lines(0, 0, -1, false, { "let x = 1 + true;", "show x;" })
  wait_for(function()
    return #vim.diagnostic.get(0) > 0
  end, "broken calc did not publish a diagnostic")
  local broken = vim.diagnostic.get(0)
  assert(
    table.concat(vim.tbl_map(function(entry) return entry.message end, broken), "\n"):find("Expected number") ~= nil,
    "unexpected diagnostic: " .. vim.inspect(broken)
  )

  vim.api.nvim_buf_set_lines(0, 0, -1, false, { "let x = 1 + 2;", "show x;" })
  wait_for(function()
    return #vim.diagnostic.get(0) == 0
  end, "diagnostics did not clear after the fix")

  open("examples/schema/blog.schema")
  assert(vim.bo.filetype == "schema", "expected filetype schema")
  local symbols = request("textDocument/documentSymbol", { textDocument = { uri = vim.uri_from_bufnr(0) } })
  local names = {}
  for _, symbol in ipairs(symbols or {}) do names[symbol.name] = true end
  assert(names.User and names.Post, "schema symbols are missing User or Post")

  open("examples/schema/catalog.schema")
  local cross = request("textDocument/definition", {
    textDocument = { uri = vim.uri_from_bufnr(0) },
    position = position(7, 9),
  })
  assert(cross and cross.uri and cross.uri:match("blog%.schema$"), "cross-file definition did not reach blog.schema")
  assert(cross.range.start.line == 5, "cross-file definition line is wrong")

  open("examples/machine/order.machine")
  assert(vim.bo.filetype == "machine", "expected filetype machine")
  local machineSymbols = request("textDocument/documentSymbol", { textDocument = { uri = vim.uri_from_bufnr(0) } })
  local machineNames = {}
  for _, symbol in ipairs(machineSymbols or {}) do machineNames[symbol.name] = true end
  assert(machineNames.pay and machineNames.Checkout, "machine symbols are missing pay or Checkout")

  open("examples/advanced/trees.advanced")
  assert(vim.bo.filetype == "advanced", "expected filetype advanced")
  local advancedSymbols = request("textDocument/documentSymbol", { textDocument = { uri = vim.uri_from_bufnr(0) } })
  local advancedNames = {}
  for _, symbol in ipairs(advancedSymbols or {}) do advancedNames[symbol.name] = true end
  assert(advancedNames.Tree and advancedNames.fromList and advancedNames.sumTree, "advanced symbols are missing")
  local advancedSource = vim.api.nvim_buf_get_lines(0, 0, -1, false)
  local fromListLine = nil
  for index, text in ipairs(advancedSource) do
    if text:match("^let fromList") then fromListLine = index - 1 end
  end
  assert(fromListLine, "missing fromList line")
  local fromListCharacter = advancedSource[fromListLine + 1]:find("fromList") - 1
  local advancedHover = request("textDocument/hover", {
    textDocument = { uri = vim.uri_from_bufnr(0) },
    position = position(fromListLine, fromListCharacter),
  })
  assert(advancedHover.contents.value:find("Tree") ~= nil, "advanced hover did not show Tree: " .. advancedHover.contents.value)
  local advancedTokens = request("textDocument/semanticTokens/full", { textDocument = { uri = vim.uri_from_bufnr(0) } })
  assert(advancedTokens and advancedTokens.data and #advancedTokens.data > 0, "advanced semantic tokens are empty")

  open("src/grammar/grammar.parl")
  assert(vim.bo.filetype == "parl", "expected filetype parl")
  local grammarSource = vim.api.nvim_buf_get_lines(0, 0, -1, false)
  local grammarSymbols = request("textDocument/documentSymbol", { textDocument = { uri = vim.uri_from_bufnr(0) } })
  local grammarNames = {}
  for _, symbol in ipairs(grammarSymbols or {}) do grammarNames[symbol.name] = true end
  assert(grammarNames.Grammar and grammarNames.Rule and grammarNames.Primary, "grammar symbols are missing")
  local grammarTokens = request("textDocument/semanticTokens/full", { textDocument = { uri = vim.uri_from_bufnr(0) } })
  assert(grammarTokens and grammarTokens.data and #grammarTokens.data > 0, "grammar semantic tokens are empty")
  local rootLine = nil
  for index, text in ipairs(grammarSource) do
    if text:match("^root File") then rootLine = index - 1 end
  end
  assert(rootLine, "missing root File line")
  local rootCharacter = grammarSource[rootLine + 1]:find("File") - 1
  local grammarHover = request("textDocument/hover", {
    textDocument = { uri = vim.uri_from_bufnr(0) },
    position = position(rootLine, rootCharacter),
  })
  assert(grammarHover.contents.value:find("rule File") ~= nil, "grammar hover did not resolve the rule")

  open("examples/embed/app.ts")
  assert(vim.bo.filetype == "typescript", "expected filetype typescript")
  local embedClients = vim.lsp.get_clients({ bufnr = 0, name = "parlance" })
  assert(#embedClients == 1, "parlance did not attach to the TypeScript buffer")
  local embedSource = vim.api.nvim_buf_get_lines(0, 0, -1, false)
  local whereLine = nil
  for index, text in ipairs(embedSource) do
    if text:match("User |> where") then whereLine = index - 1 end
  end
  assert(whereLine, "missing snippet query line")
  local embedHover = request("textDocument/hover", {
    textDocument = { uri = vim.uri_from_bufnr(0) },
    position = position(whereLine, embedSource[whereLine + 1]:find("User") - 1),
  })
  assert(embedHover and embedHover.contents.value:find("User") ~= nil, "snippet hover did not show User")
end)

if not ok then
  io.stderr:write("FAIL " .. tostring(failure) .. "\n")
  vim.cmd("cquit 1")
end

print("ok nvim: advanced, calc, schema, machine, parl, embedded snippets, hover, definition, tokens, diagnostics")
vim.cmd("qa!")
