import { DatabaseSync, type StatementSync } from "node:sqlite";

type Input = null | number | bigint | string | Uint8Array;

type Binding =
  | { readonly sqlName: string; readonly kind: "param"; readonly name: string }
  | { readonly sqlName: string; readonly kind: "literal"; readonly value: string | number };

type Query = {
  readonly name: string;
  readonly sql: string;
  readonly kind: "first" | "all" | "count";
  readonly params: readonly string[];
  readonly bindings: readonly Binding[];
};

type InsertColumn = Binding & { readonly column: string; readonly optional: boolean };

type Mutation = {
  readonly name: string;
  readonly kind: "insert" | "update" | "delete";
  readonly sql: string;
  readonly params: readonly string[];
  readonly bindings: readonly Binding[];
  readonly table: string | null;
  readonly columns: readonly InsertColumn[];
};

export type RuntimeSchema = {
  readonly ddl: string;
  readonly queries: readonly Query[];
  readonly mutations: readonly Mutation[];
};

export type RuntimeDatabase = {
  readonly sql: string;
  exec(sql: string): void;
  close(): void;
} & Record<string, (params?: Record<string, unknown>) => unknown>;

const normalize = (row: unknown): Record<string, unknown> | undefined =>
  row === undefined || row === null ? undefined : { ...(row as Record<string, unknown>) };

const valuesFor = (bindings: readonly Binding[], params: Record<string, unknown>): Record<string, Input> => {
  const values: Record<string, Input> = {};
  for (const binding of bindings) {
    values[binding.sqlName] = binding.kind === "param"
      ? (params[binding.name] ?? null) as Input
      : binding.value;
  }
  return values;
};

const quote = (name: string): string => `"${name.replaceAll("\"", "\"\"")}"`;

const insertSql = (table: string, columns: readonly InsertColumn[]): string => {
  if (columns.length === 0) return `INSERT INTO ${quote(table)} DEFAULT VALUES`;
  return `INSERT INTO ${quote(table)} (${columns.map((column) => quote(column.column)).join(", ")}) VALUES (${
    columns.map((column) => `:${column.sqlName}`).join(", ")
  })`;
};

export const create = (schema: RuntimeSchema) => ({
  sql: schema.ddl,
  open(database = ":memory:"): RuntimeDatabase {
    const db = new DatabaseSync(database);
    db.exec(schema.ddl);
    const api: RuntimeDatabase = {
      sql: schema.ddl,
      exec: (sql: string) => db.exec(sql),
      close: () => db.close(),
    } as RuntimeDatabase;
    for (const query of schema.queries) {
      const statement = db.prepare(query.sql);
      api[query.name] = (params: Record<string, unknown> = {}) => {
        const values = valuesFor(query.bindings, params);
        if (query.kind === "all") return statement.all(values).map((row) => normalize(row));
        if (query.kind === "count") {
          const row = statement.get(values) as Record<string, unknown> | undefined;
          return Number(row?.count ?? 0);
        }
        return normalize(statement.get(values));
      };
    }
    for (const mutation of schema.mutations) {
      if (mutation.kind === "update") {
        const statement = db.prepare(mutation.sql);
        api[mutation.name] = (params: Record<string, unknown> = {}) => {
          const where = typeof params.where === "object" && params.where !== null
            ? params.where as Record<string, unknown>
            : {};
          const set = typeof params.set === "object" && params.set !== null
            ? params.set as Record<string, unknown>
            : {};
          return Number(statement.run(valuesFor(mutation.bindings, { ...where, ...set })).changes);
        };
        continue;
      }
      if (mutation.kind === "delete") {
        const statement = db.prepare(mutation.sql);
        api[mutation.name] = (params: Record<string, unknown> = {}) =>
          Number(statement.run(valuesFor(mutation.bindings, params)).changes);
        continue;
      }
      const table = mutation.table ?? "";
      const baseColumns = mutation.columns.filter((column) => !column.optional);
      const base = db.prepare(insertSql(table, baseColumns));
      const extended = new Map<string, StatementSync>();
      api[mutation.name] = (params: Record<string, unknown> = {}) => {
        const supplied = mutation.columns.filter((column) =>
          column.optional && column.kind === "param" && params[column.name] !== undefined
        );
        let statement = base;
        let selected = baseColumns;
        if (supplied.length > 0) {
          selected = mutation.columns.filter((column) =>
            !column.optional || supplied.some((entry) => entry.column === column.column)
          );
          const key = selected.map((column) => column.column).join(",");
          const cached = extended.get(key);
          if (cached) {
            statement = cached;
          } else {
            statement = db.prepare(insertSql(table, selected));
            extended.set(key, statement);
          }
        }
        const result = statement.run(valuesFor(selected, params));
        return Number(result.lastInsertRowid);
      };
    }
    return api;
  },
});
