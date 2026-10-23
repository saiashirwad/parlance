import { readFileSync } from "node:fs";
import { type Binding, type Checker } from "../../src/check/index.ts";
import { compileGrammar } from "../../src/grammar/compile.ts";
import { parseGrammar } from "../../src/grammar/parse.ts";
import { defineLanguage } from "../../src/language.ts";
import { runtimeModule } from "../../src/runtime/index.ts";
import type { Text } from "../../src/source.ts";
import { source, ts } from "../../src/ts/index.ts";
import type {
  Attribute,
  Base,
  Direction,
  Enum,
  Field,
  File,
  Literal,
  Model,
  Param,
  Query,
  Stage,
  TypeRef,
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

const scalarNames = new Set(["Int", "String", "Bool", "DateTime"]);

type Scalar = "Int" | "String" | "Bool" | "DateTime";

type SchemaType =
  | { readonly kind: "scalar"; readonly name: Scalar }
  | { readonly kind: "enum"; readonly name: string; readonly members: readonly string[] }
  | { readonly kind: "model"; readonly name: string };

type QuerySignature = {
  readonly kind: "query";
  readonly params: readonly ParamIR[];
  readonly result: ResultIR;
};

type Checked = SchemaType | QuerySignature;

type TypeRefValue = { readonly base: Base; readonly list: boolean; readonly nullable: boolean };

type FieldIR = {
  readonly name: Text;
  readonly typeName: Text;
  readonly type: SchemaType;
  readonly nullable: boolean;
  readonly primary: boolean;
  readonly auto: boolean;
  readonly unique: boolean;
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

export type SchemaModule = {
  readonly name: Text;
  readonly enums: readonly EnumIR[];
  readonly models: readonly ModelIR[];
  readonly queries: readonly QueryIR[];
};

const refValue = (ref: TypeRef): TypeRefValue => {
  switch (ref.kind) {
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
  cx: Checker<Checked>,
): SchemaType | undefined => {
  const name = base.name.text;
  if (scalarNames.has(name)) return { kind: "scalar", name: name as Scalar };
  const enumeration = enums.get(name);
  if (enumeration) {
    return { kind: "enum", name, members: enumeration.members.map((member) => member.text) };
  }
  if (models.has(name)) return { kind: "model", name };
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

const signatureText = (signature: QuerySignature): string => {
  const params = signature.params.map((param) => `${param.name.text}: ${schemaTypeText(param.type)}${param.nullable ? "?" : ""}`);
  const result = signature.result.type.kind === "scalar" && signature.result.type.name === "Int"
    ? "Int"
    : `${signature.result.type.name}${signature.result.list ? "[]" : ""}${signature.result.nullable ? "?" : ""}`;
  return `(${params.join(", ")}) -> ${result}`;
};

const check = (file: File, cx: Checker<Checked>): SchemaModule => {
  const enums = new Map<string, Enum>();
  const models = new Map<string, Model>();
  const queries = new Map<string, Query>();
  const bindings = new Map<string, Binding<Checked>>();
  const names = new Set<string>();

  const claim = (name: Text, kind: "enum" | "model" | "query", type?: Checked) => {
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
    } else {
      queries.set(declaration.name.text, declaration);
      claim(declaration.name, "query");
    }
  }

  const enumMembers = new Map<string, Map<string, Binding<Checked>>>();
  const enumIRs: EnumIR[] = [];
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

  const modelFields = new Map<string, Map<string, FieldIR>>();
  const modelIRs: ModelIR[] = [];
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
      if (resolved.list) {
        cx.error("Fields cannot have list types", field.type);
        continue;
      }
      const type = resolveBase(resolved.base, enums, models, cx);
      if (!type) continue;
      const attributes = new Set<string>();
      for (const attribute of field.attributes) {
        if (attributes.has(attribute.name.text)) {
          cx.error(`Duplicate attribute @${attribute.name.text}`, attribute.name);
          continue;
        }
        attributes.add(attribute.name.text);
      }
      for (const name of attributes) {
        if (!["primary", "auto", "unique"].includes(name)) {
          cx.error(`Unknown attribute @${name}`, field.name);
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
        binding,
      });
      cx.typed(field.name, type);
      cx.typed(field.type, type);
    }
    if (!primary && fields.length > 0) cx.error("A model needs an @primary field", declaration.name);
    const modelBinding = bindings.get(declaration.name.text)!;
    const model: ModelIR = { name: declaration.name, fields, primary, binding: modelBinding };
    modelIRs.push(model);
    modelFields.set(declaration.name.text, new Map(fields.map((field) => [field.name.text, field])));
  }

  for (const model of modelIRs) {
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
    const sourceModel = models.get(declaration.source.text);
    const model = modelIRs.find((entry) => entry.name.text === declaration.source.text);
    if (!sourceModel || !model) {
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
      if (resolved.list) {
        cx.error("Query parameters cannot be lists", param.type);
        return undefined;
      }
      const type = resolveBase(resolved.base, enums, models, cx);
      if (!type) return undefined;
      const paramBinding = cx.declare(param.name.text, param.name.span, "parameter", type, { detail: "parameter" });
      cx.typed(param.name, type);
      cx.typed(param.type, type);
      return {
        name: param.name,
        typeName: resolved.base.name,
        type,
        nullable: resolved.nullable,
        binding: paramBinding,
      } satisfies ParamIR;
    };

    const resolveValue = (
      value: Value,
      expected: SchemaType,
      scope: ReadonlyMap<string, Binding<Checked>>,
    ): Bound | undefined => {
      if (value.kind === "paramRef") {
        const name = value.value;
        const param = scope.get(name.text);
        if (param && param.type && param.type.kind !== "query") {
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
          terminal = stage.terminal.kind;
          stages.push({ kind: "terminal", terminal });
          break;
        }
      }
    });

    if (!terminal) {
      cx.error("A query needs a terminal stage: first, all, or count", declaration.name);
    }

    const declared = refValue(declaration.result);
    const declaredBase = resolveBase(declared.base, enums, models, cx);
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
      const same = sameType(declaredBase, computed.type) && declared.list === computed.list
        && declared.nullable === computed.nullable;
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

  // Bindings are created in hoisting order and scopes are already closed; nothing else to release.
  const module: SchemaModule = {
    name: file.name,
    enums: enumIRs,
    models: modelIRs,
    queries: queryIRs,
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
  const base = param.type.kind === "scalar" ? valueTs(param.type) : param.type.name;
  return param.nullable ? `${base} | null` : base;
};

const resultTs = (result: ResultIR): string => {
  const base = valueTs(result.type);
  if (result.list) return `readonly ${base}[]`;
  return result.nullable ? `${base} | undefined` : base;
};

const types = (module: SchemaModule) => ts`${
  module.enums.map((enumeration) =>
    ts`export type ${source(enumeration.name)} = ${
      enumeration.members.map((member, index) => ts`${index ? " | " : ""}"${source(member.name)}"`)
    };
`
  )
}${
  module.models.map((model) =>
    ts`export interface ${source(model.name)} {
${
      model.fields.map((field) => ts`  readonly ${source(field.name)}: ${fieldTs(field)};
`)
    }}
`
  )
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
}}
export declare const sql: string;
export declare function open(database?: string): Database;
`;

type RuntimeQuery = {
  readonly name: string;
  readonly sql: string;
  readonly kind: "first" | "all" | "count";
  readonly params: readonly string[];
  readonly bindings: readonly (
    | { readonly name: string; readonly kind: "param" }
    | { readonly name: string; readonly kind: "literal"; readonly value: string | number }
  )[];
};

const quote = (name: string): string => `"${name.replaceAll("\"", "\"\"")}"`;

const sqlType = (type: SchemaType): string => {
  if (type.kind === "scalar") return type.name === "Int" || type.name === "Bool" ? "INTEGER" : "TEXT";
  if (type.kind === "enum") return "TEXT";
  return "INTEGER";
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

const runtimeQueries = (module: SchemaModule): RuntimeQuery[] =>
  module.queries.map((query) => {
    const bindings: RuntimeQuery["bindings"][number][] = [];
    for (const stage of query.stages) {
      if (stage.kind === "where" || stage.kind === "limit") {
        bindings.push(stage.bound.kind === "param"
          ? { name: stage.bound.sqlName, kind: "param" }
          : { name: stage.bound.sqlName, kind: "literal", value: stage.bound.value });
      }
    }
    return {
      name: query.name.text,
      sql: querySql(module, query),
      kind: queryKind(query),
      params: query.params.map((param) => param.name.text),
      bindings,
    };
  });

const runtime = (module: SchemaModule): string =>
  runtimeModule({
    data: { ddl: ddl(module), queries: runtimeQueries(module) },
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
      if (field.type.kind === "model") {
        const target = names.get(field.type.name);
        if (target) chain.push(`.references(() => ${target}.${module.models.find((entry) => entry.name.text === field.type.name)?.primary?.name.text ?? "id"})`);
      }
      return `  ${field.name.text}: ${type}${chain.join("")},`;
    });
    return `export const ${names.get(model.name.text)} = sqliteTable(${JSON.stringify(model.name.text)}, {\n${columns.join("\n")}\n});`;
  });
  return [
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
        const type = field.primary && field.auto ? `Generated<${base}>` : field.nullable ? `${base} | null` : base;
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
  typescript: types,
  runtime,
  show: (type) => type.kind === "query" ? signatureText(type) : display(type),
  describe: (binding) => {
    if (binding.type?.kind === "query") return signatureText(binding.type);
    if (binding.type && binding.detail) return `${binding.detail}.${binding.name}: ${display(binding.type)}`;
    return binding.type ? display(binding.type) : undefined;
  },
  targets: {
    sql: (module) => ({ text: sql(module), fileName: "schema.sql" }),
    drizzle: (module) => ({ text: drizzle(module), fileName: "schema.drizzle.ts" }),
    kysely: (module) => ({ text: kysely(module), fileName: "schema.kysely.ts" }),
  },
});
