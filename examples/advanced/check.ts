import { type Binding, type Checker } from "../../src/check/index.ts";
import type { Span, Text } from "../../src/source.ts";
import type {
  Base,
  Body,
  DataDecl,
  Expr,
  File,
  Let,
  Match,
  MatchCase,
  Name,
  Pattern,
  Postfix,
  Record,
  TypeExpr,
} from "./advanced.ast.ts";
import { nullaryConstructorText, printer } from "./type-printer.ts";
import {
  boolean,
  data,
  exclude,
  expectFunction,
  flatten,
  fn,
  forall,
  fresh,
  freshRow,
  generalize,
  generic,
  instantiate,
  instantiateForall,
  mono,
  number,
  prune,
  record,
  row,
  type Scheme,
  show,
  skolemize,
  string,
  subsume,
  type Type,
  type TypeConstructor,
  unify,
} from "./type.ts";

export type ConstructorInfo = {
  readonly name: string;
  readonly binding: Binding<Type>;
  readonly scheme: Scheme;
  readonly type: Type;
  readonly arity: number;
  readonly tag: string;
  readonly owner: TypeConstructor;
  readonly span: Span;
  readonly uri: string;
};

export type DataInfo = {
  readonly name: Text;
  readonly parameters: readonly string[];
  readonly constructor: TypeConstructor;
  readonly constructors: readonly ConstructorInfo[];
  readonly binding: Binding<Type>;
  readonly uri: string;
  readonly span: Span;
};

export type Checked =
  | { readonly kind: "number"; readonly value: number; readonly type: Type; readonly span: Span }
  | { readonly kind: "boolean"; readonly value: boolean; readonly type: Type; readonly span: Span }
  | { readonly kind: "string"; readonly value: string; readonly type: Type; readonly span: Span }
  | {
    readonly kind: "name";
    readonly binding: Binding<Type>;
    readonly builtin: "print" | null;
    readonly type: Type;
    readonly span: Span;
  }
  | {
    readonly kind: "constructor";
    readonly constructor: ConstructorInfo;
    readonly binding: Binding<Type>;
    readonly type: Type;
    readonly span: Span;
  }
  | {
    readonly kind: "record";
    readonly fields: readonly { readonly name: string; readonly value: Checked; readonly span: Span }[];
    readonly base: Checked | null;
    readonly type: Type;
    readonly span: Span;
  }
  | {
    readonly kind: "field";
    readonly record: Checked;
    readonly name: string;
    readonly type: Type;
    readonly span: Span;
  }
  | {
    readonly kind: "binary";
    readonly operator: string;
    readonly left: Checked;
    readonly right: Checked;
    readonly type: Type;
    readonly span: Span;
  }
  | {
    readonly kind: "prefix";
    readonly operator: string;
    readonly operand: Checked;
    readonly type: Type;
    readonly span: Span;
  }
  | {
    readonly kind: "let";
    readonly name: string;
    readonly binding: Binding<Type>;
    readonly value: Checked;
    readonly body: Checked;
    readonly recursive: boolean;
    readonly type: Type;
    readonly span: Span;
  }
  | {
    readonly kind: "fn";
    readonly param: string;
    readonly binding: Binding<Type>;
    readonly body: Checked;
    readonly type: Type;
    readonly span: Span;
  }
  | {
    readonly kind: "call";
    readonly fn: Checked;
    readonly arg: Checked;
    readonly type: Type;
    readonly span: Span;
  }
  | {
    readonly kind: "if";
    readonly cond: Checked;
    readonly then: Checked;
    readonly otherwise: Checked;
    readonly type: Type;
    readonly span: Span;
  }
  | {
    readonly kind: "match";
    readonly value: Checked;
    readonly cases: readonly MatchBranch[];
    readonly fallback: MatchFallback | null;
    readonly type: Type;
    readonly span: Span;
  };

export type MatchBranch = {
  readonly tag: string;
  readonly bindings: readonly {
    readonly name: string;
    readonly binding: Binding<Type>;
    readonly index: number;
  }[];
  readonly body: Checked;
};

export type MatchFallback = {
  readonly binding: { readonly name: string; readonly binding: Binding<Type> } | null;
  readonly body: Checked;
};

export type ExportIR =
  | {
    readonly kind: "field";
    readonly name: string;
    readonly binding: Binding<Type>;
    readonly scheme: Scheme;
    readonly fieldType: Type;
    readonly span: Span;
  }
  | {
    readonly kind: "constructor";
    readonly name: string;
    readonly binding: Binding<Type>;
    readonly scheme: Scheme;
    readonly constructor: ConstructorInfo;
  };

export type ImportGroup = {
  readonly specifier: string;
  readonly names: readonly { readonly exported: string; readonly binding: Binding<Type> }[];
};

export type AdvancedModule = {
  readonly uri: string;
  readonly types: readonly DataInfo[];
  readonly constructors: readonly ConstructorInfo[];
  readonly body: Checked;
  readonly resultType: Type;
  readonly exports: readonly ExportIR[];
  readonly datatypes: ReadonlyMap<string, string>;
  readonly imports: readonly ImportGroup[];
};

type Entry = {
  readonly binding: Binding<Type>;
  readonly scheme: Scheme;
  readonly constructor: ConstructorInfo | null;
  readonly builtin: "print" | null;
};

type Context = {
  readonly cx: Checker<Type>;
  readonly types: Map<string, DataInfo>;
  readonly typeBindings: Map<string, Binding<Type>>;
  readonly constructors: Map<string, ConstructorInfo>;
  readonly datatypes: Map<string, string>;
  readonly imported: Map<string, string>;
  readonly moduleImports: ImportGroup[];
  level: number;
};

const isUpper = (name: string): boolean => /^[A-Z]/.test(name);
const isWildcard = (name: string): boolean => name === "_";

const display = (type: Type): string => show(type);

const spanFrom = (start: number, end: number): Span => ({ start, end });

const dotted = (owner: string, constructor: string): string => `${owner}.${constructor}`;

/**
 * The type engine is shared by every module in the process so imported types
 * and schemes stay comparable. Each checker keeps its own value environment.
 */
const run = (file: File, cx: Checker<Type>): AdvancedModule => {
  const context: Context = {
    cx,
    types: new Map(),
    typeBindings: new Map(),
    constructors: new Map(),
    datatypes: new Map(),
    imported: new Map(),
    moduleImports: [],
    level: 0,
  };
  const env = new Map<string, Entry>();

  const saveScope = <A>(body: () => A): A => {
    const saved = new Map(env);
    try {
      return body();
    } finally {
      env.clear();
      for (const [name, entry] of saved) env.set(name, entry);
    }
  };

  const scoped = <A>(body: () => A): A => cx.scope(() => saveScope(body));

  const bindEntry = (name: string, entry: Entry): void => {
    env.set(name, entry);
    cx.bind(entry.binding);
  };

  const lookupEntry = (name: string): Entry | undefined => env.get(name);

  const withLevel = <A>(level: number, body: () => A): A => {
    const previous = context.level;
    context.level = level;
    try {
      return body();
    } finally {
      context.level = previous;
    }
  };

  const schemes = (): Scheme[] => [...env.values()].map((entry) => entry.scheme);

  const at = (value: Span | { readonly span: Span }): Span => "start" in value ? value : value.span;

  const error = (message: string, value: Span | { readonly span: Span }): void => cx.error(message, at(value));

  const typed = (value: Span | { readonly span: Span }, type: Type): void => cx.typed(at(value), type);

  const declare = (
    name: Text,
    kind: "function" | "variable" | "constant" | "type" | "parameter",
    type: Type,
    detail?: string,
  ): Binding<Type> => {
    const binding = cx.declare(name.text, name.span, kind, type, detail === undefined ? {} : { detail });
    cx.typed(name, type);
    return binding;
  };

  const bindValue = (name: Text, binding: Binding<Type>, scheme: Scheme, constructor: ConstructorInfo | null = null): void => {
    bindEntry(name.text, { binding, scheme, constructor, builtin: null });
  };

  const typeValue = (info: DataInfo, parameters: readonly Type[]): Type => data(info.constructor, parameters);

  const resolveType = (
    syntax: TypeExpr,
    parameters: ReadonlyMap<string, Type> = new Map(),
  ): Type => {
    switch (syntax.kind) {
      case "forall": {
        if (new Set(syntax.parameters.map((entry) => entry.text)).size !== syntax.parameters.length) {
          error("Duplicate forall parameter", syntax);
        }
        const variables = syntax.parameters.map((entry) => generic(entry.text));
        const nested = new Map(parameters);
        for (const variable of variables) nested.set(variable.name, variable);
        return forall(variables, resolveType(syntax.body, nested));
      }
      case "arrow":
        return fn(resolveType(syntax.param, parameters), resolveType(syntax.result, parameters));
      case "typeRecord": {
        const fields = new Map<string, Type>();
        for (const field of syntax.fields) {
          if (fields.has(field.name.text)) {
            error(`Duplicate field ${JSON.stringify(field.name.text)}`, field.name);
            continue;
          }
          const type = resolveType(field.type, parameters);
          if (prune(type).kind === "forall") {
            error("Polymorphic record fields are not supported", field.type);
            continue;
          }
          fields.set(field.name.text, type);
        }
        return record(row(fields));
      }
      case "typeName": {
        const name = syntax.name.text;
        const parameter = parameters.get(name);
        if (parameter) {
          if (syntax.arguments) error(`Type ${name} takes no arguments`, syntax);
          return parameter;
        }
        const primitive = name === "number" ? number : name === "boolean" ? boolean : name === "string" ? string : undefined;
        if (primitive) {
          if (syntax.arguments) error(`Type ${name} takes no arguments`, syntax);
          return primitive;
        }
        const info = context.types.get(name);
        if (!info) {
          error(`Unknown type ${JSON.stringify(name)}`, syntax.name);
          return fresh(context.level);
        }
        const binding = context.typeBindings.get(name);
        if (binding) cx.reference(binding, syntax.name);
        const arguments_ = syntax.arguments ?? [];
        if (arguments_.length !== info.constructor.arity) {
          error(`Type ${name} expects ${info.constructor.arity} arguments, found ${arguments_.length}`, syntax);
          return fresh(context.level);
        }
        const args: Type[] = [];
        for (const argument of arguments_) {
          const type = resolveType(argument, parameters);
          if (prune(type).kind === "forall") {
            error("Polymorphic data arguments are not supported", argument);
            continue;
          }
          args.push(type);
        }
        if (args.length !== info.constructor.arity) return fresh(context.level);
        return typeValue(info, args);
      }
    }
  };

  const subsumes = (actual: Type, expected: Type, value: Span | { readonly span: Span }, note?: string): boolean => {
    const failure = subsume(actual, expected, context.level);
    if (failure === undefined) return true;
    error(note ? `${note}: ${failure}` : failure, value);
    return false;
  };

  const unifies = (left: Type, right: Type, value: Span | { readonly span: Span }, note?: string): boolean => {
    const failure = unify(left, right);
    if (failure === undefined) return true;
    error(note ? `${note}: ${failure}` : failure, value);
    return false;
  };

  const expectNumber = (actual: Type, value: Span | { readonly span: Span }): void => {
    subsumes(actual, number, value);
  };

  const expectBoolean = (actual: Type, value: Span | { readonly span: Span }): void => {
    subsumes(actual, boolean, value);
  };

  const placeholder = (span: Span): Checked => ({
    kind: "number",
    value: 0,
    type: fresh(context.level),
    span,
  });

  const checkCall = (callee: Checked, argument: Expr, span: Span): Checked => {
    const expected = expectFunction(callee.type, context.level);
    if (!expected.ok) {
      error(expected.error, callee.span);
      const arg = elaborate(argument);
      return { kind: "call", fn: callee, arg, type: fresh(context.level), span };
    }
    const arg = checkExpr(argument, expected.fn.param);
    typed(span, expected.fn.result);
    return { kind: "call", fn: callee, arg, type: expected.fn.result, span };
  };

  const elaboratePostfix = (expr: Postfix): Checked => {
    let value = elaborate(expr.base);
    for (const operation of expr.operations) {
      if (operation.kind === "field") {
        value = elaborateField(value, operation.name);
        continue;
      }
      for (const argument of operation.arguments) {
        const span = spanFrom(value.span.start, at(argument).end);
        value = checkCall(value, argument, span);
      }
    }
    return value;
  };

  const elaborateField = (recordValue: Checked, name: Name): Checked => {
    const fieldType = fresh(context.level);
    const tail = freshRow([name.text], context.level);
    const expected = record(row(new Map([[name.text, fieldType]]), tail));
    unifies(recordValue.type, expected, name);
    typed(name, fieldType);
    return {
      kind: "field",
      record: recordValue,
      name: name.text,
      type: fieldType,
      span: spanFrom(recordValue.span.start, name.span.end),
    };
  };

  const elaborateRecord = (expr: Record): Checked => {
    const fields: { name: string; value: Checked; span: Span }[] = [];
    const types = new Map<string, Type>();
    for (const field of expr.fields) {
      if (types.has(field.name.text)) {
        error(`Duplicate field ${JSON.stringify(field.name.text)}`, field.name);
        continue;
      }
      const value = elaborate(field.value);
      if (prune(value.type).kind === "forall") {
        error("Polymorphic record fields are not supported", field.value);
        continue;
      }
      types.set(field.name.text, value.type);
      fields.push({ name: field.name.text, value, span: field.name.span });
      typed(field.name, value.type);
    }
    if (!expr.base) {
      const type = record(row(types));
      typed(expr, type);
      return { kind: "record", fields, base: null, type, span: expr.span };
    }
    const base = elaborate(expr.base);
    const tail = freshRow([], context.level);
    unifies(base.type, record(row(new Map(), tail)), expr.base, "Record update");
    const failure = exclude(row(new Map(), tail), types.keys());
    if (failure !== undefined) {
      error(failure, expr.base);
      const type = record(row(types));
      typed(expr, type);
      return { kind: "record", fields, base: null, type, span: expr.span };
    }
    const type = record(row(types, tail));
    typed(expr, type);
    return { kind: "record", fields, base, type, span: expr.span };
  };

  const elaborateBinary = (expr: Extract<Expr, { kind: "binary" }>): Checked => {
    const left = elaborate(expr.left);
    const right = elaborate(expr.right);
    const operator = expr.operator.text;
    expectNumber(left.type, expr.left);
    expectNumber(right.type, expr.right);
    const type = operator === "==" || operator === "!=" || operator === "<" || operator === "<="
        || operator === ">" || operator === ">="
      ? boolean
      : number;
    typed(expr, type);
    return { kind: "binary", operator, left, right, type, span: expr.span };
  };

  const elaborateIf = (expr: Extract<Expr, { kind: "if" }>): Checked => {
    const cond = checkExpr(expr.cond, boolean);
    const then = elaborate(expr.then);
    const otherwise = checkExpr(expr.else, then.type);
    typed(expr, then.type);
    return { kind: "if", cond, then, otherwise, type: then.type, span: expr.span };
  };

  const elaborateLet = (
    expr: Let,
    expected?: Type,
  ): Checked => scoped(() => {
    const environment = schemes();
    const annotation = expr.annotation ? resolveType(expr.annotation) : undefined;
    let binding: Binding<Type>;
    let scheme: Scheme;
    let value: Checked;
    const recursive = expr.recursive !== null;
    if (recursive) {
      if (expr.value.kind !== "fn") {
        error("Recursive bindings require a function initializer", expr.value);
      }
      const type = annotation ?? fresh(context.level);
      binding = declare(expr.name, prune(type).kind === "function" ? "function" : "variable", type);
      bindValue(expr.name, binding, mono(type));
      value = checkExpr(expr.value, type);
      scheme = annotation ? mono(annotation) : generalize(type, environment);
    } else {
      value = annotation ? checkExpr(expr.value, annotation) : elaborate(expr.value);
      const type = annotation ?? value.type;
      binding = declare(
        expr.name,
        prune(type).kind === "function" || prune(type).kind === "forall" ? "function" : "variable",
        type,
      );
      scheme = annotation ? mono(annotation) : generalize(type, environment);
    }
    bindValue(expr.name, binding, scheme);
    const body = expected ? checkExpr(expr.body, expected) : elaborate(expr.body);
    typed(expr, body.type);
    return {
      kind: "let",
      name: expr.name.text,
      binding,
      value,
      body,
      recursive,
      type: body.type,
      span: expr.span,
    };
  });

  const elaborateFn = (expr: Extract<Expr, { kind: "fn" }>, expected?: Extract<Type, { kind: "function" }>): Checked => scoped(() => {
    const annotation = expr.annotation ? resolveType(expr.annotation) : undefined;
    const parameter = annotation ?? expected?.param ?? fresh(context.level);
    if (annotation && expected) subsumes(expected.param, annotation, expr.annotation ?? expr);
    const binding = declare(expr.param, "parameter", parameter);
    bindValue(expr.param, binding, mono(parameter));
    const body = expected ? checkExpr(expr.body, expected.result) : elaborate(expr.body);
    const type = fn(parameter, body.type);
    typed(expr, type);
    return { kind: "fn", param: expr.param.text, binding, body, type, span: expr.span };
  });

  const resolveConstructor = (name: Name): ConstructorInfo | undefined => {
    const constructor = context.constructors.get(name.text);
    if (!constructor) {
      error(`Unknown constructor ${JSON.stringify(name.text)}`, name);
      return undefined;
    }
    cx.reference(constructor.binding, name);
    cx.typed(name, constructor.type);
    return constructor;
  };

  const openConstructor = (constructor: ConstructorInfo): { readonly fields: readonly Type[]; readonly result: Type } => {
    let type = instantiateForall(constructor.type, context.level);
    const fields: Type[] = [];
    for (let index = 0; index < constructor.arity; index++) {
      const value = prune(type);
      if (value.kind !== "function") {
        fields.push(fresh(context.level));
        continue;
      }
      fields.push(value.param);
      type = value.result;
    }
    return { fields, result: type };
  };

  const matchPattern = (
    pattern: Pattern,
    branch: MatchCase,
    value: Checked,
    result: Type,
    seen: Set<string>,
    fallback: MatchFallback | null,
  ): { readonly branch: MatchBranch | null; readonly fallback: MatchFallback | null } => {
    if (fallback) {
      error("Unreachable case after catch-all", pattern);
      return { branch: null, fallback };
    }
    if (pattern.fields === null) {
      if (!isUpper(pattern.name.text)) {
        if (isWildcard(pattern.name.text)) {
          const body = checkExpr(branch.body, result);
          return { branch: null, fallback: { binding: null, body } };
        }
        const binding = declare(pattern.name, "variable", value.type);
        const body = scoped(() => {
          bindValue(pattern.name, binding, mono(value.type));
          return checkExpr(branch.body, result);
        });
        return { branch: null, fallback: { binding: { name: pattern.name.text, binding }, body } };
      }
      const constructor = resolveConstructor(pattern.name);
      if (!constructor) return { branch: null, fallback };
      if (constructor.arity !== 0) {
        error(`Constructor ${pattern.name.text} expects ${constructor.arity} fields, found 0`, pattern);
        return { branch: null, fallback };
      }
      if (seen.has(constructor.tag)) {
        error(`Unreachable duplicate case: ${pattern.name.text}`, pattern);
        return { branch: null, fallback };
      }
      seen.add(constructor.tag);
      const opened = openConstructor(constructor);
      unifies(value.type, opened.result, pattern, `Constructor ${pattern.name.text}`);
      const body = checkExpr(branch.body, result);
      return { branch: { tag: constructor.tag, bindings: [], body }, fallback };
    }
    if (!isUpper(pattern.name.text)) {
      error(`Constructor patterns must start with an uppercase letter`, pattern.name);
      return { branch: null, fallback };
    }
    const constructor = resolveConstructor(pattern.name);
    if (!constructor) return { branch: null, fallback };
    if (seen.has(constructor.tag)) {
      error(`Unreachable duplicate case: ${pattern.name.text}`, pattern);
      return { branch: null, fallback };
    }
    seen.add(constructor.tag);
    if (pattern.fields.length !== constructor.arity) {
      error(
        `Constructor ${pattern.name.text} expects ${constructor.arity} fields, found ${pattern.fields.length}`,
        pattern,
      );
      return { branch: null, fallback };
    }
    const opened = openConstructor(constructor);
    const bindings: { name: string; binding: Binding<Type>; index: number }[] = [];
    const entries: [Name, Entry][] = [];
    for (const [index, field] of pattern.fields.entries()) {
      if (field.fields !== null || isUpper(field.name.text)) {
        error("Nested constructor patterns are not supported", field);
        continue;
      }
      const fieldType = opened.fields[index] ?? fresh(context.level);
      if (isWildcard(field.name.text)) continue;
      const binding = declare(field.name, "parameter", fieldType, pattern.name.text);
      bindings.push({ name: field.name.text, binding, index });
      entries.push([field.name, {
        binding,
        scheme: mono(fieldType),
        constructor: null,
        builtin: null,
      }]);
    }
    unifies(value.type, opened.result, pattern, `Constructor ${pattern.name.text}`);
    const body = scoped(() => {
      for (const [name, entry] of entries) {
        env.set(name.text, entry);
        cx.bind(entry.binding);
      }
      return checkExpr(branch.body, result);
    });
    return { branch: { tag: constructor.tag, bindings, body }, fallback };
  };

  const elaborateMatch = (expr: Match, expected?: Type): Checked => {
    const value = elaborate(expr.value);
    const result = expected ?? fresh(context.level);
    if (expr.cases.length === 0) error("Match requires at least one case", expr);
    const seen = new Set<string>();
    let fallback: MatchFallback | null = null;
    const branches: MatchBranch[] = [];
    for (const branch of expr.cases) {
      const next = matchPattern(branch.pattern, branch, value, result, seen, fallback);
      fallback = next.fallback;
      if (next.branch) branches.push(next.branch);
    }
    if (!fallback) {
      const type = prune(value.type);
      if (type.kind !== "data") {
        error("Constructor match requires a data type", expr.value);
      } else {
        const info = context.types.get(type.constructor.name);
        if (info) {
          const missing = info.constructors.filter((constructor) => !seen.has(constructor.tag));
          if (missing.length > 0) {
            error(`Non-exhaustive match; missing: ${missing.map((constructor) => constructor.name).join(", ")}`, expr);
          }
        }
      }
    }
    typed(expr, result);
    return { kind: "match", value, cases: branches, fallback, type: result, span: expr.span };
  };

  const checkExpr = (expr: Expr, expected: Type): Checked => {
    const target = prune(expected);
    if (target.kind === "forall") {
      const next = context.level + 1;
      return withLevel(next, () => {
        const checked = checkExpr(expr, skolemize(target, next));
        typed(expr, expected);
        return { ...checked, type: expected };
      });
    }
    if (expr.kind === "fn" && target.kind === "function") {
      const checked = elaborateFn(expr, target);
      return { ...checked, type: expected };
    }
    if (expr.kind === "if") {
      const cond = checkExpr(expr.cond, boolean);
      const then = checkExpr(expr.then, expected);
      const otherwise = checkExpr(expr.else, expected);
      typed(expr, expected);
      return { kind: "if", cond, then, otherwise, type: expected, span: expr.span };
    }
    if (expr.kind === "let") {
      const checked = elaborateLet(expr, expected);
      return { ...checked, type: expected };
    }
    if (expr.kind === "match") {
      const checked = elaborateMatch(expr, expected);
      return { ...checked, type: expected };
    }
    if (expr.kind === "group" && expr.annotation) {
      const checked = checkExpr(expr.value, resolveType(expr.annotation));
      return checked;
    }
    const checked = elaborate(expr);
    if (subsumes(checked.type, expected, expr)) return { ...checked, type: expected };
    return checked;
  };

  const elaborate = (expr: Base | Expr): Checked => {
    switch (expr.kind) {
      case "number": {
        const value = Number(expr.value.text);
        if (!Number.isFinite(value)) error("Number literal is too large", expr);
        typed(expr, number);
        return { kind: "number", value, type: number, span: expr.span };
      }
      case "true":
      case "false": {
        typed(expr, boolean);
        return { kind: "boolean", value: expr.kind === "true", type: boolean, span: expr.span };
      }
      case "string": {
        let value: string;
        try {
          value = JSON.parse(expr.value.text) as string;
        } catch {
          error("Invalid string literal", expr);
          value = "";
        }
        typed(expr, string);
        return { kind: "string", value, type: string, span: expr.span };
      }
      case "name": {
        const binding = cx.resolve(expr.value.text, expr.value);
        const entry = lookupEntry(expr.value.text);
        if (!binding || !entry) {
          error(`Unknown name ${JSON.stringify(expr.value.text)}`, expr.value);
          return placeholder(expr.span);
        }
        if (entry.constructor) {
          const type = instantiateForall(instantiate(entry.scheme, context.level), context.level);
          typed(expr, type);
          return {
            kind: "constructor",
            constructor: entry.constructor,
            binding,
            type,
            span: expr.span,
          };
        }
        const type = instantiateForall(instantiate(entry.scheme, context.level), context.level);
        typed(expr, type);
        return {
          kind: "name",
          binding,
          builtin: entry.builtin,
          type,
          span: expr.span,
        };
      }
      case "record":
        return elaborateRecord(expr);
      case "group": {
        if (expr.annotation) return checkExpr(expr.value, resolveType(expr.annotation));
        return elaborate(expr.value);
      }
      case "let":
        return elaborateLet(expr);
      case "fn":
        return elaborateFn(expr);
      case "if":
        return elaborateIf(expr);
      case "match":
        return elaborateMatch(expr);
      case "binary":
        return elaborateBinary(expr);
      case "prefix": {
        const operand = elaborate(expr.operand);
        const operator = expr.operator.text;
        if (operator === "-") expectNumber(operand.type, expr.operand);
        else expectBoolean(operand.type, expr.operand);
        const type = operator === "-" ? number : boolean;
        typed(expr, type);
        return { kind: "prefix", operator, operand, type, span: expr.span };
      }
      case "postfix": {
        if ("base" in expr) return elaboratePostfix(expr);
        error("Unexpected postfix expression", expr);
        return placeholder(expr.span);
      }
    }
  };

  const installPrint = (): void => {
    const parameter = fresh(0);
    const unit = record(row());
    const type = fn(parameter, unit);
    const binding = cx.declare("print", { start: 0, end: 0 }, "function", type, { detail: "builtin" });
    cx.typed(binding.span, type);
    bindEntry("print", { binding, scheme: generalize(type, []), constructor: null, builtin: "print" });
  };

  const installImports = (): void => {
    for (const dependency of cx.dependencies.all) {
      const module = dependency.module as AdvancedModule | null;
      if (!module) continue;
      const names: { exported: string; binding: Binding<Type> }[] = [];
      for (const exported of module.exports) {
        const previous = context.imported.get(exported.name);
        if (previous !== undefined && previous !== dependency.uri) {
          error(
            `Import ${JSON.stringify(dependency.specifier)} also exports ${JSON.stringify(exported.name)} from a different module`,
            dependency.span,
          );
          continue;
        }
        context.imported.set(exported.name, dependency.uri);
        const binding = cx.alias(exported.binding, exported.binding.uri ?? dependency.uri);
        const constructor = exported.kind === "constructor"
          ? {
            ...exported.constructor,
            binding,
          }
          : null;
        bindEntry(exported.name, {
          binding,
          scheme: exported.scheme,
          constructor,
          builtin: null,
        });
        if (constructor) context.constructors.set(exported.name, constructor);
        names.push({ exported: exported.name, binding });
      }
      for (const info of module.types) {
        const existing = context.types.get(info.name.text);
        if (existing) {
          if (existing.uri !== info.uri) {
            error(`Import ${JSON.stringify(dependency.specifier)} also defines type ${JSON.stringify(info.name.text)}`, dependency.span);
          }
          continue;
        }
        const binding = cx.alias(info.binding, info.binding.uri ?? dependency.uri);
        const constructors = info.constructors.flatMap((constructor) => {
          const local = context.constructors.get(constructor.name);
          if (local) return [local];
          const aliased = cx.alias(constructor.binding, constructor.binding.uri ?? dependency.uri);
          const value: ConstructorInfo = { ...constructor, binding: aliased };
          context.constructors.set(constructor.name, value);
          return [value];
        });
        context.types.set(info.name.text, { ...info, binding, constructors });
        context.typeBindings.set(info.name.text, binding);
        context.datatypes.set(info.name.text, dependency.uri);
      }
      if (names.length > 0) context.moduleImports.push({ specifier: dependency.specifier, names });
    }
  };

  const hoistTypes = (declarations: readonly DataDecl[]): void => {
    for (const declaration of declarations) {
      const name = declaration.name.text;
      if (!isUpper(name)) {
        error(`Type names must start with an uppercase letter`, declaration.name);
        continue;
      }
      if (context.types.has(name) || name === "number" || name === "boolean" || name === "string") {
        error(`Duplicate type ${JSON.stringify(name)}`, declaration.name);
        continue;
      }
      const parameters = declaration.parameters ?? [];
      const seen = new Set<string>();
      for (const parameter of parameters) {
        if (seen.has(parameter.text)) {
          error(`Duplicate type parameter ${JSON.stringify(parameter.text)}`, parameter);
        }
        seen.add(parameter.text);
      }
      if (declaration.constructors.length === 0) {
        error("Data type requires a constructor", declaration);
        continue;
      }
      const constructor: TypeConstructor = { id: Symbol(name), name, arity: parameters.length };
      const type = data(constructor, parameters.map((parameter) => generic(parameter.text)));
      const binding = declare(declaration.name, "type", type, "type");
      const info: DataInfo = {
        name: declaration.name,
        parameters: parameters.map((parameter) => parameter.text),
        constructor,
        constructors: [],
        binding,
        uri: cx.uri,
        span: declaration.span,
      };
      context.types.set(name, info);
      context.typeBindings.set(name, binding);
      context.datatypes.set(name, cx.uri);
    }
  };

  const installConstructors = (declarations: readonly DataDecl[]): void => {
    for (const declaration of declarations) {
      const info = context.types.get(declaration.name.text);
      if (!info || info.uri !== cx.uri || info.span !== declaration.span) continue;
      const variables = info.parameters.map((parameter) => generic(parameter));
      const parameters = new Map<string, Type>(variables.map((variable) => [variable.name, variable]));
      const result = data(info.constructor, variables);
      const constructors: ConstructorInfo[] = [];
      for (const syntax of declaration.constructors) {
        const name = syntax.name.text;
        if (!isUpper(name)) {
          error("Constructor names must start with an uppercase letter", syntax.name);
          continue;
        }
        if (context.constructors.has(name) || env.has(name)) {
          error(`Duplicate constructor ${JSON.stringify(name)}`, syntax.name);
          continue;
        }
        const fields: Type[] = [];
        for (const field of syntax.fields ?? []) {
          const type = resolveType(field, parameters);
          if (prune(type).kind === "forall") {
            error("Polymorphic constructor fields are not supported", field);
            fields.push(fresh(context.level));
            continue;
          }
          fields.push(type);
        }
        let type: Type = result;
        for (const field of fields.toReversed()) type = fn(field, type);
        if (variables.length > 0) type = forall(variables, type);
        const binding = cx.declare(
          name,
          syntax.name.span,
          fields.length === 0 ? "constant" : "function",
          type,
          { detail: info.name.text },
        );
        cx.typed(syntax.name, type);
        const constructor: ConstructorInfo = {
          name,
          binding,
          scheme: mono(type),
          type,
          arity: fields.length,
          tag: dotted(info.name.text, name),
          owner: info.constructor,
          span: syntax.name.span,
          uri: cx.uri,
        };
        context.constructors.set(name, constructor);
        constructors.push(constructor);
        bindValue(syntax.name, binding, mono(type), constructor);
      }
      const current = context.types.get(info.name.text);
      if (current) context.types.set(info.name.text, { ...current, constructors });
    }
  };

  const exportValue = (
    name: string,
    binding: Binding<Type>,
    scheme: Scheme,
    fieldType: Type,
    span: Span,
    exports: ExportIR[],
    names: Set<string>,
  ): void => {
    if (names.has(name)) {
      error(`Duplicate export ${JSON.stringify(name)}`, span);
      return;
    }
    if (name === "default") {
      error(`The name "default" conflicts with the default export`, span);
      return;
    }
    names.add(name);
    exports.push({ kind: "field", name, binding, scheme, fieldType, span });
  };

  const finalRecord = (value: Checked): Extract<Checked, { readonly kind: "record" }> | null => {
    if (value.kind === "record") return value;
    if (value.kind === "let") return finalRecord(value.body);
    return null;
  };

  const makeExports = (body: Checked, resultType: Type): ExportIR[] => {
    const exports: ExportIR[] = [];
    const names = new Set<string>();
    for (const info of context.types.values()) {
      if (info.uri !== cx.uri) continue;
      for (const constructor of info.constructors) {
        if (names.has(constructor.name)) {
          error(`Duplicate export ${JSON.stringify(constructor.name)}`, constructor.span);
          continue;
        }
        names.add(constructor.name);
        exports.push({
          kind: "constructor",
          name: constructor.name,
          binding: constructor.binding,
          scheme: constructor.scheme,
          constructor,
        });
      }
    }
    const type = prune(resultType);
    if (type.kind !== "record" || flatten(type.row).tail !== null) return exports;
    const recordValue = finalRecord(body);
    for (const [name, fieldType] of flatten(type.row).fields) {
      const field = recordValue?.fields.find((entry) => entry.name === name);
      const bound = field?.value.kind === "name" ? field.value.binding : undefined;
      const source = bound && (bound.uri === undefined || bound.uri === cx.uri)
        ? bound.span
        : field?.span ?? body.span;
      const binding = cx.declare(
        name,
        source,
        prune(fieldType).kind === "function" || prune(fieldType).kind === "forall" ? "function" : "variable",
        fieldType,
        { detail: "export" },
      );
      cx.typed(source, fieldType);
      const scheme = generalize(fieldType, schemes());
      exportValue(name, binding, scheme, fieldType, source, exports, names);
    }
    return exports;
  };

  // Builtins first so a dependency or local declaration can shadow `print`.
  installPrint();
  installImports();
  const declarations = file.items.filter((declaration): declaration is DataDecl => declaration.kind === "type");
  hoistTypes(declarations);
  installConstructors(declarations);

  const bodies = file.items.filter((item): item is Body => item.kind === "body");
  if (bodies.length === 0) error("A module needs a body expression", file);
  if (bodies.length > 1) error("A module has only one body expression", bodies[1]!);
  const bodyItem = bodies.at(-1);
  if (bodyItem && file.items.at(-1) !== bodyItem) {
    error("The body expression must be last", bodyItem);
  }
  let body: Checked;
  const checked = bodyItem ? cx.check(() => elaborate(bodyItem.expression)) : undefined;
  body = checked ?? placeholder(bodyItem?.span ?? file.span);
  const resultType = body.type;
  const exports = makeExports(body, resultType);
  const print = printer(context.datatypes);
  for (const exported of exports) {
    if (exported.kind === "constructor") {
      const printed = print(exported.constructor.type);
      if (printed.problem !== undefined && nullaryConstructorText(exported.constructor.type, context.datatypes) === undefined) {
        error(`TypeScript cannot represent ${exported.name}: ${printed.problem}`, exported.constructor.span);
      }
      continue;
    }
    const printed = print(exported.fieldType);
    if (printed.problem !== undefined) {
      error(`TypeScript cannot represent ${exported.name}: ${printed.problem}`, exported.span);
    }
  }
  const result = prune(resultType);
  if (result.kind !== "record" || flatten(result.row).tail !== null) {
    const printed = print(result);
    if (printed.problem !== undefined) {
      error(`TypeScript cannot represent the module result: ${printed.problem}`, body.span);
    }
  }
  return {
    uri: cx.uri,
    types: [...context.types.values()].filter((info) => info.uri === cx.uri),
    constructors: [...context.types.values()]
      .filter((info) => info.uri === cx.uri)
      .flatMap((info) => info.constructors),
    body,
    resultType,
    exports,
    datatypes: new Map(context.datatypes),
    imports: context.moduleImports,
  };
};

export const check = (file: File, cx: Checker<Type>): AdvancedModule => run(file, cx);

export const describeBinding = (binding: Binding<Type>): string | undefined => {
  if (!binding.type) return undefined;
  return `${binding.kind} ${binding.name}: ${display(binding.type)}`;
};
