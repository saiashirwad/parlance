/** Options for a language whose runtime is an interpreter shipped alongside the guest module. */
export type RuntimeModuleOptions = {
  readonly data: unknown;
  /** Import specifier for the runtime factory, usually `new URL("./runtime.ts", import.meta.url).href`. */
  readonly from: string;
  /** Names imported from `from`. Defaults to `["create"]`. */
  readonly imports?: readonly string[];
  /** Factory expression; `data` is in scope. Defaults to `create(data)`. */
  readonly factory?: string;
  /** Export name -> expression; `runtime` is in scope. `default` becomes the default export. */
  readonly exports: Readonly<Record<string, string>>;
};

/**
 * Emits an ES module that embeds serialized IR and builds a runtime from it.
 * This is the low-effort runtime path for languages that interpret rather than compile to JS.
 */
export const runtimeModule = (options: RuntimeModuleOptions): string => {
  const imports = options.imports ?? ["create"];
  const factory = options.factory ?? "create(data)";
  const lines: string[] = [];
  if (imports.length > 0) lines.push(`import { ${imports.join(", ")} } from ${JSON.stringify(options.from)};`);
  lines.push(`const data = ${serialize(options.data)};`);
  lines.push(`const runtime = ${factory};`);
  for (const [name, expression] of Object.entries(options.exports)) {
    if (name === "default") lines.push(`export default ${expression};`);
    else if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
      throw new Error(`Export name ${JSON.stringify(name)} is not a valid identifier`);
    } else lines.push(`export const ${name} = ${expression};`);
  }
  return lines.join("\n") + "\n";
};

const serialize = (value: unknown): string => {
  const seen = new WeakSet<object>();
  const text = JSON.stringify(value, (key, entry: unknown) => {
    if (typeof entry === "undefined") {
      throw new Error(`Runtime data at ${JSON.stringify(key)} is undefined; use null for absence`);
    }
    if (typeof entry === "function" || typeof entry === "symbol" || typeof entry === "bigint") {
      throw new Error(`Runtime data at ${JSON.stringify(key)} is not serializable`);
    }
    if (entry !== null && typeof entry === "object") {
      if (seen.has(entry)) throw new Error("Runtime data contains a cycle");
      seen.add(entry);
    }
    return entry;
  });
  if (text === undefined) throw new Error("Runtime data is not serializable");
  return text;
};
