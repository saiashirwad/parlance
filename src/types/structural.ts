/** A structural type. Exploration languages opt in to this store; nothing else depends on it. */
export type Type =
  | { readonly kind: "unknown" }
  | { readonly kind: "never" }
  | { readonly kind: "number" }
  | { readonly kind: "boolean" }
  | { readonly kind: "string" }
  | { readonly kind: "literal"; readonly value: string | number | boolean }
  | { readonly kind: "variable"; readonly id: number }
  | { readonly kind: "array"; readonly element: Type }
  | { readonly kind: "record"; readonly fields: ReadonlyMap<string, Type>; readonly open: boolean }
  | { readonly kind: "union"; readonly members: readonly Type[] }
  | { readonly kind: "function"; readonly param: Type; readonly result: Type }
  | { readonly kind: "ref"; readonly name: string; readonly args: readonly Type[] };

export type PrintProblem = { readonly text: string; readonly problem: string | undefined };

const UNKNOWN: Type = { kind: "unknown" };
const NEVER: Type = { kind: "never" };
const NUMBER: Type = { kind: "number" };
const BOOLEAN: Type = { kind: "boolean" };
const STRING: Type = { kind: "string" };
const SMALL_LITERALS: (Type | undefined)[] = new Array(4096);

type Context = "top" | "element" | "member";

type Renderer = {
  readonly resolve: (type: Type) => Type;
  readonly names: Map<number, string>;
};

const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const variableName = (index: number): string => {
  const letter = letters[index % letters.length]!;
  return index < letters.length ? letter : `${letter}${Math.floor(index / letters.length)}`;
};

const literalText = (value: string | number | boolean): string =>
  typeof value === "string" ? JSON.stringify(value) : String(value);

const fieldName = (name: string): string =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);

const matchesBase = (value: string | number | boolean, type: Type): boolean =>
  (typeof value === "string" && type.kind === "string") ||
  (typeof value === "number" && type.kind === "number") ||
  (typeof value === "boolean" && type.kind === "boolean");

const needsParens = (type: Type, context: Context): boolean => {
  switch (type.kind) {
    case "union":
      return context === "element";
    case "function":
      return context === "element" || context === "member";
    case "array":
      return context === "element";
    case "record":
      return type.open && type.fields.size > 0 && context === "element";
    default:
      return false;
  }
};

const renderBody = (state: Renderer, type: Type): string => {
  switch (type.kind) {
    case "unknown":
    case "never":
    case "number":
    case "boolean":
    case "string":
      return type.kind;
    case "literal":
      return literalText(type.value);
    case "variable": {
      let name = state.names.get(type.id);
      if (name === undefined) {
        name = variableName(state.names.size);
        state.names.set(type.id, name);
      }
      return name;
    }
    case "array":
      return `readonly ${render(state, type.element, "element")}[]`;
    case "record": {
      if (type.fields.size === 0) return type.open ? "Record<string, unknown>" : "{}";
      const fields = [...type.fields]
        .map(([name, field]) => `readonly ${fieldName(name)}: ${render(state, field, "top")}`)
        .join("; ");
      return type.open ? `{ ${fields} } & Record<string, unknown>` : `{ ${fields} }`;
    }
    case "union":
      if (type.members.length === 0) return "never";
      return type.members.map((member) => render(state, member, "member")).join(" | ");
    case "function":
      return `(x: ${render(state, type.param, "top")}) => ${render(state, type.result, "top")}`;
    case "ref":
      return type.args.length === 0
        ? type.name
        : `${type.name}<${type.args.map((argument) => render(state, argument, "top")).join(", ")}>`;
  }
};

const render = (state: Renderer, input: Type, context: Context): string => {
  const type = state.resolve(input);
  const body = renderBody(state, type);
  return needsParens(type, context) ? `(${body})` : body;
};

const problemOf = (type: Type, resolve: (type: Type) => Type): string | undefined => {
  const value = resolve(type);
  switch (value.kind) {
    case "array":
      return problemOf(value.element, resolve);
    case "record": {
      if (value.open && value.fields.size === 0) {
        return "an open record with no fields has no structure; it is shown as Record<string, unknown>";
      }
      for (const field of value.fields.values()) {
        const problem = problemOf(field, resolve);
        if (problem !== undefined) return problem;
      }
      return undefined;
    }
    case "union":
      for (const member of value.members) {
        const problem = problemOf(member, resolve);
        if (problem !== undefined) return problem;
      }
      return undefined;
    case "function":
      return problemOf(value.param, resolve) ?? problemOf(value.result, resolve);
    case "ref":
      for (const argument of value.args) {
        const problem = problemOf(argument, resolve);
        if (problem !== undefined) return problem;
      }
      return undefined;
    default:
      return undefined;
  }
};

export const printType = (type: Type): PrintProblem => ({
  text: render({ resolve: (value) => value, names: new Map() }, type, "top"),
  problem: problemOf(type, (value) => value),
});

export class TypeStore {
  #next = 0;
  #links = new Map<number, Type>();
  #undo: { readonly id: number; readonly previous: Type | undefined }[] = [];
  #numbers = new Map<number, Type>();
  #strings = new Map<string, Type>();
  #booleans: readonly [Type, Type] = [{ kind: "literal", value: false }, { kind: "literal", value: true }];

  fresh(): Type {
    return { kind: "variable", id: this.#next++ };
  }

  unknown(): Type {
    return UNKNOWN;
  }

  number(): Type {
    return NUMBER;
  }

  boolean(): Type {
    return BOOLEAN;
  }

  string(): Type {
    return STRING;
  }

  literal(value: string | number | boolean): Type {
    if (typeof value === "string") {
      let type = this.#strings.get(value);
      if (type === undefined) {
        type = { kind: "literal", value };
        this.#strings.set(value, type);
      }
      return type;
    }
    if (typeof value === "boolean") return this.#booleans[value ? 1 : 0]!;
    if (Number.isInteger(value) && value >= 0 && value < SMALL_LITERALS.length) {
      return SMALL_LITERALS[value] ?? (SMALL_LITERALS[value] = { kind: "literal", value });
    }
    let type = this.#numbers.get(value);
    if (type === undefined) {
      type = { kind: "literal", value };
      this.#numbers.set(value, type);
    }
    return type;
  }

  function(param: Type, result: Type): Type {
    return { kind: "function", param, result };
  }

  array(element: Type): Type {
    return { kind: "array", element };
  }

  record(fields: Record<string, Type>, open = false): Type {
    return { kind: "record", fields: new Map(Object.entries(fields)), open };
  }

  ref(name: string, args: readonly Type[] = []): Type {
    return { kind: "ref", name, args };
  }

  union(members: readonly Type[]): Type {
    const flat: Type[] = [];
    const seen = new Set<string>();
    const add = (member: Type): void => {
      const value = this.prune(member);
      if (value.kind === "never") return;
      if (value.kind === "union") {
        for (const inner of value.members) add(inner);
        return;
      }
      const key = this.#key(value);
      if (seen.has(key)) return;
      seen.add(key);
      flat.push(value);
    };
    for (const member of members) add(member);
    if (flat.length === 0) return NEVER;
    if (flat.length === 1) return flat[0]!;
    return { kind: "union", members: flat };
  }

  prune(type: Type): Type {
    let current = type;
    if (current.kind !== "variable") return current;
    let seen: Set<number> | undefined;
    while (current.kind === "variable") {
      if (seen === undefined) seen = new Set();
      else if (seen.has(current.id)) return current;
      seen.add(current.id);
      const next = this.#links.get(current.id);
      if (next === undefined) return current;
      current = next;
    }
    return current;
  }

  link(variable: Type, value: Type): void {
    const target = this.prune(variable);
    if (target.kind !== "variable") return;
    const resolved = this.prune(value);
    if (resolved.kind === "variable" && resolved.id === target.id) return;
    if (this.#occurs(target.id, resolved)) return;
    this.#push(target.id, resolved);
  }

  unify(left: Type, right: Type): boolean {
    const l = this.#normalize(this.prune(left));
    const r = this.#normalize(this.prune(right));
    if (l === r) return true;
    if (l.kind === "variable") {
      if (r.kind === "unknown") return true;
      return this.#bind(l, r);
    }
    if (r.kind === "variable") {
      if (l.kind === "unknown") return true;
      return this.#bind(r, l);
    }
    if (l.kind === "unknown" || r.kind === "unknown") return true;
    if (l.kind === "never" || r.kind === "never") return l.kind === r.kind;
    if (l.kind === "union" || r.kind === "union") return this.#unifyUnion(l, r);
    if (l.kind === "literal" && matchesBase(l.value, r)) return true;
    if (r.kind === "literal" && matchesBase(r.value, l)) return true;
    if (l.kind !== r.kind) return false;
    switch (l.kind) {
      case "number":
      case "boolean":
      case "string":
        return true;
      case "literal":
        return r.kind === "literal" && typeof l.value === typeof r.value && l.value === r.value;
      case "array":
        return r.kind === "array" && this.unify(l.element, r.element);
      case "record":
        return r.kind === "record" && this.#unifyRecord(l, r);
      case "function":
        return (
          r.kind === "function" && this.unify(l.param, r.param) && this.unify(l.result, r.result)
        );
      case "ref":
        return (
          r.kind === "ref" &&
          l.name === r.name &&
          l.args.length === r.args.length &&
          l.args.every((argument, index) => this.unify(argument, r.args[index]!))
        );
    }
  }

  mark(): number {
    return this.#undo.length;
  }

  restore(mark: number): void {
    while (this.#undo.length > mark) {
      const entry = this.#undo.pop()!;
      if (entry.previous === undefined) this.#links.delete(entry.id);
      else this.#links.set(entry.id, entry.previous);
    }
  }

  show(type: Type): string {
    return render({ resolve: (value) => this.prune(value), names: new Map() }, type, "top");
  }

  free(type: Type): readonly number[] {
    const ids = new Set<number>();
    const visit = (input: Type): void => {
      const value = this.prune(input);
      switch (value.kind) {
        case "variable":
          ids.add(value.id);
          return;
        case "array":
          visit(value.element);
          return;
        case "record":
          for (const field of value.fields.values()) visit(field);
          return;
        case "union":
          for (const member of value.members) visit(member);
          return;
        case "function":
          visit(value.param);
          visit(value.result);
          return;
        case "ref":
          for (const argument of value.args) visit(argument);
          return;
        default:
          return;
      }
    };
    visit(type);
    return [...ids].sort((a, b) => a - b);
  }

  #normalize(type: Type): Type {
    return type.kind === "union" && type.members.length === 0 ? NEVER : type;
  }

  #bind(variable: Type, value: Type): boolean {
    if (variable.kind !== "variable") return false;
    const target = this.prune(variable);
    if (target.kind !== "variable") return true;
    const resolved = this.prune(value);
    if (resolved.kind === "variable" && resolved.id === target.id) return true;
    if (this.#occurs(target.id, resolved)) return false;
    this.#push(target.id, resolved);
    return true;
  }

  #push(id: number, value: Type): void {
    this.#undo.push({ id, previous: this.#links.get(id) });
    this.#links.set(id, value);
  }

  #occurs(id: number, type: Type): boolean {
    const value = this.prune(type);
    switch (value.kind) {
      case "variable":
        return value.id === id;
      case "array":
        return this.#occurs(id, value.element);
      case "record":
        return [...value.fields.values()].some((field) => this.#occurs(id, field));
      case "union":
        return value.members.some((member) => this.#occurs(id, member));
      case "function":
        return this.#occurs(id, value.param) || this.#occurs(id, value.result);
      case "ref":
        return value.args.some((argument) => this.#occurs(id, argument));
      default:
        return false;
    }
  }

  #unifyUnion(left: Type, right: Type): boolean {
    const members = left.kind === "union" ? left.members : right.kind === "union" ? right.members : [];
    const other = left.kind === "union" ? right : left;
    for (const member of members) {
      const mark = this.mark();
      if (this.unify(member, other)) return true;
      this.restore(mark);
    }
    return false;
  }

  #unifyRecord(
    left: Extract<Type, { kind: "record" }>,
    right: Extract<Type, { kind: "record" }>,
  ): boolean {
    for (const [name, field] of left.fields) {
      const other = right.fields.get(name);
      if (other !== undefined && !this.unify(field, other)) return false;
    }
    if (left.open && !right.open) return [...left.fields.keys()].every((name) => right.fields.has(name));
    if (!left.open && right.open) return [...right.fields.keys()].every((name) => left.fields.has(name));
    if (!left.open && !right.open) return left.fields.size === right.fields.size;
    return true;
  }

  #key(type: Type): string {
    const value = this.prune(type);
    switch (value.kind) {
      case "unknown":
      case "never":
      case "number":
      case "boolean":
      case "string":
        return value.kind;
      case "literal":
        return `l:${typeof value.value}:${String(value.value)}`;
      case "variable":
        return `v:${value.id}`;
      case "array":
        return `a:${this.#key(value.element)}`;
      case "record": {
        const fields = [...value.fields]
          .map(([name, field]) => `${name}:${this.#key(field)}`)
          .sort()
          .join(",");
        return `r:${value.open ? "open" : "closed"}{${fields}}`;
      }
      case "union":
        return `u{${value.members.map((member) => this.#key(member)).sort().join("|")}}`;
      case "function":
        return `f:${this.#key(value.param)}->${this.#key(value.result)}`;
      case "ref":
        return `ref:${value.name}<${value.args.map((argument) => this.#key(argument)).join(",")}>`;
    }
  }
}
