# Verification feature map

One file per user-facing capability. The map is the source of truth for what "works" means; keep it current when a feature ships.

| feature | surface | file |
| --- | --- | --- |
| Grammar authoring and typed ASTs | `.parl` files, `parlance gen`, self-host | [grammar.md](grammar.md) |
| Checking and diagnostics | `parlance check`, `analyze` | [checking.md](checking.md) |
| TypeScript content mapper | tsgo, `.ts` importing `.calc`/`.schema`/`.machine` | [content-mapper.md](content-mapper.md) |
| Cross-file imports | `ModuleGraph`, `import`/`use`, CLI/loader/mapper/LSP | [modules.md](modules.md) |
| Node runtime | `registerLanguages`, guest imports | [node-runtime.md](node-runtime.md) |
| Language server | `parlance lsp`, stdio JSON-RPC | [lsp.md](lsp.md) |
| Emit targets | `parlance emit --target sql\|drizzle\|kysely` | [emit-targets.md](emit-targets.md) |
| Incremental parsing | `reparse`, LSP edit latency | [incremental.md](incremental.md) |

A change to `src/grammar/*` or the grammar of an example must run `grammar.md` and `incremental.md`. A change to `src/ts/*` must run `content-mapper.md` and `node-runtime.md`. A change to `src/lsp/*` must run `lsp.md`. A change to an example checker or target must run `checking.md` and `emit-targets.md`.
