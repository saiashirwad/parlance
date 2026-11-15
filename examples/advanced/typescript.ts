import { source, synth, ts, type TsDoc } from "../../src/ts/index.ts";
import type { AdvancedModule, ConstructorInfo, DataInfo } from "./check.ts";
import { prune, type Type } from "./type.ts";
import { namer, nullaryConstructorText, printer, reserved } from "./type-printer.ts";

/** `to` relative to the directory of `from`, both URL pathnames. */
const relativePath = (from: string, to: string): string => {
  const base = from.split("/").filter(Boolean).slice(0, -1);
  const target = to.split("/").filter(Boolean);
  let shared = 0;
  while (shared < base.length && shared < target.length && base[shared] === target[shared]) shared++;
  return [...base.slice(shared).map(() => ".."), ...target.slice(shared)].join("/");
};

const relativeSpecifier = (from: string, to: string): string => {
  try {
    const fromUrl = new URL(from);
    const toUrl = new URL(to);
    if (fromUrl.protocol !== "file:" || toUrl.protocol !== "file:") return to;
    const path = relativePath(fromUrl.pathname, toUrl.pathname);
    return path.startsWith(".") ? path : `./${path}`;
  } catch {
    return to;
  }
};

const typeParameters = (parameters: readonly string[], datatypes: ReadonlyMap<string, string>): readonly string[] => {
  const name = namer(datatypes);
  return parameters.map((parameter) => name(parameter.toUpperCase()));
};

const brand = (info: DataInfo, parameters: readonly string[]): TsDoc => {
  const tuple = `readonly [${parameters.join(", ")}]`;
  const generic = parameters.length ? `<${parameters.join(", ")}>` : "";
  return ts`declare const $${source(info.name)}: unique symbol;
export type ${source(info.name)}${generic} = { readonly [$${source(info.name)}]: (x: ${tuple}) => ${tuple} };
`;
};

const constructor = (
  value: ConstructorInfo,
  typescript: (type: Type) => { readonly text: string; readonly problem: string | undefined },
  datatypes: ReadonlyMap<string, string>,
): TsDoc | null => {
  const printed = typescript(value.type);
  const text = printed.problem === undefined
    ? printed.text
    : nullaryConstructorText(value.type, datatypes);
  if (text === undefined) return null;
  const name = reserved.has(value.name)
    ? ts`declare const $${synth(value.name, value.span)}: ${text};
export { $${synth(value.name, value.span)} as ${synth(value.name, value.span)} };
`
    : ts`export declare const ${synth(value.name, value.span)}: ${text};
`;
  return name;
};

export const typescript = (module: AdvancedModule): TsDoc => {
  const referenced = new Map<string, string>();
  const print = printer(module.datatypes, referenced);
  const parameters = new Map<string, readonly string[]>();
  for (const info of module.types) {
    const values = typeParameters(info.parameters, module.datatypes);
    parameters.set(info.name.text, values);
  }

  const declarations: TsDoc[] = [];
  for (const info of module.types) {
    declarations.push(brand(info, parameters.get(info.name.text) ?? []));
  }
  for (const info of module.types) {
    for (const value of info.constructors) {
      const doc = constructor(value, print, module.datatypes);
      if (doc) declarations.push(doc);
    }
  }

  const fieldMembers: string[] = [];
  for (const exported of module.exports) {
    if (exported.kind === "constructor") continue;
    const printed = print(exported.fieldType);
    if (printed.problem !== undefined) continue;
    fieldMembers.push(`readonly ${exported.name}: ${printed.text}`);
    declarations.push(
      reserved.has(exported.name)
        ? ts`declare const $${synth(exported.name, exported.span)}: ${printed.text};
export { $${synth(exported.name, exported.span)} as ${synth(exported.name, exported.span)} };
`
        : ts`export declare const ${synth(exported.name, exported.span)}: ${printed.text};
`,
    );
  }

  const result = print(prune(module.resultType));
  const defaultText = prune(module.resultType).kind === "record" && fieldMembers.length > 0
    ? `{ ${fieldMembers.join("; ")} }`
    : result.problem === undefined
    ? result.text
    : "unknown";
  const main = fieldMembers.some((member) => member.startsWith("readonly main:")) ? "$main" : "main";
  declarations.push(ts`declare const ${main}: ${defaultText};
export default ${main};
`);

  const imports = [...Map.groupBy(
    [...referenced].filter(([, uri]) => uri !== module.uri),
    ([, uri]) => uri,
  )].map(([uri, entries]) => {
    const names_ = entries.map(([name]) => name).sort().join(", ");
    return ts`import type { ${names_} } from ${JSON.stringify(relativeSpecifier(module.uri, uri))};
`;
  });

  return ts`${imports}${declarations}`;
};
