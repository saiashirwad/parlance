/** Emits WGSL from checked shade IR. Every type is explicit, so literals convert the way the checker typed them. */
import { type Expr, inputs, type ShadeModule, type Stmt } from "./check.ts";
import { show, type Ty } from "./types.ts";

const type = (value: Ty): string => show(value);

const expr = (value: Expr): string => {
  switch (value.k) {
    case "lit":
      return value.text;
    case "local":
    case "resource":
    case "input":
      return value.name;
    case "field":
      return `${expr(value.base)}.${value.name}`;
    case "swizzle":
      return `${expr(value.base)}.${value.text}`;
    case "index":
      return `${expr(value.base)}[${expr(value.index)}]`;
    case "call":
    case "builtin":
      return `${value.name}(${value.args.map(expr).join(", ")})`;
    case "construct":
      return `${type(value.type)}(${value.args.map(expr).join(", ")})`;
    case "binary":
      return `(${expr(value.left)} ${value.op} ${expr(value.right)})`;
    case "unary":
      return `(${value.op}${expr(value.operand)})`;
    case "len":
      return `arrayLength(&${value.name})`;
  }
};

const block = (statements: readonly Stmt[], indent: string): string =>
  `{\n${statements.map((entry) => statement(entry, `${indent}  `)).join("")}${indent}}`;

const statement = (value: Stmt, indent: string): string => {
  switch (value.k) {
    case "let":
      return `${indent}let ${value.name}: ${type(value.type)} = ${expr(value.init!)};\n`;
    case "var":
      return `${indent}var ${value.name}: ${type(value.type)}${value.init ? ` = ${expr(value.init)}` : ""};\n`;
    case "assign":
      return `${indent}${expr(value.target)} ${value.op === "=" ? "=" : `${value.op}=`} ${expr(value.value)};\n`;
    case "if": {
      let text = `${indent}if ${expr(value.cond)} ${block(value.then, indent)}`;
      let otherwise = value.otherwise;
      while (otherwise) {
        const only = otherwise.length === 1 ? otherwise[0]! : null;
        if (only?.k === "if") {
          text += ` else if ${expr(only.cond)} ${block(only.then, indent)}`;
          otherwise = only.otherwise;
        } else {
          text += ` else ${block(otherwise, indent)}`;
          otherwise = null;
        }
      }
      return `${text}\n`;
    }
    case "while":
      return `${indent}while ${expr(value.cond)} ${block(value.body, indent)}\n`;
    case "for": {
      const name = value.name;
      return `${indent}for (var ${name}: ${type(value.type)} = ${expr(value.from)}; ${name} < ${expr(value.to)}; ${name}++) ${block(value.body, indent)}\n`;
    }
    case "return":
      return `${indent}return${value.value ? ` ${expr(value.value)}` : ""};\n`;
    case "break":
    case "continue":
      return `${indent}${value.k};\n`;
    case "expr":
      return `${indent}${expr(value.value)};\n`;
    case "block":
      return `${indent}${block(value.body, indent)}\n`;
  }
};

export const wgsl = (module: ShadeModule): string => {
  const parts: string[] = [];
  for (const struct of module.structs) {
    const fields = struct.type.fields.map((field) =>
      `  ${field.attrs.map((attr) => `@${attr.name}(${attr.value}) `).join("")}${field.name}: ${type(field.type)},\n`
    );
    parts.push(`struct ${struct.name.text} {\n${fields.join("")}}\n`);
  }
  if (module.resources.length > 0) {
    parts.push(module.resources.map((resource) => {
      const space = resource.space === "uniform" ? "uniform" : `storage, ${resource.access}`;
      return `@group(${resource.group}) @binding(${resource.binding}) var<${space}> ${resource.name.text}: ${type(resource.type)};\n`;
    }).join(""));
  }
  for (const fn of module.fns) {
    const params = fn.params.map((param) => `${param.name}: ${type(param.type)}`).join(", ");
    const result = fn.result.k === "void" ? "" : ` -> ${type(fn.result)}`;
    parts.push(`fn ${fn.name.text}(${params})${result} ${block(fn.body, "")}\n`);
  }
  for (const kernel of module.kernels) {
    const params = kernel.inputs.map((name) => {
      const input = inputs.get(name)!;
      return `@builtin(${input.wgsl}) ${name}: ${type(input.type)}`;
    }).join(", ");
    parts.push(`@compute @workgroup_size(${kernel.size.join(", ")})\nfn ${kernel.name.text}(${params}) ${block(kernel.body, "")}\n`);
  }
  return parts.join("\n");
};
