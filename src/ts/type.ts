export type TsType =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "ref"; readonly name: string; readonly args?: readonly TsType[] }
  | { readonly kind: "array"; readonly element: TsType; readonly readonly?: boolean }
  | { readonly kind: "union"; readonly members: readonly TsType[] }
  | {
      readonly kind: "record";
      readonly fields: readonly {
        readonly name: string;
        readonly type: TsType;
        readonly optional?: boolean;
        readonly readonly?: boolean;
      }[];
    }
  | {
      readonly kind: "function";
      readonly params: readonly {
        readonly name: string;
        readonly type: TsType;
        readonly optional?: boolean;
      }[];
      readonly result: TsType;
    }
  | { readonly kind: "literal"; readonly value: string | number | boolean }
  | { readonly kind: "tuple"; readonly elements: readonly TsType[] };

const element = (type: TsType): string => {
  const text = typeText(type);
  const needsParens =
    type.kind === "union" ||
    type.kind === "function" ||
    (type.kind === "array" && type.readonly !== false);
  return needsParens ? `(${text})` : text;
};

/** Prints a type deterministically, with only the parentheses TypeScript needs. */
export const typeText = (type: TsType): string => {
  switch (type.kind) {
    case "text":
      return type.text;
    case "ref":
      return type.args?.length ? `${type.name}<${type.args.map(typeText).join(", ")}>` : type.name;
    case "array":
      return `${type.readonly === false ? "" : "readonly "}${element(type.element)}[]`;
    case "union":
      return type.members
        .map((member) => (member.kind === "function" ? `(${typeText(member)})` : typeText(member)))
        .join(" | ");
    case "record": {
      if (type.fields.length === 0) return "{}";
      const fields = type.fields.map(
        (field) =>
          `${field.readonly ? "readonly " : ""}${field.name}${field.optional ? "?" : ""}: ${typeText(field.type)}`,
      );
      return `{ ${fields.join("; ")} }`;
    }
    case "function": {
      const params = type.params.map(
        (param) => `${param.name}${param.optional ? "?" : ""}: ${typeText(param.type)}`,
      );
      return `(${params.join(", ")}) => ${typeText(type.result)}`;
    }
    case "literal":
      return typeof type.value === "string" ? JSON.stringify(type.value) : String(type.value);
    case "tuple":
      return `[${type.elements.map(typeText).join(", ")}]`;
  }
};
