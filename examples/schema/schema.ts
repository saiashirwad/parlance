import { readFileSync } from "node:fs";
import { type Binding, type Checker, isError } from "../../src/check/index.ts";
import { compileGrammar } from "../../src/grammar/compile.ts";
import { parseGrammar } from "../../src/grammar/parse.ts";
import { defineLanguage, importSpecifier } from "../../src/language.ts";
import { runtimeModule } from "../../src/runtime/index.ts";
import type { Text } from "../../src/source.ts";
import { source, ts } from "../../src/ts/index.ts";
import type {
  Attribute,
  Base,
  DefaultValue,
  Delete,
  Direction,
  Enum,
  Field,
  File,
  Insert,
  Literal,
  Model,
  MutationValue,
  Param,
  Query,
  Stage,
  TypeRef,
  Update,
  Value,
} from "./schema.ast.ts";

const sourceText = readFileSync(new URL("./schema.parl", import.meta.url), "utf8");
const parsed = parseGrammar(sourceText, "schema.parl");
if (!parsed.ok) throw new Error(parsed.diagnostics.map((entry) => entry.message).join("\n"));
const grammar = compileGrammar<File>(parsed.file, "schema.parl");
if (!grammar.valid) throw new Error(grammar.diagnostics.map((entry) => entry.message).join("\n"));

const reserved = new Set(
  ("break case catch class const continue debugger default delete do else enum export extends false finally for "
    + "function if import in instanceof new null return super switch this throw true try typeof var void while with "
    + "yield let static implements interface package private protected public await Database open sql close").split(" "),
);

const scalarList = ["Int", "String", "Bool", "DateTime"] as const;
const scalarNames = new Set<string>(scalarList);
const attributeList = ["primary", "auto", "unique", "default"] as const;
const attributeNames = new Set<string>(attributeList);

type Scalar = (typeof scalarList)[number];

type SchemaType =
  | { readonly kind: "scalar"; readonly name: Scalar }
  | { readonly kind: "enum"; readonly name: string; readonly members: readonly string[] }
  | { readonly kind: "model"; readonly name: string };

type MutationKind = "insert" | "update" | "delete";

type MutationSignature = {
  readonly kind: "mutation";
  readonly mutation: MutationKind;
  readonly model: string;
  readonly params: readonly ParamIR[];
};

type QuerySignature = {
  readonly kind: "query";
  readonly params: readonly ParamIR[];
  readonly result: ResultIR;
};

type Checked = SchemaType | QuerySignature | MutationSignature;

type TypeRefValue = { readonly base: Base; readonly list: boolean; readonly nullable: boolean };

type DefaultIR =
  | { readonly kind: "now" }
  | { readonly kind: "literal"; readonly value: string | number };

type FieldIR = {
  readonly name: Text;
  readonly typeName: Text;
  readonly type: SchemaType;
  readonly nullable: boolean;
  readonly primary: boolean;
  readonly auto: boolean;
  readonly unique: boolean;
  readonly defaultValue: DefaultIR | null;
  readonly binding: Binding<Checked>;
};

type ModelIR = {
  readonly name: Text;
  readonly fields: readonly FieldIR[];
  readonly primary: FieldIR | null;
  readonly binding: Binding<Checked>;
};

type EnumIR = {
  readonly name: Text;
  readonly members: readonly { readonly name: Text; readonly binding: Binding<Checked> }[];
  readonly binding: Binding<Checked>;
};

type ParamIR = {
  readonly name: Text;
  readonly typeName: Text;
  readonly type: SchemaType;
  readonly nullable: boolean;
  readonly optional: boolean;
  readonly binding: Binding<Checked>;
};

type Bound =
  | { readonly sqlName: string; readonly kind: "param"; readonly name: string }
  | { readonly sqlName: string; readonly kind: "literal"; readonly value: string | number };

type StageIR =
  | { readonly kind: "where"; readonly field: FieldIR; readonly bound: Bound }
  | { readonly kind: "order"; readonly field: FieldIR; readonly direction: "asc" | "desc" }
  | { readonly kind: "limit"; readonly bound: Bound }
  | { readonly kind: "terminal"; readonly terminal: "first" | "all" | "count" };

type ResultIR = {
  readonly type: SchemaType;
  readonly typeName: Text | null;
  readonly list: boolean;
  readonly nullable: boolean;
};

type QueryIR = {
  readonly name: Text;
  readonly params: readonly ParamIR[];
  readonly source: ModelIR;
  readonly stages: readonly StageIR[];
  readonly result: ResultIR;
  readonly binding: Binding<Checked>;
};

type MutationAssignmentIR = {
  readonly field: FieldIR;
  readonly bound: Bound;
};

type OptionalFieldIR = {
  readonly field: FieldIR;
  readonly bound: Bound;
};

type MutationIR = {
  readonly kind: MutationKind;
  readonly name: Text;
  readonly model: ModelIR;
  readonly params: readonly ParamIR[];
  readonly assignments: readonly MutationAssignmentIR[];
  readonly where: readonly MutationAssignmentIR[];
  readonly optional: readonly OptionalFieldIR[];
  readonly binding: Binding<Checked>;
};

export type SchemaModule = {
  readonly name: Text;
  readonly enums: readonly EnumIR[];
  readonly models: readonly ModelIR[];
  readonly queries: readonly QueryIR[];
  readonly mutations: readonly MutationIR[];
};

/** `null` for a type the parser reported missing. */
const refValue = (ref: TypeRef): TypeRefValue | null => {
  switch (ref.kind) {
    case "error":
      return null;
    case "list":
      return { base: ref.type, list: true, nullable: false };
    case "optional":
      return { base: ref.type, list: false, nullable: true };
    case "name":
      return { base: ref, list: false, nullable: false };
  }
};

const typeNameOf = (type: SchemaType): string => type.name;

const sameType = (left: SchemaType, right: SchemaType): boolean =>
  left.kind === right.kind && left.name === right.name;

const resolveBase = (
  base: Base,
  enums: ReadonlyMap<string, Enum>,
  models: ReadonlyMap<string, Model>,
  imported: ReadonlyMap<string, SchemaType>,
  bindings: ReadonlyMap<string, Binding<Checked>>,
  cx: Checker<Checked>,
): SchemaType | undefined => {
  const name = base.name.text;
  if (scalarNames.has(name)) return { kind: "scalar", name: name as Scalar };
  const referenced = (type: SchemaType): SchemaType => {
    const binding = bindings.get(name);
    if (binding) cx.reference(binding, base.name);
    return type;
  };
  const enumeration = enums.get(name);
  if (enumeration) {
    return referenced({ kind: "enum", name, members: enumeration.members.map((member) => member.text) });
  }
  if (models.has(name)) return referenced({ kind: "model", name });
  const foreign = imported.get(name);
  if (foreign) {
    cx.imported(name, base.name);
    return foreign;
  }
  cx.error(`Unknown type ${JSON.stringify(name)}`, base.name);
  return undefined;
};

const decodeString = (raw: string): string => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

const schemaTypeText = (type: SchemaType): string => type.name;

const signatureText = (signature: QuerySignature | MutationSignature): string => {
  const params = signature.params.map((param) =>
    `${param.name.text}: ${schemaTypeText(param.type)}${param.nullable ? "?" : ""}${param.optional ? " =" : ""}`
  );
  if (signature.kind === "mutation") {
    return `${signature.mutation} ${signature.model}(${params.join(", ")}) -> Int`;
  }
  const result = signature.result.type.kind === "scalar" && signature.result.type.name === "Int"
    ? "Int"
    : `${signature.result.type.name}${signature.result.list ? "[]" : ""}${signature.result.nullable ? "?" : ""}`;
  return `(${params.join(", ")}) -> ${result}`;
};

const check = (file: File, cx: Checker<Checked>): SchemaModule => {
  const enums = new Map<string, Enum>();
  const models = new Map<string, Model>();
  const queries = new Map<string, Query>();
  const mutations: (Insert | Update | Delete)[] = [];
  const bindings = new Map<string, Binding<Checked>>();
  const names = new Set<string>();
  const importedTypes = new Map<string, SchemaType>();
  const importedEnums: EnumIR[] = [];
  const importedModels: ModelIR[] = [];
  const importedIdentity = new Map<string, string>();

  for (const dependency of cx.dependencies.all) {
    const module = dependency.module as SchemaModule | null;
    if (!module) continue;
    for (const [name, binding] of dependency.exports) {
      const identity = `${binding.uri ?? dependency.uri}:${binding.span.start}:${binding.span.end}`;
      const previous = importedIdentity.get(name);
      if (previous !== undefined && previous !== identity) {
        cx.error(
          `Import ${JSON.stringify(dependency.specifier)} also exports ${JSON.stringify(name)} from a different declaration`,
          dependency.span,
        );
      } else if (previous === undefined) {
        importedIdentity.set(name, identity);
      }
    }
    for (const enumeration of module.enums) {
      if (!importedTypes.has(enumeration.name.text)) {
        const binding = dependency.exports.get(enumeration.name.text) ?? enumeration.binding;
        const type = binding.type;
        importedTypes.set(
          enumeration.name.text,
          type && type.kind === "enum" ? type : {
            kind: "enum",
            name: enumeration.name.text,
            members: enumeration.members.map((member) => member.name.text),
          },
        );
        importedEnums.push({
          ...enumeration,
          members: enumeration.members.map((member) => ({
            ...member,
            binding: cx.alias(member.binding, member.binding.uri ?? dependency.uri),
          })),
          binding,
        });
      }
    }
    for (const model of module.models) {
      if (!importedTypes.has(model.name.text)) {
        const binding = dependency.exports.get(model.name.text) ?? model.binding;
        const type = binding.type;
        importedTypes.set(
          model.name.text,
          type && type.kind === "model" ? type : { kind: "model", name: model.name.text },
        );
        const fields = model.fields.map((field) => ({
          ...field,
          binding: cx.alias(field.binding, field.binding.uri ?? dependency.uri),
        }));
        const primary = model.primary === null
          ? null
          : fields.find((field) => field.name.text === model.primary!.name.text) ?? null;
        importedModels.push({ ...model, fields, primary, binding });
      }
    }
    for (const name of dependency.exports.keys()) {
      cx.imported(name);
      names.add(name);
    }
  }

  const claim = (name: Text, kind: "enum" | "model" | "query" | "mutation", type?: Checked) => {
    if (names.has(name.text)) {
      cx.error(`Duplicate declaration ${JSON.stringify(name.text)}`, name);
      return undefined;
    }
    if (reserved.has(name.text)) {
      cx.error(`${JSON.stringify(name.text)} is reserved`, name);
      return undefined;
    }
    names.add(name.text);
    const binding = cx.declare(
      name.text,
      name.span,
      kind === "enum" ? "enum" : kind === "model" ? "class" : "function",
      type,
      { detail: kind },
    );
    cx.bind(binding);
    bindings.set(name.text, binding);
    return binding;
  };

  for (const declaration of file.declarations) {
    if (declaration.kind === "import") continue;
    if (declaration.kind === "enum") {
      enums.set(declaration.name.text, declaration);
      claim(declaration.name, "enum", {
        kind: "enum",
        name: declaration.name.text,
        members: declaration.members.map((member) => member.text),
      });
    } else if (declaration.kind === "model") {
      models.set(declaration.name.text, declaration);
      claim(declaration.name, "model", { kind: "model", name: declaration.name.text });
    } else if (declaration.kind === "query") {
      queries.set(declaration.name.text, declaration);
      claim(declaration.name, "query");
    } else {
      mutations.push(declaration);
    }
  }

  const enumMembers = new Map<string, Map<string, Binding<Checked>>>();
  const enumIRs: EnumIR[] = [...importedEnums];
  for (const enumeration of importedEnums) {
    enumMembers.set(
      enumeration.name.text,
      new Map(enumeration.members.map((member) => [member.name.text, member.binding])),
    );
  }
  for (const declaration of enums.values()) {
    const type: SchemaType = {
      kind: "enum",
      name: declaration.name.text,
      members: declaration.members.map((member) => member.text),
    };
    const binding = bindings.get(declaration.name.text)!;
    const members: { name: Text; binding: Binding<Checked> }[] = [];
    const seen = new Set<string>();
    const map = new Map<string, Binding<Checked>>();
    for (const member of declaration.members) {
      if (seen.has(member.text)) {
        cx.error(`Duplicate member ${JSON.stringify(member.text)}`, member);
        continue;
      }
      seen.add(member.text);
      const memberBinding = cx.declare(member.text, member.span, "enumMember", type, {
        detail: declaration.name.text,
      });
      cx.typed(member, type);
      members.push({ name: member, binding: memberBinding });
      map.set(member.text, memberBinding);
    }
    enumMembers.set(declaration.name.text, map);
    enumIRs.push({ name: declaration.name, members, binding });
  }

  const checkDefault = (
    value: DefaultValue,
    type: SchemaType,
    attribute: Attribute,
  ): DefaultIR | undefined => {
    if (isError(value)) return undefined;
    if (type.kind === "model") {
      cx.error("Model fields cannot have defaults", attribute);
      return undefined;
    }
    if (value.kind === "defaultName") {
      const name = value.name;
      if (name.text === "now") {
        if (type.kind === "scalar" && type.name === "DateTime") {
          cx.typed(name, type);
          return { kind: "now" };
        }
        cx.error("@default(now) is only valid for DateTime", name);
        return undefined;
      }
      if (type.kind === "scalar" && type.name === "Bool" && (name.text === "true" || name.text === "false")) {
        cx.typed(name, type);
        return { kind: "literal", value: name.text === "true" ? 1 : 0 };
      }
      if (type.kind === "enum") {
        const member = enumMembers.get(type.name)?.get(name.text);
        if (member) {
          cx.reference(member, name);
          cx.typed(name, type);
          return { kind: "literal", value: name.text };
        }
        cx.error(`Unknown enum member ${JSON.stringify(name.text)}`, name);
        return undefined;
      }
      cx.error(`Unknown default ${JSON.stringify(name.text)}`, name);
      return undefined;
    }
    if (type.kind === "scalar" && type.name === "Int" && value.value.kind === "number") {
      cx.typed(value, type);
      return { kind: "literal", value: Number(value.value.value.text) };
    }
    if (
      type.kind === "scalar" && (type.name === "String" || type.name === "DateTime")
      && value.value.kind === "string"
    ) {
      cx.typed(value, type);
      return { kind: "literal", value: decodeString(value.value.value.text) };
    }
    cx.error(`Expected a ${schemaTypeText(type)} default, found a different literal`, value.value);
    return undefined;
  };

  const modelFields = new Map<string, Map<string, FieldIR>>();
  const modelIRs: ModelIR[] = [...importedModels];
  const localModels: ModelIR[] = [];
  for (const model of importedModels) {
    modelFields.set(model.name.text, new Map(model.fields.map((field) => [field.name.text, field])));
  }
  for (const declaration of models.values()) {
    const seen = new Set<string>();
    const fields: FieldIR[] = [];
    let primary: FieldIR | null = null;
    for (const field of declaration.fields) {
      if (seen.has(field.name.text)) {
        cx.error(`Duplicate field ${JSON.stringify(field.name.text)}`, field.name);
        continue;
      }
      seen.add(field.name.text);
      const resolved = refValue(field.type);
      if (!resolved) continue;
      if (resolved.list) {
        cx.error("Fields cannot have list types", field.type);
        continue;
      }
      const type = resolveBase(resolved.base, enums, models, importedTypes, bindings, cx);
      if (!type) continue;
      const attributes = new Map<string, Attribute>();
      for (const attribute of field.attributes) {
        if (attributes.has(attribute.name.text)) {
          cx.error(`Duplicate attribute @${attribute.name.text}`, attribute.name);
          continue;
        }
        attributes.set(attribute.name.text, attribute);
      }
      for (const [name, attribute] of attributes) {
        if (!attributeNames.has(name)) {
          cx.error(`Unknown attribute @${name}`, attribute.name);
          continue;
        }
        if (name !== "default" && attribute.args) {
          cx.error(`@${name} does not take an argument`, attribute.args);
        }
      }
      const primaryFlag = attributes.has("primary");
      const auto = attributes.has("auto");
      const unique = attributes.has("unique");
      if (primaryFlag && resolved.nullable) cx.error("@primary fields cannot be optional", field.type);
      if (primaryFlag && type.kind !== "scalar") cx.error("@primary requires a scalar Int field", field.type);
      if (primaryFlag && type.kind === "scalar" && type.name !== "Int") {
        cx.error("@primary requires an Int field", field.type);
      }
      if (auto && !primaryFlag) cx.error("@auto requires @primary", field.name);
      if (auto && type.kind === "scalar" && type.name !== "Int") cx.error("@auto requires an Int field", field.type);
      const defaultAttribute = attributes.get("default");
      let defaultValue: DefaultIR | null = null;
      if (defaultAttribute) {
        if (primaryFlag || auto) {
          cx.error("Defaults are not allowed on @primary or @auto fields", defaultAttribute);
        } else if (!defaultAttribute.args) {
          cx.error("@default needs an argument", defaultAttribute.name);
        } else {
          defaultValue = checkDefault(defaultAttribute.args, type, defaultAttribute) ?? null;
        }
      }
      if (primaryFlag) {
        if (primary) cx.error("A model can have only one @primary field", field.name);
        else {
          const binding = cx.declare(field.name.text, field.name.span, "property", type, {
            detail: declaration.name.text,
          });
          const value: FieldIR = {
            name: field.name,
            typeName: resolved.base.name,
            type,
            nullable: resolved.nullable,
            primary: true,
            auto,
            unique,
            defaultValue,
            binding,
          };
          primary = value;
          fields.push(value);
          cx.typed(field.name, type);
          cx.typed(field.type, type);
          continue;
        }
      }
      const binding = cx.declare(field.name.text, field.name.span, "property", type, {
        detail: declaration.name.text,
      });
      fields.push({
        name: field.name,
        typeName: resolved.base.name,
        type,
        nullable: resolved.nullable,
        primary: false,
        auto,
        unique,
        defaultValue,
        binding,
      });
      cx.typed(field.name, type);
      cx.typed(field.type, type);
    }
    if (!primary && fields.length > 0) cx.error("A model needs an @primary field", declaration.name);
    const modelBinding = bindings.get(declaration.name.text)!;
    const model: ModelIR = { name: declaration.name, fields, primary, binding: modelBinding };
    modelIRs.push(model);
    localModels.push(model);
    modelFields.set(declaration.name.text, new Map(fields.map((field) => [field.name.text, field])));
  }

  for (const model of localModels) {
    for (const field of model.fields) {
      if (field.type.kind !== "model") continue;
      const target = modelIRs.find((entry) => entry.name.text === field.type.name);
      if (!target) {
        cx.error(`Unknown model ${JSON.stringify(field.type.name)}`, field.typeName);
      } else if (!target.primary) {
        cx.error(`Referenced model ${JSON.stringify(target.name.text)} has no @primary field`, field.typeName);
      }
    }
  }

  const queryIRs: QueryIR[] = [];
  for (const declaration of queries.values()) {
    const binding = bindings.get(declaration.name.text)!;
    const paramNames = new Set<string>();
    const params: ParamIR[] = [];
    const model = modelIRs.find((entry) => entry.name.text === declaration.source.text);
    if (!model) {
      cx.error(`Query source ${JSON.stringify(declaration.source.text)} is not a model`, declaration.source);
      continue;
    }
    const built = cx.scope((): QueryIR => {
    cx.resolve(declaration.source.text, declaration.source);
    const fields = modelFields.get(model.name.text)!;
    let counter = 0;
    const boundName = () => `lit${counter++}`;

    const parameter = (param: Param) => {
      if (paramNames.has(param.name.text)) {
        cx.error(`Duplicate parameter ${JSON.stringify(param.name.text)}`, param.name);
        return undefined;
      }
      paramNames.add(param.name.text);
      const resolved = refValue(param.type);
      if (!resolved) return undefined;
      if (resolved.list) {
        cx.error("Query parameters cannot be lists", param.type);
        return undefined;
      }
      const type = resolveBase(resolved.base, enums, models, importedTypes, bindings, cx);
      if (!type) return undefined;
      const paramBinding = cx.declare(param.name.text, param.name.span, "parameter", type, { detail: "parameter" });
      cx.typed(param.name, type);
      cx.typed(param.type, type);
      return {
        name: param.name,
        typeName: resolved.base.name,
        type,
        nullable: resolved.nullable,
        optional: false,
        binding: paramBinding,
      } satisfies ParamIR;
    };

    const resolveValue = (
      value: Value,
      expected: SchemaType,
      scope: ReadonlyMap<string, Binding<Checked>>,
    ): Bound | undefined => {
      if (isError(value)) return undefined;
      if (value.kind === "paramRef") {
        const name = value.value;
        const param = scope.get(name.text);
        if (param && param.type && param.type.kind !== "query" && param.type.kind !== "mutation") {
          if (!sameType(param.type, expected)) {
            cx.error(
              `Cannot compare ${schemaTypeText(expected)} with ${schemaTypeText(param.type)}`,
              name,
            );
            return undefined;
          }
          cx.reference(param, name);
          cx.typed(name, param.type);
          return { sqlName: name.text, kind: "param", name: name.text };
        }
        if (expected.kind === "enum") {
          const member = enumMembers.get(expected.name)?.get(name.text);
          if (member) {
            cx.reference(member, name);
            cx.typed(name, expected);
            return { sqlName: boundName(), kind: "literal", value: name.text };
          }
        }
        cx.error(`Unknown value ${JSON.stringify(name.text)}`, name);
        return undefined;
      }
      if (expected.kind === "scalar" && expected.name === "Int" && value.value.kind === "number") {
        const number = Number(value.value.value.text);
        cx.typed(value, expected);
        return { sqlName: boundName(), kind: "literal", value: number };
      }
      if (
        expected.kind === "scalar" && (expected.name === "String" || expected.name === "DateTime")
        && value.value.kind === "string"
      ) {
        cx.typed(value, expected);
        return { sqlName: boundName(), kind: "literal", value: decodeString(value.value.value.text) };
      }
      cx.error(`Expected ${schemaTypeText(expected)}, found a different literal`, value);
      return undefined;
    };

    const scope = new Map<string, Binding<Checked>>();
    for (const param of declaration.params) {
      const value = parameter(param);
      if (value) {
        params.push(value);
        scope.set(value.name.text, value.binding);
        cx.bind(value.binding);
      }
    }

    let terminal: "first" | "all" | "count" | null = null;
    // `|>` with a missing terminal: the parser reported it, so do not ask for one again.
    let missingTerminal = false;
    let limit: StageIR | null = null;
    const stages: StageIR[] = [];
    declaration.stages.forEach((stage, index) => {
      switch (stage.kind) {
        case "where": {
          const field = fields.get(stage.field.text);
          if (!field) {
            cx.error(`Unknown field ${JSON.stringify(stage.field.text)}`, stage.field);
            break;
          }
          cx.reference(field.binding, stage.field);
          cx.typed(stage.field, field.type);
          const value = resolveValue(stage.value, field.type, scope);
          if (value) stages.push({ kind: "where", field, bound: value });
          break;
        }
        case "order": {
          const field = fields.get(stage.field.text);
          if (!field) {
            cx.error(`Unknown field ${JSON.stringify(stage.field.text)}`, stage.field);
            break;
          }
          cx.reference(field.binding, stage.field);
          cx.typed(stage.field, field.type);
          const direction = stage.direction?.kind === "desc" ? "desc" : "asc";
          stages.push({ kind: "order", field, direction });
          break;
        }
        case "limit": {
          if (limit) {
            cx.error("A query can have only one limit", stage);
            break;
          }
          const value = resolveValue(stage.value, { kind: "scalar", name: "Int" }, scope);
          if (value) {
            limit = { kind: "limit", bound: value };
            stages.push(limit);
          }
          break;
        }
        case "terminal": {
          if (terminal) {
            cx.error("A query can have only one terminal", stage);
            break;
          }
          if (index !== declaration.stages.length - 1) {
            cx.error("The terminal must be the last stage", stage);
          }
          if (isError(stage.terminal)) {
            missingTerminal = true;
            break;
          }
          terminal = stage.terminal.kind;
          stages.push({ kind: "terminal", terminal });
          break;
        }
      }
    });

    if (!terminal && !missingTerminal) {
      cx.error("A query needs a terminal stage: first, all, or count", declaration.name);
    }

    const declared = refValue(declaration.result);
    const declaredBase = declared && resolveBase(declared.base, enums, models, importedTypes, bindings, cx);
    const computed: ResultIR = terminal === "count"
      ? {
        type: { kind: "scalar", name: "Int" },
        typeName: null,
        list: false,
        nullable: false,
      }
      : {
        type: { kind: "model", name: model.name.text },
        typeName: declaration.source,
        list: terminal === "all",
        nullable: terminal === "first",
      };

    if (declaredBase && terminal) {
      const same = sameType(declaredBase, computed.type) && declared!.list === computed.list
        && declared!.nullable === computed.nullable;
      if (!same) {
        const expected = computed.list
          ? `${computed.type.name}[]`
          : `${computed.type.name}${computed.nullable ? "?" : ""}`;
        cx.error(`Query result is ${expected}`, declaration.result);
      }
    }

    const signature: QuerySignature = { kind: "query", params, result: computed };
    cx.typed(declaration.name, signature);
    return {
      name: declaration.name,
      params,
      source: model,
      stages,
      result: computed,
      binding,
    };
    });
    queryIRs.push(built);
  }

  const modelByName = new Map(modelIRs.map((model) => [model.name.text, model]));
  const mutationIRs: MutationIR[] = [];

  for (const declaration of mutations) {
    const kind = declaration.kind;
    const model = modelByName.get(declaration.model.text);
    if (!model) {
      cx.error(`Unknown model ${JSON.stringify(declaration.model.text)}`, declaration.model);
      continue;
    }
    cx.resolve(model.name.text, declaration.model);
    const fields = modelFields.get(model.name.text)!;
    const params: ParamIR[] = [];
    const paramMap = new Map<string, ParamIR>();
    let sqlCounter = 0;
    const nextSqlName = () => `v${sqlCounter++}`;

    const paramOf = (name: Text, field: FieldIR): ParamIR | undefined => {
      const existing = paramMap.get(name.text);
      if (existing) {
        if (!sameType(existing.type, field.type)) {
          cx.error(
            `Parameter ${JSON.stringify(name.text)} is used for both ${schemaTypeText(existing.type)} and ${
              schemaTypeText(field.type)
            }`,
            name,
          );
          return undefined;
        }
        cx.reference(existing.binding, name);
        cx.typed(name, field.type);
        return existing;
      }
      const binding = cx.declare(name.text, name.span, "parameter", field.type, { detail: "parameter" });
      cx.typed(name, field.type);
      const param: ParamIR = {
        name,
        typeName: field.typeName,
        type: field.type,
        nullable: field.nullable,
        optional: false,
        binding,
      };
      paramMap.set(name.text, param);
      params.push(param);
      return param;
    };

    const valueOf = (value: MutationValue, field: FieldIR): Bound | undefined => {
      if (isError(value)) return undefined;
      if (value.kind === "bind") {
        const param = paramOf(value.name, field);
        return param ? { sqlName: nextSqlName(), kind: "param", name: param.name.text } : undefined;
      }
      if (value.kind === "literal") {
        if (field.type.kind === "scalar" && field.type.name === "Int" && value.value.kind === "number") {
          cx.typed(value, field.type);
          return { sqlName: nextSqlName(), kind: "literal", value: Number(value.value.value.text) };
        }
        if (field.type.kind === "model" && value.value.kind === "number") {
          cx.typed(value, field.type);
          return { sqlName: nextSqlName(), kind: "literal", value: Number(value.value.value.text) };
        }
        if (
          field.type.kind === "scalar" && (field.type.name === "String" || field.type.name === "DateTime")
          && value.value.kind === "string"
        ) {
          cx.typed(value, field.type);
          return { sqlName: nextSqlName(), kind: "literal", value: decodeString(value.value.value.text) };
        }
        if (field.type.kind === "enum" && value.value.kind === "string") {
          const decoded = decodeString(value.value.value.text);
          const member = enumMembers.get(field.type.name)?.get(decoded);
          if (member) {
            cx.reference(member, value.value.value);
            cx.typed(value, field.type);
            return { sqlName: nextSqlName(), kind: "literal", value: decoded };
          }
        }
        cx.error(`Expected ${schemaTypeText(field.type)}, found a different literal`, value.value);
        return undefined;
      }
      const name = value.name;
      if (field.type.kind === "enum") {
        const member = enumMembers.get(field.type.name)?.get(name.text);
        if (member) {
          cx.reference(member, name);
          cx.typed(name, field.type);
          return { sqlName: nextSqlName(), kind: "literal", value: name.text };
        }
        cx.error(`Unknown enum member ${JSON.stringify(name.text)}`, name);
        return undefined;
      }
      if (field.type.kind === "scalar" && field.type.name === "Bool") {
        if (name.text === "true" || name.text === "false") {
          cx.typed(name, field.type);
          return { sqlName: nextSqlName(), kind: "literal", value: name.text === "true" ? 1 : 0 };
        }
        cx.error("Expected Bool, found a name", name);
        return undefined;
      }
      cx.error(`Expected ${schemaTypeText(field.type)}, found ${JSON.stringify(name.text)}`, name);
      return undefined;
    };

    const claimMutation = (signature: MutationSignature): Binding<Checked> | undefined => {
      const name: Text = { text: `${kind}${model.name.text}`, span: declaration.model.span };
      return claim(name, "mutation", signature);
    };

    let assignments: MutationAssignmentIR[] = [];
    let where: MutationAssignmentIR[] = [];
    let optional: OptionalFieldIR[] = [];
    let sawWhere = false;
    let sawSet = false;

    if (declaration.kind === "insert") {
      const assigned = new Map<string, MutationAssignmentIR>();
      const mentioned = new Set<string>();
      for (const assignment of declaration.assignments) {
        const field = fields.get(assignment.field.text);
        if (!field) {
          cx.error(`Unknown field ${JSON.stringify(assignment.field.text)}`, assignment.field);
          continue;
        }
        mentioned.add(field.name.text);
        if (assigned.has(field.name.text)) {
          cx.error(`Duplicate assignment to ${JSON.stringify(field.name.text)}`, assignment.field);
          continue;
        }
        if (field.auto) {
          cx.error(`The @auto primary field ${JSON.stringify(field.name.text)} is generated; omit it`, assignment.field);
          continue;
        }
        cx.reference(field.binding, assignment.field);
        cx.typed(assignment.field, field.type);
        const bound = valueOf(assignment.value, field);
        if (bound) assigned.set(field.name.text, { field, bound });
      }
      assignments = model.fields.flatMap((field) => {
        const found = assigned.get(field.name.text);
        return found ? [found] : [];
      });
      for (const field of model.fields) {
        if (mentioned.has(field.name.text) || field.auto) continue;
        if (!field.nullable && !field.defaultValue) {
          cx.error(
            `Insert ${model.name.text} is missing required field ${JSON.stringify(field.name.text)}`,
            declaration.model,
          );
          continue;
        }
        if (paramMap.has(field.name.text)) {
          cx.error(
            `Optional insert field ${JSON.stringify(field.name.text)} collides with parameter ${
              JSON.stringify(field.name.text)
            }`,
            field.name,
          );
          continue;
        }
        optional.push({
          field,
          bound: { sqlName: nextSqlName(), kind: "param", name: field.name.text },
        });
      }
    } else if (declaration.kind === "update") {
      const whereMap = new Map<string, MutationAssignmentIR>();
      const setMap = new Map<string, MutationAssignmentIR>();
      for (const stage of declaration.stages) {
        if (stage.kind === "updateWhere") {
          sawWhere = true;
          const field = fields.get(stage.field.text);
          if (!field) {
            cx.error(`Unknown field ${JSON.stringify(stage.field.text)}`, stage.field);
            continue;
          }
          if (whereMap.has(field.name.text)) {
            cx.error(`Duplicate where field ${JSON.stringify(field.name.text)}`, stage.field);
            continue;
          }
          cx.reference(field.binding, stage.field);
          cx.typed(stage.field, field.type);
          const bound = valueOf(stage.value, field);
          if (bound) whereMap.set(field.name.text, { field, bound });
        } else {
          sawSet = true;
          for (const assignment of stage.assignments) {
            const field = fields.get(assignment.field.text);
            if (!field) {
              cx.error(`Unknown field ${JSON.stringify(assignment.field.text)}`, assignment.field);
              continue;
            }
            if (setMap.has(field.name.text)) {
              cx.error(`Duplicate assignment to ${JSON.stringify(field.name.text)}`, assignment.field);
              continue;
            }
            if (field.primary) {
              cx.error(`The @primary field ${JSON.stringify(field.name.text)} cannot be updated`, assignment.field);
              continue;
            }
            cx.reference(field.binding, assignment.field);
            cx.typed(assignment.field, field.type);
            const bound = valueOf(assignment.value, field);
            if (bound) setMap.set(field.name.text, { field, bound });
          }
        }
      }
      where = model.fields.flatMap((field) => {
        const found = whereMap.get(field.name.text);
        return found ? [found] : [];
      });
      assignments = model.fields.flatMap((field) => {
        const found = setMap.get(field.name.text);
        return found ? [found] : [];
      });
      if (!sawWhere) cx.error(`Update ${model.name.text} needs a where stage`, declaration.model);
      if (!sawSet) cx.error(`Update ${model.name.text} needs a set stage`, declaration.model);
    } else {
      const whereMap = new Map<string, MutationAssignmentIR>();
      for (const stage of declaration.stages) {
        sawWhere = true;
        const field = fields.get(stage.field.text);
        if (!field) {
          cx.error(`Unknown field ${JSON.stringify(stage.field.text)}`, stage.field);
          continue;
        }
        if (whereMap.has(field.name.text)) {
          cx.error(`Duplicate where field ${JSON.stringify(field.name.text)}`, stage.field);
          continue;
        }
        cx.reference(field.binding, stage.field);
        cx.typed(stage.field, field.type);
        const bound = valueOf(stage.value, field);
        if (bound) whereMap.set(field.name.text, { field, bound });
      }
      where = model.fields.flatMap((field) => {
        const found = whereMap.get(field.name.text);
        return found ? [found] : [];
      });
      if (!sawWhere) cx.error(`Delete ${model.name.text} needs a where stage`, declaration.model);
    }

    const signature: MutationSignature = { kind: "mutation", mutation: kind, model: model.name.text, params };
    const binding = claimMutation(signature);
    if (!binding) continue;
    mutationIRs.push({
      kind,
      name: { text: binding.name, span: binding.span },
      model,
      params,
      assignments,
      where,
      optional,
      binding,
    });
  }

  // Bindings are created in hoisting order and scopes are already closed; nothing else to release.
  const module: SchemaModule = {
    name: file.name,
    enums: enumIRs,
    models: modelIRs,
    queries: queryIRs,
    mutations: mutationIRs,
  };
  return module;
};

const display = (type: SchemaType): string => type.name;

const fieldTs = (field: FieldIR): string => {
  const base = field.type.kind === "model"
    ? "number"
    : field.type.kind === "enum"
    ? field.type.name
    : field.type.name === "Int"
    ? "number"
    : field.type.name === "Bool"
    ? "boolean"
    : "string";
  return field.nullable ? `${base} | null` : base;
};

const valueTs = (type: SchemaType): string => {
  if (type.kind === "model") return type.name;
  if (type.kind === "enum") return type.name;
  if (type.name === "Int") return "number";
  if (type.name === "Bool") return "boolean";
  return "string";
};

const paramTs = (param: ParamIR): string => {
  const base = param.type.kind === "model" ? "number" : valueTs(param.type);
  return param.nullable ? `${base} | null` : base;
};

const resultTs = (result: ResultIR): string => {
  const base = valueTs(result.type);
  if (result.list) return `readonly ${base}[]`;
  return result.nullable ? `${base} | undefined` : base;
};

const paramObjectTs = (params: readonly ParamIR[]): string =>
  `{ ${params.map((param) => `readonly ${param.name.text}: ${paramTs(param)}; `).join("")}}`;

const mutationParams = (mutation: MutationIR, assignments: readonly MutationAssignmentIR[]): readonly ParamIR[] => {
  const found: ParamIR[] = [];
  for (const assignment of assignments) {
    const bound = assignment.bound;
    if (bound.kind !== "param") continue;
    const param = mutation.params.find((entry) => entry.name.text === bound.name);
    if (param && !found.some((entry) => entry.name.text === param.name.text)) found.push(param);
  }
  return found;
};

const mutationTs = (mutation: MutationIR): string => {
  const name = mutation.name.text;
  if (mutation.kind === "insert") {
    const params = [
      ...mutation.params.map((param) => `readonly ${param.name.text}: ${paramTs(param)}; `),
      ...mutation.optional.map((entry) => `readonly ${entry.field.name.text}?: ${fieldTs(entry.field)}; `),
    ].join("");
    return `  ${name}(params: { ${params}}): number;\n`;
  }
  if (mutation.kind === "update") {
    return `  ${name}(params: { readonly where: ${
      paramObjectTs(mutationParams(mutation, mutation.where))
    }; readonly set: ${paramObjectTs(mutationParams(mutation, mutation.assignments))} }): number;\n`;
  }
  return `  ${name}(params: ${paramObjectTs(mutationParams(mutation, mutation.where))}): number;\n`;
};

const types = (module: SchemaModule) => {
  const name = (value: Text, foreign: boolean) => foreign ? value.text : source(value);
  return ts`${
    module.enums.map((enumeration) =>
      ts`export type ${name(enumeration.name, enumeration.binding.uri !== undefined)} = ${
        enumeration.members.map((member, index) =>
          ts`${index ? " | " : ""}"${name(member.name, enumeration.binding.uri !== undefined)}"`
        )
      };
`
    )
  }${
    module.models.map((model) => {
      const foreign = model.binding.uri !== undefined;
      return ts`export interface ${name(model.name, foreign)} {
${
        model.fields.map((field) => ts`  readonly ${name(field.name, foreign)}: ${fieldTs(field)};
`)
      }}
`;
    })
  }export interface Database {
  readonly sql: string;
  exec(sql: string): void;
  close(): void;
${
  module.queries.map((query) =>
    ts`  ${source(query.name)}(params: ${
      ts`{ ${
        query.params.map((param) => ts`readonly ${source(param.name)}: ${paramTs(param)}; `)
      }}`
    }): ${resultTs(query.result)};
`
  )
}${
  module.mutations.map((mutation) => mutationTs(mutation))
}}
export declare const sql: string;
export declare function open(database?: string): Database;
`;
};

type RuntimeBinding =
  | { readonly sqlName: string; readonly kind: "param"; readonly name: string }
  | { readonly sqlName: string; readonly kind: "literal"; readonly value: string | number };

type RuntimeQuery = {
  readonly name: string;
  readonly sql: string;
  readonly kind: "first" | "all" | "count";
  readonly params: readonly string[];
  readonly bindings: readonly RuntimeBinding[];
};

type RuntimeMutation = {
  readonly name: string;
  readonly kind: MutationKind;
  readonly sql: string;
  readonly params: readonly string[];
  readonly bindings: readonly RuntimeBinding[];
  readonly table: string | null;
  readonly columns: readonly (RuntimeBinding & { readonly column: string; readonly optional: boolean })[];
};

const quote = (name: string): string => `"${name.replaceAll("\"", "\"\"")}"`;

const sqlType = (type: SchemaType): string => {
  if (type.kind === "scalar") return type.name === "Int" || type.name === "Bool" ? "INTEGER" : "TEXT";
  if (type.kind === "enum") return "TEXT";
  return "INTEGER";
};

const defaultSql = (value: DefaultIR): string => {
  if (value.kind === "now") return "CURRENT_TIMESTAMP";
  return typeof value.value === "string" ? `'${value.value.replaceAll("'", "''")}'` : String(value.value);
};

const ddl = (module: SchemaModule): string =>
  module.models.map((model) => {
    const columns = model.fields.map((field) => {
      const parts = [quote(field.name.text), sqlType(field.type)];
      if (field.primary) {
        parts.push("PRIMARY KEY");
        if (field.auto) parts.push("AUTOINCREMENT");
      }
      if (!field.nullable && !field.primary) parts.push("NOT NULL");
      if (field.unique && !field.primary) parts.push("UNIQUE");
      if (field.defaultValue) parts.push(`DEFAULT ${defaultSql(field.defaultValue)}`);
      if (field.type.kind === "model") {
        const target = module.models.find((entry) => entry.name.text === field.type.name);
        if (target?.primary) {
          parts.push(`REFERENCES ${quote(target.name.text)}(${quote(target.primary.name.text)})`);
        }
      }
      return `  ${parts.join(" ")}`;
    });
    return `CREATE TABLE ${quote(model.name.text)} (\n${columns.join(",\n")}\n);`;
  }).join("\n\n");

const querySql = (module: SchemaModule, query: QueryIR): string => {
  const model = query.source;
  const terminal = query.stages.find((stage) => stage.kind === "terminal");
  const kind = terminal?.kind === "terminal" ? terminal.terminal : "all";
  const select = kind === "count"
    ? `SELECT COUNT(*) AS "count"`
    : `SELECT ${model.fields.map((field) => quote(field.name.text)).join(", ")}`;
  const parts = [`${select}`, `FROM ${quote(model.name.text)}`];
  const where = query.stages.filter((stage) => stage.kind === "where");
  if (where.length) {
    parts.push(
      `WHERE ${
        where.map((stage) => stage.kind === "where" ? `${quote(stage.field.name.text)} = :${stage.bound.sqlName}` : "")
          .join(" AND ")
      }`,
    );
  }
  const order = query.stages.filter((stage) => stage.kind === "order");
  if (order.length) {
    parts.push(
      `ORDER BY ${
        order.map((stage) => stage.kind === "order" ? `${quote(stage.field.name.text)} ${stage.direction.toUpperCase()}` : "")
          .join(", ")
      }`,
    );
  }
  const limit = query.stages.find((stage) => stage.kind === "limit");
  if (limit?.kind === "limit") parts.push(`LIMIT :${limit.bound.sqlName}`);
  else if (kind === "first") parts.push("LIMIT 1");
  return parts.join("\n");
};

const queryKind = (query: QueryIR): "first" | "all" | "count" => {
  const terminal = query.stages.find((stage) => stage.kind === "terminal");
  return terminal?.kind === "terminal" ? terminal.terminal : "all";
};

const asRuntimeBinding = (bound: Bound): RuntimeBinding => bound.kind === "param"
  ? { sqlName: bound.sqlName, kind: "param", name: bound.name }
  : { sqlName: bound.sqlName, kind: "literal", value: bound.value };

const runtimeQueries = (module: SchemaModule): RuntimeQuery[] =>
  module.queries.map((query) => {
    const bindings: RuntimeBinding[] = [];
    for (const stage of query.stages) {
      if (stage.kind === "where" || stage.kind === "limit") bindings.push(asRuntimeBinding(stage.bound));
    }
    return {
      name: query.name.text,
      sql: querySql(module, query),
      kind: queryKind(query),
      params: query.params.map((param) => param.name.text),
      bindings,
    };
  });

const mutationSql = (mutation: MutationIR): string => {
  const table = quote(mutation.model.name.text);
  if (mutation.kind === "insert") {
    if (mutation.assignments.length === 0) return `INSERT INTO ${table} DEFAULT VALUES`;
    return `INSERT INTO ${table} (${
      mutation.assignments.map((entry) => quote(entry.field.name.text)).join(", ")
    }) VALUES (${mutation.assignments.map((entry) => `:${entry.bound.sqlName}`).join(", ")})`;
  }
  const where = mutation.where.map((entry) => `${quote(entry.field.name.text)} = :${entry.bound.sqlName}`)
    .join(" AND ");
  if (mutation.kind === "update") {
    const set = mutation.assignments.map((entry) => `${quote(entry.field.name.text)} = :${entry.bound.sqlName}`)
      .join(", ");
    return `UPDATE ${table}\nSET ${set}\nWHERE ${where}`;
  }
  return `DELETE FROM ${table}\nWHERE ${where}`;
};

const runtimeMutations = (module: SchemaModule): RuntimeMutation[] =>
  module.mutations.map((mutation) => {
    const columns: RuntimeMutation["columns"][number][] = [];
    if (mutation.kind === "insert") {
      const assigned = new Map(mutation.assignments.map((entry) => [entry.field.name.text, entry]));
      const optional = new Map(mutation.optional.map((entry) => [entry.field.name.text, entry]));
      for (const field of mutation.model.fields) {
        const entry = assigned.get(field.name.text);
        if (entry) {
          columns.push({ ...asRuntimeBinding(entry.bound), column: field.name.text, optional: false });
          continue;
        }
        const fallback = optional.get(field.name.text);
        if (fallback) {
          columns.push({ ...asRuntimeBinding(fallback.bound), column: field.name.text, optional: true });
        }
      }
    }
    const bindings = mutation.kind === "insert"
      ? columns.filter((column) => !column.optional).map(({ column, optional, ...binding }) => binding)
      : [...mutation.assignments, ...mutation.where].map((entry) => asRuntimeBinding(entry.bound));
    return {
      name: mutation.name.text,
      kind: mutation.kind,
      sql: mutationSql(mutation),
      params: [
        ...mutation.params.map((param) => param.name.text),
        ...mutation.optional.map((entry) => entry.field.name.text),
      ],
      bindings,
      table: mutation.kind === "insert" ? mutation.model.name.text : null,
      columns,
    };
  });

const runtime = (module: SchemaModule): string =>
  runtimeModule({
    data: { ddl: ddl(module), queries: runtimeQueries(module), mutations: runtimeMutations(module) },
    from: new URL("./runtime.ts", import.meta.url).href,
    imports: ["create"],
    factory: "create(data)",
    exports: {
      sql: "runtime.sql",
      open: "runtime.open",
    },
  });

const sql = (module: SchemaModule): string => [
  "-- generated by parlance",
  ddl(module),
  "",
  ...module.queries.map((query) => `-- ${query.name.text}\n${querySql(module, query)};`),
  ...module.mutations.map((mutation) => `\n-- ${mutation.name.text}\n${mutationSql(mutation)};`),
  "",
].join("\n");

const drizzle = (module: SchemaModule): string => {
  const variable = (name: string) => name.charAt(0).toLowerCase() + name.slice(1);
  const used = new Set<string>();
  for (const model of module.models) {
    let name = variable(model.name.text);
    while (used.has(name)) name += "_";
    used.add(name);
  }
  const names = new Map(module.models.map((model) => [model.name.text, variable(model.name.text)]));
  const enums = module.enums.map((enumeration) =>
    `export const ${variable(enumeration.name.text)} = [${
      enumeration.members.map((member) => JSON.stringify(member.name.text)).join(", ")
    }] as const;\nexport type ${enumeration.name.text} = typeof ${variable(enumeration.name.text)}[number];`
  );
  const tables = module.models.map((model) => {
    const columns = model.fields.map((field) => {
      const type = field.type.kind === "scalar" && field.type.name === "Bool"
        ? `integer(${JSON.stringify(field.name.text)}, { mode: "boolean" })`
        : sqlType(field.type) === "INTEGER"
        ? `integer(${JSON.stringify(field.name.text)})`
        : field.type.kind === "enum"
        ? `text(${JSON.stringify(field.name.text)}).$type<${field.type.name}>()`
        : `text(${JSON.stringify(field.name.text)})`;
      const chain: string[] = [];
      if (field.primary) chain.push(field.auto ? ".primaryKey({ autoIncrement: true })" : ".primaryKey()");
      if (!field.nullable && !field.primary) chain.push(".notNull()");
      if (field.unique && !field.primary) chain.push(".unique()");
      if (field.defaultValue) {
        if (field.defaultValue.kind === "now") chain.push(".default(sql`CURRENT_TIMESTAMP`)");
        else if (field.type.kind === "scalar" && field.type.name === "Bool") {
          chain.push(`.default(${field.defaultValue.value === 1 ? "true" : "false"})`);
        } else if (typeof field.defaultValue.value === "string") {
          chain.push(`.default(${JSON.stringify(field.defaultValue.value)})`);
        } else {
          chain.push(`.default(${field.defaultValue.value})`);
        }
      }
      if (field.type.kind === "model") {
        const target = names.get(field.type.name);
        if (target) chain.push(`.references(() => ${target}.${module.models.find((entry) => entry.name.text === field.type.name)?.primary?.name.text ?? "id"})`);
      }
      return `  ${field.name.text}: ${type}${chain.join("")},`;
    });
    return `export const ${names.get(model.name.text)} = sqliteTable(${JSON.stringify(model.name.text)}, {\n${columns.join("\n")}\n});`;
  });
  const usesNow = module.models.some((model) => model.fields.some((field) => field.defaultValue?.kind === "now"));
  return [
    ...(usesNow ? [`import { sql } from "drizzle-orm";`] : []),
    `import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";`,
    "",
    ...enums,
    "",
    ...tables,
    "",
  ].join("\n");
};

const kysely = (module: SchemaModule): string => [
  `import type { Generated } from "kysely";`,
  "",
  ...module.enums.map((enumeration) =>
    `export type ${enumeration.name.text} = ${
      enumeration.members.map((member) => JSON.stringify(member.name.text)).join(" | ")
    };`
  ),
  "",
  ...module.models.map((model) =>
    `export interface ${model.name.text}Table {\n${
      model.fields.map((field) => {
        const base = field.type.kind === "model"
          ? "number"
          : field.type.kind === "enum"
          ? field.type.name
          : field.type.name === "Int"
          ? "number"
          : field.type.name === "Bool"
          ? "number"
          : "string";
        const generated = (field.primary && field.auto) || field.defaultValue !== null;
        const value = field.nullable ? `${base} | null` : base;
        const type = generated ? `Generated<${value}>` : value;
        return `  readonly ${field.name.text}: ${type};`;
      }).join("\n")
    }\n}`
  ),
  "",
  `export interface DB {`,
  ...module.models.map((model) => `  readonly ${model.name.text}: ${model.name.text}Table;`),
  `}`,
  "",
].join("\n");

export const schema = defineLanguage<File, SchemaModule, Checked>({
  name: "schema",
  extensions: [".schema"],
  grammar,
  check,
  imports: (file) =>
    file.declarations.flatMap((entry) => entry.kind === "import" ? [importSpecifier(entry.specifier)] : []),
  // The runtime module exports `sql` and `open` only, so no declaration is a runtime value.
  exports: (module) =>
    [...module.enums, ...module.models, ...module.queries].map((entry) => ({ ...entry.binding, runtime: false as const })),
  typescript: types,
  runtime,
  show: (type) => type.kind === "query" || type.kind === "mutation" ? signatureText(type) : display(type),
  completions: [
    ...attributeList.map((label) => ({
      label: `@${label}`,
      kind: "keyword" as const,
      detail: "attribute",
      insertText: label,
      filterText: label,
    })),
    ...scalarList.map((label) => ({ label, kind: "type" as const, detail: "scalar" })),
    { label: "now", kind: "constant", detail: "DateTime default" },
    { label: "true", kind: "constant", detail: "Bool literal" },
    { label: "false", kind: "constant", detail: "Bool literal" },
  ],
  describe: (binding) => {
    if (binding.type?.kind === "query" || binding.type?.kind === "mutation") return signatureText(binding.type);
    if (binding.type && binding.detail) return `${binding.detail}.${binding.name}: ${display(binding.type)}`;
    return binding.type ? display(binding.type) : undefined;
  },
  targets: {
    sql: (module) => ({ text: sql(module), fileName: "schema.sql" }),
    drizzle: (module) => ({ text: drizzle(module), fileName: "schema.drizzle.ts" }),
    kysely: (module) => ({ text: kysely(module), fileName: "schema.kysely.ts" }),
  },
});
