import { type CoreGraphOptions, ModuleGraph as CoreGraph, type ModuleGraphOptions } from "./graph.ts";
import { nodeHost } from "./host-node.ts";

export type { AnalyzeOptions, CoreGraphOptions, ModuleGraphOptions, ModuleNode, ResolvedImport } from "./graph.ts";
export { languageForUri } from "./graph.ts";
export { defaultResolve, documentUri, nodeHost } from "./host-node.ts";

/** The module graph over the filesystem. Pass `host` to read from somewhere else. */
export class ModuleGraph extends CoreGraph {
  constructor(options: ModuleGraphOptions & Partial<Pick<CoreGraphOptions, "host">>) {
    super({ host: nodeHost, ...options });
  }
}
