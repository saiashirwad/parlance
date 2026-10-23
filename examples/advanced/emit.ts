import type { Binding } from "../../src/check/index.ts";
import type { AdvancedModule, Checked } from "./check.ts";

const jsNames = new Map<number, string>();

const jsName = (binding: Binding<unknown>): string => {
  let name = jsNames.get(binding.id);
  if (name === undefined) {
    name = `_v${binding.id}`;
    jsNames.set(binding.id, name);
  }
  return name;
};

const key = (name: string): string => `[${JSON.stringify(name)}]`;

const constructor = (module: AdvancedModule): string[] =>
  module.constructors.map((value) => {
    const name = jsName(value.binding);
    if (value.arity === 0) {
      return `const ${name} = { tag: ${JSON.stringify(value.tag)}, fields: [] };`;
    }
    const parameters = Array.from({ length: value.arity }, (_, index) => `x${index}`);
    const body = `({ tag: ${JSON.stringify(value.tag)}, fields: [${parameters.join(", ")}] })`;
    return `const ${name} = ${parameters.map((parameter) => `(${parameter}) =>`).join(" ")} ${body};`;
  });

const branch = (
  tag: string,
  bindings: readonly { readonly name: string; readonly binding: Binding<unknown>; readonly index: number }[],
  body: string,
): string => {
  const declarations = bindings.map((binding) =>
    `        const ${jsName(binding.binding)} = _match.fields[${binding.index}];`
  );
  return [
    `      case ${JSON.stringify(tag)}: {`,
    ...declarations,
    `        return ${body};`,
    "      }",
  ].join("\n");
};

const expr = (value: Checked): string => {
  switch (value.kind) {
    case "number":
      return String(value.value);
    case "boolean":
      return String(value.value);
    case "string":
      return JSON.stringify(value.value);
    case "name":
      return value.builtin === "print" ? "_print" : jsName(value.binding);
    case "constructor":
      return jsName(value.binding);
    case "record": {
      const fields = value.fields.map((field) => `${key(field.name)}: ${expr(field.value)}`);
      return value.base === null
        ? `{ ${fields.join(", ")} }`
        : `{ ...${expr(value.base)}, ${fields.join(", ")} }`;
    }
    case "field":
      return `${expr(value.record)}${key(value.name)}`;
    case "binary": {
      const operator = value.operator === "=="
        ? "==="
        : value.operator === "!="
        ? "!=="
        : value.operator;
      return `(${expr(value.left)} ${operator} ${expr(value.right)})`;
    }
    case "prefix":
      return `(${value.operator}${expr(value.operand)})`;
    case "let":
      return `(() => { const ${jsName(value.binding)} = ${expr(value.value)}; return ${expr(value.body)}; })()`;
    case "fn":
      return `(${jsName(value.binding)}) => (${expr(value.body)})`;
    case "call":
      return `${expr(value.fn)}(${expr(value.arg)})`;
    case "if":
      return `(${expr(value.cond)} ? ${expr(value.then)} : ${expr(value.otherwise)})`;
    case "match": {
      const cases = value.cases.map((entry) => branch(entry.tag, entry.bindings, expr(entry.body)));
      if (value.fallback) {
        const declaration = value.fallback.binding
          ? `        const ${jsName(value.fallback.binding.binding)} = _match;`
          : "";
        cases.push(
          [
            "      default: {",
            declaration,
            `        return ${expr(value.fallback.body)};`,
            "      }",
          ].filter((line) => line.length > 0).join("\n"),
        );
      }
      return `((_match) => {\n    switch (_match.tag) {\n${cases.join("\n")}\n    }\n  })(${expr(value.value)})`;
    }
  }
};

export const runtime = (module: AdvancedModule): string => {
  const imports = module.imports.map((group) => {
    const names = group.names.map((entry) => {
      const local = jsName(entry.binding);
      return entry.exported === local ? local : `${entry.exported} as ${local}`;
    });
    return `import { ${names.join(", ")} } from ${JSON.stringify(group.specifier)};`;
  });
  const constructors = constructor(module);
  const result = expr(module.body);
  const exports: string[] = [];
  let index = 0;
  for (const exported of module.exports) {
    if (exported.kind === "constructor") {
      exports.push(`export { ${jsName(exported.binding)} as ${JSON.stringify(exported.name)} };`);
      continue;
    }
    const name = `_e${index++}`;
    exports.push(`const ${name} = _result${key(exported.name)};`);
    exports.push(`export { ${name} as ${JSON.stringify(exported.name)} };`);
  }
  return [
    ...imports,
    "const _print = (value) => { console.log(value); return {}; };",
    ...constructors,
    `const _result = ${result};`,
    ...exports,
    "export default _result;",
    "",
  ].join("\n");
};
