#!/bin/sh
# Drives the real project-local exrc path: Neovim starts in the repository,
# trusts .nvim.lua in a throwaway state directory, and runs the same smoke
# assertions as `nvim --headless -u NONE -l tools/nvim-smoke.lua`.
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/parlance-nvim.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM

mkdir -p "$work/config/nvim" "$work/state"
cat > "$work/config/nvim/init.lua" <<EOF
vim.o.exrc = true
vim.secure.trust({ action = "allow", path = "$root/.nvim.lua" })
vim.cmd("filetype on")
EOF

cd "$root"
PARLIANCE_NVIM_EXRC=1 \
XDG_CONFIG_HOME="$work/config" \
XDG_STATE_HOME="$work/state" \
nvim --headless \
  -c 'luafile tools/nvim-smoke.lua' \
  -c 'qa!'
