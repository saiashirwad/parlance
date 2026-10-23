/**
 * The higher-rank type engine for the advanced example.
 *
 * The core's `TypeStore` covers first-order inference. This example needs
 * algebraic data types, row-polymorphic records, and explicit `forall`, so it
 * carries its own small engine. One process-wide store keeps type variables
 * comparable across the modules the Node loader imports.
 */

export type Type =
  | { readonly kind: "number" | "boolean" | "string" }
  | { readonly kind: "function"; readonly param: Type; readonly result: Type }
  | { readonly kind: "record"; readonly row: Row }
  | { readonly kind: "data"; readonly constructor: TypeConstructor; readonly args: readonly Type[] }
  | { readonly kind: "forall"; readonly variables: readonly Generic[]; readonly body: Type }
  | { readonly kind: "skolem"; readonly name: string; readonly id: symbol; readonly level: number }
  | Generic
  | Variable;

export type Generic = { readonly kind: "generic"; readonly name: string; readonly id: symbol };

export type TypeConstructor = {
  readonly id: symbol;
  readonly name: string;
  readonly arity: number;
};

export type Variable = { readonly kind: "variable"; level: number; instance?: Type };

export type RowVariable = {
  readonly kind: "row-variable";
  readonly lacks: Set<string>;
  level: number;
  instance?: Row;
};

export type Row = { readonly fields: ReadonlyMap<string, Type>; readonly tail: RowVariable | null };

export type FreeVariable = Variable | RowVariable;

export type Scheme = { readonly type: Type; readonly variables: ReadonlySet<FreeVariable> };

export const number: Type = { kind: "number" };
export const boolean: Type = { kind: "boolean" };
export const string: Type = { kind: "string" };

export const generic = (name: string): Generic => ({ kind: "generic", name, id: Symbol(name) });

export const data = (constructor: TypeConstructor, args: readonly Type[]): Type => {
  if (constructor.arity !== args.length) {
    throw new Error(`Type ${constructor.name} expects ${constructor.arity} arguments`);
  }
  return { kind: "data", constructor, args };
};

export const forall = (variables: readonly Generic[], body: Type): Type => ({
  kind: "forall",
  variables,
  body,
});

export const fn = (param: Type, result: Type): Type => ({ kind: "function", param, result });

export const record = (row: Row): Type => ({ kind: "record", row });

export const row = (
  fields: ReadonlyMap<string, Type> = new Map(),
  tail: RowVariable | null = null,
): Row => {
  const rest = tail && flatten({ fields: new Map(), tail });
  for (const label of fields.keys()) {
    if (rest && (rest.fields.has(label) || (rest.tail && !rest.tail.lacks.has(label)))) {
      throw new TypeError(`Row tail must lack ${label}`);
    }
  }
  return { fields, tail };
};

export const fresh = (level = 0): Variable => ({ kind: "variable", level });

export const freshRow = (lacks: Iterable<string> = [], level = 0): RowVariable => ({
  kind: "row-variable",
  lacks: new Set(lacks),
  level,
});

export const prune = (type: Type): Type => {
  let current = type;
  if (current.kind !== "variable") return current;
  const seen = new Set<Variable>();
  while (current.kind === "variable" && current.instance) {
    if (seen.has(current)) return current;
    seen.add(current);
    current = current.instance;
  }
  return current;
};

export const flatten = (input: Row): Row => {
  if (!input.tail?.instance) return input;
  const fields = new Map(input.fields);
  let tail: RowVariable | null = input.tail;
  while (tail?.instance) {
    for (const [name, type] of tail.instance.fields) fields.set(name, type);
    tail = tail.instance.tail;
  }
  return row(fields, tail);
};

export const show = (type: Type): string => {
  const variables = new Map<Variable, string>();
  const rows = new Map<RowVariable, string>();
  const visit = (input: Type): string => {
    const value = prune(input);
    if (value.kind === "function") return `(${visit(value.param)} -> ${visit(value.result)})`;
    if (value.kind === "record") {
      const { fields, tail } = flatten(value.row);
      const labels = [...fields]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, field]) => `${name}: ${visit(field)}`);
      if (tail) {
        if (!rows.has(tail)) rows.set(tail, `r${rows.size || ""}`);
        return `{ ${labels.join(", ")}${labels.length ? " " : ""}| ${rows.get(tail)} }`;
      }
      return labels.length ? `{ ${labels.join(", ")} }` : "{}";
    }
    if (value.kind === "generic") return value.name;
    if (value.kind === "skolem") return `^${value.name}`;
    if (value.kind === "forall") {
      return `(forall ${value.variables.map((variable) => variable.name).join(" ")}. ${visit(value.body)})`;
    }
    if (value.kind === "data") {
      return value.constructor.name
        + (value.args.length ? `(${value.args.map(visit).join(", ")})` : "");
    }
    if (value.kind !== "variable") return value.kind;
    if (!variables.has(value)) {
      const index = variables.size;
      variables.set(
        value,
        "abcdefghijklmnopqrstuvwxyz"[index % 26]! + (index >= 26 ? Math.floor(index / 26) : ""),
      );
    }
    return variables.get(value)!;
  };
  const result = visit(type);
  const constraints = [...rows]
    .filter(([variable]) => variable.lacks.size)
    .map(([variable, name]) => `${name} lacks ${[...variable.lacks].sort().join(", ")}`);
  return result + (constraints.length ? ` where ${constraints.join("; ")}` : "");
};

const freeRow = (input: Row, found: Set<FreeVariable>): void => {
  const { fields, tail } = flatten(input);
  for (const type of fields.values()) free(type, found);
  if (tail) found.add(tail);
};

export const free = (type: Type, found = new Set<FreeVariable>()): Set<FreeVariable> => {
  const value = prune(type);
  if (value.kind === "variable") found.add(value);
  else if (value.kind === "function") {
    free(value.param, found);
    free(value.result, found);
  } else if (value.kind === "record") freeRow(value.row, found);
  else if (value.kind === "data") {
    for (const arg of value.args) free(arg, found);
  } else if (value.kind === "forall") free(value.body, found);
  return found;
};

const occurs = (variable: Variable, input: Type): boolean => {
  const type = prune(input);
  switch (type.kind) {
    case "variable":
      return type === variable;
    case "function":
      return occurs(variable, type.param) || occurs(variable, type.result);
    case "record":
      return flatten(type.row).fields.values().some((field) => occurs(variable, field));
    case "data":
      return type.args.some((arg) => occurs(variable, arg));
    case "forall":
      return occurs(variable, type.body);
    default:
      return false;
  }
};

export const mono = (type: Type): Scheme => ({ type, variables: new Set() });

export const generalize = (type: Type, environment: Iterable<Scheme>): Scheme => {
  const variables = free(type);
  for (const scheme of environment) {
    for (const variable of free(scheme.type)) {
      if (!scheme.variables.has(variable)) variables.delete(variable);
    }
  }
  return { type, variables };
};

export const instantiate = (scheme: Scheme, level = 0): Type => {
  if (scheme.variables.size === 0) return scheme.type;
  const replacements = new Map<Variable, Variable>();
  const rows = new Map<RowVariable, RowVariable>();
  const visitRow = (input: Row): Row => {
    const flat = flatten(input);
    let tail = flat.tail;
    if (tail && scheme.variables.has(tail)) {
      if (!rows.has(tail)) rows.set(tail, freshRow(tail.lacks, level));
      tail = rows.get(tail)!;
    }
    return row(
      new Map([...flat.fields].map(([name, type]) => [name, visit(type)])),
      tail,
    );
  };
  const visit = (input: Type): Type => {
    const type = prune(input);
    if (type.kind === "function") return fn(visit(type.param), visit(type.result));
    if (type.kind === "record") return record(visitRow(type.row));
    if (type.kind === "data") return data(type.constructor, type.args.map(visit));
    if (type.kind === "forall") return forall(type.variables, visit(type.body));
    if (type.kind !== "variable" || !scheme.variables.has(type)) return type;
    if (!replacements.has(type)) replacements.set(type, fresh(level));
    return replacements.get(type)!;
  };
  return visit(scheme.type);
};

const substitute = (type: Type, replacements: ReadonlyMap<Generic, Type>): Type => {
  const value = prune(type);
  switch (value.kind) {
    case "generic":
      return replacements.get(value) ?? value;
    case "function":
      return fn(substitute(value.param, replacements), substitute(value.result, replacements));
    case "data":
      return data(value.constructor, value.args.map((arg) => substitute(arg, replacements)));
    case "record": {
      const { fields, tail } = flatten(value.row);
      return record(
        row(
          new Map([...fields].map(([name, field]) => [name, substitute(field, replacements)])),
          tail,
        ),
      );
    }
    case "forall": {
      const local = new Map(replacements);
      for (const variable of value.variables) local.delete(variable);
      return forall(value.variables, substitute(value.body, local));
    }
    default:
      return value;
  }
};

export const instantiateForall = (input: Type, level = 0): Type => {
  let type = prune(input);
  while (type.kind === "forall") {
    type = prune(
      substitute(type.body, new Map(type.variables.map((variable) => [variable, fresh(level)]))),
    );
  }
  return type;
};

const skolem = (name: string, level: number): Type => ({
  kind: "skolem",
  name,
  level,
  id: Symbol(name),
});

export const skolemize = (input: Type, level: number): Type => {
  let type = prune(input);
  while (type.kind === "forall") {
    type = prune(
      substitute(
        type.body,
        new Map(type.variables.map((variable) => [variable, skolem(variable.name, level)])),
      ),
    );
  }
  return type;
};

const maxLevel = (type: Type): number => {
  const value = prune(type);
  switch (value.kind) {
    case "variable":
    case "skolem":
      return value.level;
    case "function":
      return Math.max(maxLevel(value.param), maxLevel(value.result));
    case "forall":
      return maxLevel(value.body);
    case "data":
      return Math.max(0, ...value.args.map(maxLevel));
    case "record": {
      const { fields, tail } = flatten(value.row);
      return Math.max(tail?.level ?? 0, ...[...fields.values()].map(maxLevel));
    }
    default:
      return 0;
  }
};

const lower = (type: Type, level: number, bound: ReadonlySet<Generic> = new Set()): void => {
  const value = prune(type);
  switch (value.kind) {
    case "variable":
      if (value.level > level) engine.assign(value, "level", level);
      return;
    case "skolem":
      if (value.level > level) engine.fail(`Skolem escape: ${show(value)}`);
      return;
    case "generic":
      if (!bound.has(value)) engine.fail(`Escaping generic type: ${value.name}`);
      return;
    case "function":
      lower(value.param, level, bound);
      lower(value.result, level, bound);
      return;
    case "data":
      for (const arg of value.args) lower(arg, level, bound);
      return;
    case "forall":
      lower(value.body, level, new Set([...bound, ...value.variables]));
      return;
    case "record": {
      const { fields, tail } = flatten(value.row);
      for (const field of fields.values()) lower(field, level, bound);
      if (tail && tail.level > level) engine.assign(tail, "level", level);
      return;
    }
    default:
      return;
  }
};

export class UnifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnifyError";
  }
}

class Engine {
  #undo: (() => void)[] = [];

  mark(): number {
    return this.#undo.length;
  }

  restore(mark: number): void {
    while (this.#undo.length > mark) this.#undo.pop()!();
  }

  assign<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): void {
    const existed = Object.prototype.hasOwnProperty.call(target, key);
    const previous = target[key];
    if (existed && Object.is(previous, value)) return;
    this.#undo.push(() => {
      if (existed) target[key] = previous;
      else Reflect.deleteProperty(target, key);
    });
    target[key] = value;
  }

  add<T>(target: Set<T>, value: T): void {
    if (target.has(value)) return;
    this.#undo.push(() => target.delete(value));
    target.add(value);
  }

  fail(message: string): never {
    throw new UnifyError(message);
  }

  attempt(body: () => void): string | undefined {
    const mark = this.mark();
    try {
      body();
      return undefined;
    } catch (error) {
      this.restore(mark);
      if (error instanceof UnifyError) return error.message;
      throw error;
    }
  }
}

export const engine = new Engine();

const excludeLabels = (input: Row, labels: Iterable<string>): void => {
  const { fields, tail } = flatten(input);
  for (const label of labels) {
    if (fields.has(label)) engine.fail(`Duplicate field: ${label}`);
    if (tail) engine.add(tail.lacks, label);
  }
};

export const exclude = (input: Row, labels: Iterable<string>): string | undefined =>
  engine.attempt(() => excludeLabels(input, labels));

const solveRow = (variable: RowVariable, input: Row): void => {
  const target = flatten(input);
  if (!target.fields.size && target.tail === variable) return;
  const variables = new Set<FreeVariable>();
  freeRow(target, variables);
  if (variables.has(variable)) engine.fail("Infinite row");
  lower(record(target), variable.level);
  excludeLabels(target, variable.lacks);
  engine.assign(variable, "instance", target);
};

const unifyRows = (left: Row, right: Row): void => {
  let a = flatten(left);
  let b = flatten(right);
  const unified = new Set<string>();
  for (;;) {
    const common = [...a.fields].filter(([label]) => b.fields.has(label) && !unified.has(label));
    if (!common.length) break;
    for (const [label, type] of common) {
      unifyTypes(type, b.fields.get(label)!);
      unified.add(label);
    }
    a = flatten(left);
    b = flatten(right);
  }
  const onlyA = new Map([...a.fields].filter(([label]) => !b.fields.has(label)));
  const onlyB = new Map([...b.fields].filter(([label]) => !a.fields.has(label)));
  if ((!a.tail && onlyB.size) || (!b.tail && onlyA.size)) {
    engine.fail(`Missing field: ${[...(!a.tail ? onlyB : onlyA).keys()].join(", ")}`);
  }
  if (a.tail === b.tail) {
    if (onlyA.size || onlyB.size) engine.fail("Infinite row: incompatible fields share a tail");
    return;
  }
  if (a.tail && b.tail) {
    const shared = freshRow([...onlyA.keys(), ...onlyB.keys()], Math.min(a.tail.level, b.tail.level));
    solveRow(a.tail, row(onlyB, shared));
    solveRow(b.tail, row(onlyA, shared));
  } else if (a.tail) solveRow(a.tail, row(onlyB));
  else if (b.tail) solveRow(b.tail, row(onlyA));
};

const unifyTypes = (left: Type, right: Type): void => {
  const a = prune(left);
  const b = prune(right);
  if (a === b) return;
  if (a.kind === "variable") {
    if (occurs(a, b)) engine.fail(`Infinite type: ${show(a)} occurs in ${show(b)}`);
    if (b.kind === "forall") {
      engine.fail("Cannot infer an impredicative type; add an explicit polymorphic annotation");
    }
    lower(b, a.level);
    engine.assign(a, "instance", b);
  } else if (b.kind === "variable") unifyTypes(b, a);
  else if (a.kind === "function" && b.kind === "function") {
    unifyTypes(a.param, b.param);
    unifyTypes(a.result, b.result);
  } else if (a.kind === "record" && b.kind === "record") unifyRows(a.row, b.row);
  else if (a.kind === "data" && b.kind === "data" && a.constructor.id === b.constructor.id) {
    for (let index = 0; index < a.args.length; index++) unifyTypes(a.args[index]!, b.args[index]!);
  } else if (
    a.kind === "forall"
    && b.kind === "forall"
    && a.variables.length === b.variables.length
  ) {
    const level = Math.max(maxLevel(a), maxLevel(b)) + 1;
    const witnesses = a.variables.map((variable) => skolem(variable.name, level));
    const open = ({ variables, body }: Extract<Type, { kind: "forall" }>): Type =>
      substitute(body, new Map(variables.map((variable, index) => [variable, witnesses[index]!])));
    unifyTypes(open(a), open(b));
  } else if (a.kind === "generic" && b.kind === "generic" && a.id === b.id) return;
  else if (a.kind === "skolem" && b.kind === "skolem" && a.id === b.id) return;
  else if (
    a.kind === b.kind
    && (a.kind === "number" || a.kind === "boolean" || a.kind === "string")
  ) return;
  else engine.fail(`Cannot unify ${show(a)} with ${show(b)}`);
};

export const unify = (left: Type, right: Type): string | undefined =>
  engine.attempt(() => unifyTypes(left, right));

const subsumeAt = (actual: Type, expected: Type, level: number): void => {
  const target = prune(expected);
  if (target.kind === "forall") {
    subsumeAt(instantiateForall(actual, level + 1), skolemize(target, level + 1), level + 1);
    return;
  }
  const source = instantiateForall(actual, level);
  if (source.kind === "function" && target.kind === "function") {
    subsumeAt(target.param, source.param, level);
    subsumeAt(source.result, target.result, level);
  } else unifyTypes(source, target);
};

export const subsume = (actual: Type, expected: Type, level = 0): string | undefined =>
  engine.attempt(() => subsumeAt(actual, expected, level));

export const expectFunction = (
  input: Type,
  level = 0,
): { readonly ok: true; readonly fn: Extract<Type, { kind: "function" }> } | { readonly ok: false; readonly error: string } => {
  let failure: string | undefined;
  const mark = engine.mark();
  try {
    const type = instantiateForall(input, level);
    if (type.kind === "function") return { ok: true, fn: type };
    const param = fresh(level);
    const result = fresh(level);
    unifyTypes(type, fn(param, result));
    return { ok: true, fn: { kind: "function", param, result } };
  } catch (error) {
    engine.restore(mark);
    failure = error instanceof UnifyError ? error.message : String(error);
  }
  return { ok: false, error: failure ?? "Expected a function" };
};
