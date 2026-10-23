import { DatabaseSync } from "node:sqlite";

type Input = null | number | bigint | string | Uint8Array;

type Binding =
  | { readonly name: string; readonly kind: "param" }
  | { readonly name: string; readonly kind: "literal"; readonly value: string | number };

type Query = {
  readonly name: string;
  readonly sql: string;
  readonly kind: "first" | "all" | "count";
  readonly params: readonly string[];
  readonly bindings: readonly Binding[];
};

export type RuntimeSchema = { readonly ddl: string; readonly queries: readonly Query[] };

export type RuntimeDatabase = {
  readonly sql: string;
  exec(sql: string): void;
  close(): void;
} & Record<string, (params?: Record<string, unknown>) => unknown>;

const normalize = (row: unknown): Record<string, unknown> | undefined =>
  row === undefined || row === null ? undefined : { ...(row as Record<string, unknown>) };

const valuesFor = (query: Query, params: Record<string, unknown>): Record<string, Input> => {
  const values: Record<string, Input> = {};
  for (const binding of query.bindings) {
    values[binding.name] = binding.kind === "param" ? (params[binding.name] ?? null) as Input : binding.value;
  }
  return values;
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
        const values = valuesFor(query, params);
        if (query.kind === "all") return statement.all(values).map((row) => normalize(row));
        if (query.kind === "count") {
          const row = statement.get(values) as Record<string, unknown> | undefined;
          return Number(row?.count ?? 0);
        }
        return normalize(statement.get(values));
      };
    }
    return api;
  },
});
