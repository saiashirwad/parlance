import { type Diagnostic, error, sortDiagnostics, warning } from "../diagnostic.ts";
import type { Alternative, Body, GrammarFile, Item, Primary, Rule, Unary } from "./ast.ts";

/** The result of deriving TypeScript declarations for a grammar. */
export type Generated = { readonly text: string; readonly diagnostics: readonly Diagnostic[] };

type Field = { readonly name: string; readonly type: string };

type NodeShape = {
  readonly name: string;
  readonly rule: string;
  readonly tag: string;
  readonly signature: string;
  readonly fields: readonly Field[];
};

type FixedNode = {
  readonly name: string;
  readonly kind: "binary" | "prefix" | "postfix";
};

const helpSpan = "export type Span = { readonly start: number; readonly end: number };";
const helpText = "export type Text = { readonly text: string; readonly span: Span };";

/** Type-position words that cannot name a declaration in TypeScript. */
const reservedTypeNames = new Set([
  "abstract",
  "any",
  "as",
  "asserts",
  "async",
  "await",
  "bigint",
  "boolean",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "constructor",
  "continue",
  "debugger",
  "declare",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "get",
  "global",
  "if",
  "implements",
  "import",
  "in",
  "infer",
  "instanceof",
  "interface",
  "is",
  "keyof",
  "let",
  "module",
  "namespace",
  "never",
  "new",
  "null",
  "number",
  "object",
  "of",
  "package",
  "private",
  "protected",
  "public",
  "readonly",
  "require",
  "return",
  "satisfies",
  "set",
  "static",
  "string",
  "super",
  "switch",
  "symbol",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "unique",
  "unknown",
  "using",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

const helperNames = new Set(["Span", "Text"]);

const unique = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
};

const renderType = (members: readonly string[]): string => {
  if (members.length === 0) return "never";
  if (members.length === 1) return members[0]!;
  return members.join(" | ");
};

const arrayOf = (members: readonly string[]): string => {
  const element = renderType(members);
  const simple = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(element) || element === "null" || element === "never";
  return `readonly ${simple ? element : `(${element})`}[]`;
};

const tupleOf = (members: readonly (readonly string[])[]): string =>
  `readonly [${members.map(renderType).join(", ")}]`;

const pascal = (value: string): string =>
  value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);

const propertyName = (value: string): string =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : JSON.stringify(value);

/** Independent re-derivation of compile.ts's capture decision, used for untagged sequences. */
const capturesOfItem = (item: Item): boolean =>
  item.label === null ? capturesOfUnary(item.expr) : item.label.text !== "_";

const capturesOfAlternative = (alternative: Alternative): boolean =>
  alternative.items.some(capturesOfItem);

const capturesOfUnary = (unary: Unary): boolean => {
  switch (unary.kind) {
    case "and":
    case "not":
      return false;
    case "star":
    case "plus":
    case "opt":
      return capturesOfUnary(unary.expr);
    default:
      return capturesOfPrimary(unary);
  }
};

const capturesOfPrimary = (primary: Primary): boolean => {
  switch (primary.kind) {
    case "lit":
    case "cut":
      return false;
    case "word":
    case "token":
    case "re":
    case "ref":
      return true;
    case "group":
      return primary.alts.some(capturesOfAlternative);
    case "sep":
    case "sep1":
    case "sepEnd":
    case "sepEnd1":
      return capturesOfUnary(primary.item);
  }
};

const renderInterface = (name: string, tag: string, fields: readonly Field[]): string => {
  const body = [
    `  readonly kind: ${JSON.stringify(tag)};`,
    ...fields.map((field) => `  readonly ${propertyName(field.name)}: ${field.type};`),
    "  readonly span: Span;",
  ];
  return `export interface ${name} {\n${body.join("\n")}\n}`;
};

const renderFixed = (node: FixedNode, ruleType: string): string => {
  const fields = node.kind === "binary"
    ? [
      "  readonly operator: Text;",
      `  readonly left: ${ruleType};`,
      `  readonly right: ${ruleType};`,
      "  readonly span: Span;",
    ]
    : [
      "  readonly operator: Text;",
      `  readonly operand: ${ruleType};`,
      "  readonly span: Span;",
    ];
  return `export interface ${node.name} {\n  readonly kind: ${JSON.stringify(node.kind)};\n${fields.join("\n")}\n}`;
};

const renderAlias = (name: string, members: readonly string[]): string => {
  if (members.length === 0) return `export type ${name} = never;`;
  if (members.length === 1) return `export type ${name} = ${members[0]};`;
  return `export type ${name} =\n${members.map((member) => `  | ${member}`).join("\n")};`;
};

/**
 * Derives one TypeScript module describing the values that a compiled grammar
 * parser returns. Diagnostics report names that had to change and any shape
 * that cannot be represented by a single interface.
 */
export const generateTypes = (file: GrammarFile): Generated => {
  const diagnostics: Diagnostic[] = [];
  const ruleTypes = new Map<string, string>();
  const rules = new Map<string, Rule>();
  const usedNames = new Set<string>(helperNames);

  for (const rule of file.rules) {
    const raw = rule.name.text;
    if (rules.has(raw)) {
      diagnostics.push(error(`Duplicate rule ${raw}`, rule.name.span, { code: "grammar/duplicate-rule" }));
      continue;
    }
    rules.set(raw, rule);
  }

  for (const rule of rules.values()) {
    const raw = rule.name.text;
    let base = raw;
    if (helperNames.has(raw)) {
      base = `${raw}Rule`;
      diagnostics.push(warning(
        `Rule ${raw} conflicts with the generated ${raw} helper type; emitting it as ${base}`,
        rule.name.span,
        { code: "grammar-types/helper-name" },
      ));
    } else if (reservedTypeNames.has(raw)) {
      base = `${raw}Rule`;
      diagnostics.push(warning(
        `Rule ${raw} is a TypeScript reserved word; emitting it as ${base}`,
        rule.name.span,
        { code: "grammar-types/reserved-name" },
      ));
    }
    let name = base;
    if (usedNames.has(name)) {
      let suffix = 2;
      while (usedNames.has(`${base}${suffix}`)) suffix++;
      name = `${base}${suffix}`;
      diagnostics.push(warning(
        `Rule ${raw} collides with an existing generated type; emitting it as ${name}`,
        rule.name.span,
        { code: "grammar-types/name-collision" },
      ));
    }
    usedNames.add(name);
    ruleTypes.set(raw, name);
  }

  const shapes = new Map<string, NodeShape[]>();
  const nodeOrder: NodeShape[] = [];
  const precedence = new Map<string, readonly FixedNode[]>();

  const allocateName = (base: string, at: { readonly start: number; readonly end: number }, reason: string): string => {
    let name = base;
    if (usedNames.has(name)) {
      let suffix = 2;
      while (usedNames.has(`${base}${suffix}`)) suffix++;
      name = `${base}${suffix}`;
      diagnostics.push(warning(`${reason}; emitting it as ${name}`, at, { code: "grammar-types/name-collision" }));
    }
    usedNames.add(name);
    return name;
  };

  const nodeFor = (alternative: Alternative, rule: string): string => {
    const tag = alternative.tag!.text;
    const fields: Field[] = [];
    const seen = new Set<string>();
    for (const item of alternative.items) {
      if (item.label === null) continue;
      const label = item.label.text;
      if (label === "_") continue;
      if (label === "kind" || label === "span") {
        diagnostics.push(warning(
          `Field label ${label} in @${tag} is overwritten by the node ${label}`,
          item.span,
          { code: "grammar-types/reserved-field" },
        ));
        continue;
      }
      if (seen.has(label)) {
        diagnostics.push(error(`Duplicate field label ${label} in @${tag}`, item.span, {
          code: "grammar/duplicate-field",
        }));
        continue;
      }
      seen.add(label);
      fields.push({ name: label, type: renderType(valueOfUnary(item.expr, rule)) });
    }

    const signature = JSON.stringify(fields.map((field) => [field.name, field.type]));
    const key = `${rule}\u0000${tag}`;
    const list = shapes.get(key) ?? [];
    const existing = list.find((shape) => shape.signature === signature);
    if (existing) return existing.name;

    const base = `${rule}${pascal(tag)}Node`;
    const candidate = list.length === 0 ? base : `${base}${list.length + 1}`;
    const name = allocateName(
      candidate,
      alternative.span,
      `Generated name ${candidate} collides with an existing type`,
    );
    const shape: NodeShape = { name, rule, tag, signature, fields };
    list.push(shape);
    shapes.set(key, list);
    nodeOrder.push(shape);
    if (list.length > 1) {
      diagnostics.push(warning(
        `Tag @${tag} in rule ${rule} has more than one field shape; emitting ${name}`,
        alternative.span,
        { code: "grammar-types/tag-shape" },
      ));
    }
    return name;
  };

  const valueOfPrimary = (primary: Primary, rule: string): readonly string[] => {
    switch (primary.kind) {
      case "lit":
      case "word":
      case "token":
      case "re":
        return ["Text"];
      case "cut":
        return ["null"];
      case "ref": {
        const target = ruleTypes.get(primary.name.text);
        if (target === undefined) {
          diagnostics.push(error(`Unknown rule ${primary.name.text}`, primary.name.span, {
            code: "grammar/unknown-rule",
          }));
          return ["never"];
        }
        return [target];
      }
      case "group":
        return primary.alts.flatMap((alternative) => valueOfAlternative(alternative, rule));
      case "sep":
      case "sep1":
      case "sepEnd":
      case "sepEnd1":
        return [arrayOf(valueOfUnary(primary.item, rule))];
    }
  };

  const valueOfUnary = (unary: Unary, rule: string): readonly string[] => {
    switch (unary.kind) {
      case "and":
      case "not":
        return ["null"];
      case "star":
      case "plus":
        return [arrayOf(valueOfUnary(unary.expr, rule))];
      case "opt":
        return unique([...valueOfUnary(unary.expr, rule), "null"]);
      default:
        return valueOfPrimary(unary, rule);
    }
  };

  const valueOfAlternative = (alternative: Alternative, rule: string): readonly string[] => {
    if (alternative.tag !== null) return [nodeFor(alternative, rule)];
    const captured: (readonly string[])[] = [];
    for (const item of alternative.items) {
      if (!capturesOfItem(item)) continue;
      captured.push(valueOfUnary(item.expr, rule));
    }
    if (captured.length === 0) return ["null"];
    if (captured.length === 1) return captured[0]!;
    return [tupleOf(captured)];
  };

  const valueOfAlternatives = (alternatives: readonly Alternative[], rule: string): readonly string[] =>
    alternatives.flatMap((alternative) => valueOfAlternative(alternative, rule));

  const membersOf = (body: Body, rule: string): readonly string[] => {
    if (body.kind === "alternatives") return valueOfAlternatives(body.alts, rule);
    const binary = allocateName(
      `${rule}BinaryNode`,
      body.span,
      `Precedence node ${rule}BinaryNode collides with an existing generated type`,
    );
    const prefix = allocateName(
      `${rule}PrefixNode`,
      body.span,
      `Precedence node ${rule}PrefixNode collides with an existing generated type`,
    );
    const postfix = allocateName(
      `${rule}PostfixNode`,
      body.span,
      `Precedence node ${rule}PostfixNode collides with an existing generated type`,
    );
    const fixed: readonly FixedNode[] = [
      { name: binary, kind: "binary" },
      { name: prefix, kind: "prefix" },
      { name: postfix, kind: "postfix" },
    ];
    precedence.set(rule, fixed);
    return [...valueOfAlternatives(body.atom, rule), binary, prefix, postfix];
  };

  const membersByRule = new Map<string, readonly string[]>();
  for (const rule of rules.values()) {
    const raw = rule.name.text;
    membersByRule.set(raw, membersOf(rule.body, raw));
  }

  const ruleByTypeName = new Map<string, string>();
  for (const [raw, typeName] of ruleTypes) ruleByTypeName.set(typeName, raw);

  const aliasEdges = new Map<string, ReadonlySet<string>>();
  for (const [raw, members] of membersByRule) {
    const targets = new Set<string>();
    for (const member of members) {
      const target = ruleByTypeName.get(member);
      if (target !== undefined) targets.add(target);
    }
    aliasEdges.set(raw, targets);
  }

  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const stack = [...(aliasEdges.get(from) ?? [])];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === to) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      stack.push(...(aliasEdges.get(current) ?? []));
    }
    return false;
  };
  const cyclic = new Set<string>();
  for (const raw of rules.keys()) if (reaches(raw, raw)) cyclic.add(raw);

  /** A bare alias cycle is invalid TypeScript; inline cyclic aliases until the cycle is gone. */
  const membersFor = (raw: string): readonly string[] => {
    const ruleType = ruleTypes.get(raw)!;
    const members = membersByRule.get(raw) ?? [];
    if (!cyclic.has(raw)) return unique(members.filter((member) => member !== ruleType));
    const result: string[] = [];
    const stack = new Set<string>([raw]);
    const expand = (member: string): void => {
      const target = ruleByTypeName.get(member);
      if (target !== undefined && cyclic.has(target) && !stack.has(target)) {
        stack.add(target);
        for (const next of membersByRule.get(target) ?? []) expand(next);
        stack.delete(target);
        return;
      }
      result.push(member);
    };
    for (const member of members) expand(member);
    return unique(result.filter((member) => member !== ruleType));
  };

  const chunks: string[] = [
    `// Generated by parlance from ${file.name.text}. Do not edit.`,
    helpSpan,
    helpText,
  ];

  for (const rule of rules.values()) {
    const raw = rule.name.text;
    const ruleType = ruleTypes.get(raw)!;
    for (const shape of nodeOrder) {
      if (shape.rule !== raw) continue;
      chunks.push(renderInterface(shape.name, shape.tag, shape.fields));
    }
    for (const fixed of precedence.get(raw) ?? []) chunks.push(renderFixed(fixed, ruleType));
    chunks.push(renderAlias(ruleType, membersFor(raw)));
  }

  return {
    text: `${chunks.join("\n\n")}\n`,
    diagnostics: sortDiagnostics(diagnostics),
  };
};
