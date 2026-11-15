import { type Diagnostic, error, sortDiagnostics, warning } from "../diagnostic.ts";
import { type Span, type Text } from "../source.ts";
import { tokenKinds, type TokenKind, type Token } from "../check/facts.ts";
import { lex as lexTokens } from "../parser/lex.ts";
import { EOF, ERROR, highlightCode } from "../parser/tokens.ts";
import { type ParseOptions, type ParseResult, parseSource } from "../parser/parse.ts";
import {
  type GrammarSpec,
  type InlineSpec,
  type Key,
  type KeyId,
  type LexToken,
  type PExpr,
  type PrecLevel,
  type SeqItem,
  type SymbolSpec,
  type TokenSpec,
} from "../parser/spec.ts";
import type { TokenList } from "../parser/tokens.ts";
import { parseGrammar as parseGrammarSource } from "./parse.ts";
import {
  type Alternative,
  type Body,
  type GrammarFile,
  type Item,
  type Primary,
  type Unary,
} from "./ast.ts";

export type CompiledGrammar<A = unknown> = {
  readonly name: string;
  readonly uri: string;
  readonly file: GrammarFile;
  readonly spec: GrammarSpec;
  readonly valid: boolean;
  readonly diagnostics: readonly Diagnostic[];
  parse(source: string, options?: ParseOptions): ParseResult<A>;
  lex(source: string): TokenList;
  highlight(source: string): Token[];
  highlightTokens(tokens: TokenList): Token[];
};

type Context = {
  readonly file: GrammarFile;
  readonly uri: string;
  readonly diagnostics: Diagnostic[];
  readonly wordSource: string;
  readonly wordFull: RegExp;
  readonly tokens: Map<string, TokenSpec>;
  readonly rules: Map<string, number>;
  readonly inline: InlineSpec[];
  readonly inlineIndex: Map<string, number>;
  readonly symbols: Set<string>;
  readonly keywords: Set<string>;
};

const defaultWord = "[A-Za-z_][A-Za-z0-9_]*";

const decodeString = (raw: string, span: Span): { text: string; span: Span } => {
  const inner = raw.startsWith("\"") && raw.endsWith("\"") ? raw.slice(1, -1) : raw;
  try {
    return { text: JSON.parse(raw), span: { start: span.start + 1, end: span.end - 1 } };
  } catch {
    const text = inner.replace(/\\(["\\/bfnrt])/g, (_, letter: string) => {
      switch (letter) {
        case "b":
          return "\b";
        case "f":
          return "\f";
        case "n":
          return "\n";
        case "r":
          return "\r";
        case "t":
          return "\t";
        default:
          return letter;
      }
    }).replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    return { text, span: { start: span.start + 1, end: span.end - 1 } };
  }
};

const decodePattern = (raw: string): string => {
  const inner = raw.startsWith("/") && raw.endsWith("/") ? raw.slice(1, -1) : raw;
  return inner.replace(/\\\//g, "/");
};

const compilePattern = (
  source: string,
  span: Span,
  diagnostics: Diagnostic[],
  label: string,
): RegExp | undefined => {
  try {
    const regex = new RegExp(source, "y");
    regex.lastIndex = 0;
    const empty = regex.exec("");
    if (empty && empty[0].length === 0) {
      diagnostics.push(error(`${label} must consume at least one character`, span, { code: "grammar/empty-pattern" }));
      return undefined;
    }
    return regex;
  } catch (cause) {
    diagnostics.push(
      error(`Invalid ${label}: ${cause instanceof Error ? cause.message : String(cause)}`, span, {
        code: "grammar/pattern",
      }),
    );
    return undefined;
  }
};

const text = (value: Text): string => value.text;

const bitmap = (characters: string): Uint8Array => {
  const result = new Uint8Array(128);
  for (const character of characters) result[character.charCodeAt(0)] = 1;
  return result;
};

const firstChars = (source: string): Uint8Array | null => {
  if (source.startsWith("\\d") || source.startsWith("[0-9") || source.startsWith("[\\d")) {
    return bitmap("0123456789");
  }
  if (source.startsWith("\\w") || source.startsWith("[A-Za-z_") || source.startsWith("[a-zA-Z_")) {
    return bitmap(
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_0123456789",
    );
  }
  const first = source[0];
  if (first === '"' || first === "'" || first === "\\") {
    if (source.startsWith('\\"')) return bitmap('"');
    if (source.startsWith("\\/")) return bitmap("/");
    if (first === '"' || first === "'") return bitmap(first);
  }
  if (first === "/") return bitmap("/");
  if (first !== undefined && /[A-Za-z0-9_+\-*/=<>!&|;:,.(){}[\]]/.test(first)) return bitmap(first);
  return null;
};

const fastToken = (source: string): number => {
  if (source === "\\d+" || source === "[0-9]+") return 1;
  if (source === "\\d+(?:\\.\\d+)?" || source === "[0-9]+(?:\\.[0-9]+)?") return 2;
  return 0;
};

const isFastWhitespace = (source: string): boolean =>
  /^\\s[+]?$/.test(source) || /^\[\\s\][+]?$/.test(source);

/** A line-comment pattern the fixed scanner reproduces: no escapes that could cross a newline. */
const isFastLineComment = (source: string): boolean =>
  source.startsWith("//") && !/\\(?:s|r|u)|\[\^\]/.test(source);

/** A block-comment pattern the fixed scanner reproduces: it runs to the first closing delimiter. */
const isFastBlockComment = (source: string): boolean =>
  /^\/\\\*\[\\s\\S\]\*\?\\\*\/$/.test(source) || /^\/\\\*\[\^\\\*\]\*\\\*\/$/.test(source);

const highlightOf = (name: string): TokenKind | undefined => {
  const direct = tokenKinds.find((kind) => kind === name);
  if (direct) return direct;
  return undefined;
};

const defaultHighlight = (name: string): TokenKind => {
  if (/str|text/i.test(name)) return "string";
  if (/num|int|float|decimal/i.test(name)) return "number";
  if (/regex|pattern/i.test(name)) return "regexp";
  if (/comment/i.test(name)) return "comment";
  return "variable";
};

const union = (sets: Iterable<ReadonlySet<KeyId>>): Set<KeyId> => {
  const result = new Set<KeyId>();
  for (const set of sets) for (const key of set) result.add(key);
  return result;
};

const EMPTY_BITS = new Uint8Array(0);

const unionRules = (sets: Iterable<ReadonlySet<number>>): Set<number> => {
  const result = new Set<number>();
  for (const set of sets) for (const rule of set) result.add(rule);
  return result;
};

export const compileGrammar = <A = unknown>(file: GrammarFile, uri = "grammar.parl"): CompiledGrammar<A> => {
  const diagnostics: Diagnostic[] = [];
  const wordSource = file.word ? decodePattern(file.word.pattern.text) : defaultWord;
  let wordFull: RegExp;
  let wordRegex: RegExp;
  try {
    wordFull = new RegExp(`^(?:${wordSource})$`);
    wordRegex = new RegExp(wordSource, "y");
  } catch {
    diagnostics.push(error("Invalid word pattern", file.word?.pattern.span ?? file.span, { code: "grammar/word" }));
    wordFull = new RegExp(`^(?:${defaultWord})$`);
    wordRegex = new RegExp(defaultWord, "y");
  }
  const keyIds = new Map<Key, KeyId>();
  const keyText: Key[] = [];
  const intern = (key: Key): KeyId => {
    let id = keyIds.get(key);
    if (id === undefined) {
      id = keyText.length;
      keyIds.set(key, id);
      keyText.push(key);
    }
    return id;
  };
  const tokens = new Map<string, TokenSpec>();
  const rules = new Map<string, number>();

  for (const declaration of file.tokens) {
    const name = text(declaration.name);
    if (tokens.has(name)) {
      diagnostics.push(error(`Duplicate token ${name}`, declaration.name.span, { code: "grammar/duplicate-token" }));
      continue;
    }
    const source = decodePattern(declaration.pattern.text);
    const regex = compilePattern(source, declaration.pattern.span, diagnostics, `token ${name}`);
    if (!regex) continue;
    const highlight = declaration.highlight
      ? highlightOf(text(declaration.highlight.name))
      : defaultHighlight(name);
    if (declaration.highlight && highlight === undefined) {
      diagnostics.push(
        error(`Unknown highlight kind ${JSON.stringify(text(declaration.highlight.name))}`, declaration.highlight.name.span, {
          code: "grammar/highlight",
        }),
      );
    }
    tokens.set(name, {
      name,
      source,
      regex,
      first: firstChars(source),
      highlight: highlight ?? defaultHighlight(name),
      highlightCode: highlightCode(highlight ?? defaultHighlight(name)),
      fast: fastToken(source),
      keyId: intern(`token:${name}`),
      span: declaration.name.span,
    });
  }

  for (const [index, rule] of file.rules.entries()) {
    const name = text(rule.name);
    if (rules.has(name)) {
      diagnostics.push(error(`Duplicate rule ${name}`, rule.name.span, { code: "grammar/duplicate-rule" }));
      continue;
    }
    if (name === "word") {
      diagnostics.push(error("`word` is a built-in expression and cannot be a rule name", rule.name.span, {
        code: "grammar/reserved",
      }));
      continue;
    }
    rules.set(name, index);
  }

  const context: Context = {
    file,
    uri,
    diagnostics,
    wordSource,
    wordFull,
    tokens,
    rules,
    inline: [],
    inlineIndex: new Map(),
    symbols: new Set(),
    keywords: new Set(),
  };

  const skips: RegExp[] = [];
  const skipSources: string[] = [];
  for (const skip of file.skips) {
    const source = decodePattern(skip.pattern.text);
    const regex = compilePattern(source, skip.pattern.span, diagnostics, "skip pattern");
    if (regex) {
      skips.push(regex);
      skipSources.push(source);
    }
  }

  const internals = (primary: Primary, seen: Set<Primary>): { expr: PExpr; captures: boolean } => {
    switch (primary.kind) {
      case "lit": {
        const literal = decodeString(primary.text.text, primary.text.span);
        if (literal.text.length === 0) {
          diagnostics.push(error("An empty literal cannot be matched", primary.span, { code: "grammar/empty-literal" }));
          return { expr: { t: "cut", first: EMPTY_BITS, nullable: true, span: primary.span }, captures: false };
        }
        const word = wordFull.test(literal.text);
        if (word) context.keywords.add(literal.text);
        else context.symbols.add(literal.text);
        return {
          expr: {
            t: "lit",
            text: literal.text,
            word,
            keyId: intern(word ? `word:${literal.text}` : `symbol:${literal.text}`),
            first: EMPTY_BITS,
            nullable: false,
            span: primary.span,
          },
          captures: false,
        };
      }
      case "word":
        return { expr: { t: "word", first: EMPTY_BITS, nullable: false, span: primary.span }, captures: true };
      case "token": {
        const name = text(primary.name);
        const token = context.tokens.get(name);
        if (!token) {
          diagnostics.push(error(`Unknown token $${name}`, primary.name.span, { code: "grammar/unknown-token" }));
          return { expr: { t: "cut", first: EMPTY_BITS, nullable: true, span: primary.span }, captures: false };
        }
        return {
          expr: { t: "token", name, index: [...context.tokens.keys()].indexOf(name), keyId: token.keyId, first: EMPTY_BITS, nullable: false, span: primary.span },
          captures: true,
        };
      }
      case "re": {
        const source = decodePattern(primary.source.text);
        let index = context.inlineIndex.get(source);
        if (index === undefined) {
          const regex = compilePattern(source, primary.source.span, diagnostics, "regular expression");
          if (!regex) return { expr: { t: "cut", first: EMPTY_BITS, nullable: true, span: primary.span }, captures: false };
          index = context.inline.length;
          context.inline.push({ source, regex, keyId: intern(`regex:${index}`), span: primary.source.span });
          context.inlineIndex.set(source, index);
        }
        return { expr: { t: "re", index, keyId: context.inline[index]!.keyId, first: EMPTY_BITS, nullable: false, span: primary.span }, captures: true };
      }
      case "cut":
        return { expr: { t: "cut", first: EMPTY_BITS, nullable: true, span: primary.span }, captures: false };
      case "ref": {
        const name = text(primary.name);
        const rule = context.rules.get(name);
        if (rule === undefined) {
          diagnostics.push(error(`Unknown rule ${name}`, primary.name.span, { code: "grammar/unknown-rule" }));
          return { expr: { t: "cut", first: EMPTY_BITS, nullable: true, span: primary.span }, captures: false };
        }
        return { expr: { t: "ref", rule, first: EMPTY_BITS, nullable: false, span: primary.span }, captures: true };
      }
      case "group": {
        if (seen.has(primary)) return { expr: { t: "cut", first: EMPTY_BITS, nullable: true, span: primary.span }, captures: false };
        seen.add(primary);
        const alts = lowerAlternatives(primary.alts, seen);
        return { expr: alts, captures: capturesOf(alts) };
      }
      case "sep":
      case "sep1":
      case "sepEnd":
      case "sepEnd1": {
        const item = lowerUnary(primary.item, seen);
        const separator = lowerUnary(primary.separator, seen);
        return {
          expr: {
            t: "sep",
            item: item.expr,
            separator: separator.expr,
            min: primary.kind === "sep" || primary.kind === "sepEnd" ? 0 : 1,
            trailing: primary.kind === "sepEnd" || primary.kind === "sepEnd1",
            first: EMPTY_BITS,
            nullable: primary.kind === "sep" || primary.kind === "sepEnd",
            span: primary.span,
          },
          captures: item.captures,
        };
      }
    }
  };

  const capturesOf = (expr: PExpr): boolean => {
    switch (expr.t) {
      case "lit":
      case "word":
      case "token":
      case "re":
      case "ref":
        return true;
      case "seq":
        return expr.items.some((item) => item.capture);
      case "alt":
        return expr.alts.some(capturesOf);
      case "star":
      case "plus":
      case "opt":
        return capturesOf(expr.e);
      case "sep":
        return capturesOf(expr.item);
      case "precedence":
        return true;
      case "and":
      case "not":
      case "cut":
        return false;
    }
  };

  const lowerUnary = (unary: Unary, seen: Set<Primary>): { expr: PExpr; captures: boolean } => {
    switch (unary.kind) {
      case "and": {
        const inner = lowerUnary(unary.expr, seen);
        return { expr: { t: "and", e: inner.expr, first: EMPTY_BITS, nullable: true, span: unary.span }, captures: false };
      }
      case "not": {
        const inner = lowerUnary(unary.expr, seen);
        return { expr: { t: "not", e: inner.expr, first: EMPTY_BITS, nullable: true, span: unary.span }, captures: false };
      }
      case "star":
      case "plus":
      case "opt": {
        const inner = lowerUnary(unary.expr, seen);
        if (unary.kind === "opt") {
          return {
            expr: { t: "opt", e: inner.expr, first: EMPTY_BITS, nullable: true, span: unary.span },
            captures: inner.captures,
          };
        }
        return {
          expr: {
            t: unary.kind,
            e: inner.expr,
            first: EMPTY_BITS,
            nullable: unary.kind === "star",
            recover: false,
            sync: EMPTY_BITS,
            span: unary.span,
          },
          captures: inner.captures,
        };
      }
      case "error":
        return { expr: { t: "cut", first: EMPTY_BITS, nullable: true, span: unary.span }, captures: false };
      default:
        return internals(unary, seen);
    }
  };

  const lowerAlternative = (alternative: Alternative, seen: Set<Primary>): PExpr => {
    const items: SeqItem[] = alternative.items.map((item: Item) => {
      const lowered = lowerUnary(item.expr, seen);
      const label = item.label === null ? null : text(item.label);
      const capture = label === null ? lowered.captures : label !== "_";
      return { label, expr: lowered.expr, capture };
    });
    const tag = alternative.tag === null ? null : text(alternative.tag);
    const capturesCount = items.reduce((count, item) => count + (item.capture ? 1 : 0), 0);
    return { t: "seq", tag, items, captures: capturesCount, first: EMPTY_BITS, nullable: false, span: alternative.span };
  };

  const lowerAlternatives = (alternatives: readonly Alternative[], seen: Set<Primary>): PExpr => {
    const alts = alternatives.map((alternative) => lowerAlternative(alternative, seen));
    return {
      t: "alt",
      alts,
      first: EMPTY_BITS,
      nullable: false,
      span: alts.length ? { start: alts[0]!.span.start, end: alts[alts.length - 1]!.span.end } : { start: 0, end: 0 },
    };
  };

  const lowerBody = (body: Body, seen: Set<Primary>): PExpr => {
    if (body.kind === "alternatives") return lowerAlternatives(body.alts, seen);
    if (body.kind === "error") return lowerAlternatives([], seen);
    const levels: PrecLevel[] = body.levels.map((level, index) => {
      const assoc = text(level.assoc);
      if (!["left", "right", "none", "prefix", "postfix"].includes(assoc)) {
        diagnostics.push(error(`Unknown associativity ${assoc}`, level.assoc.span, { code: "grammar/assoc" }));
      }
      const operators = level.operators.map((operator) => lowerUnary(operator, seen).expr);
      return {
        assoc: assoc as PrecLevel["assoc"],
        bp: (index + 1) * 2,
        operators,
        first: EMPTY_BITS,
        span: level.span,
      };
    });
    const atom = lowerAlternatives(body.atom, seen);
    return {
      t: "precedence",
      levels,
      atom,
      first: EMPTY_BITS,
      nullable: false,
      span: body.span,
    };
  };

  const lowered: PExpr[] = [];
  for (const rule of file.rules) {
    const index = context.rules.get(text(rule.name));
    if (index === undefined) continue;
    const expr = lowerBody(rule.body, new Set());
    lowered[index] = expr;
  }

  let rootIndex = 0;
  if (file.root) {
    const found = context.rules.get(text(file.root.rule));
    if (found === undefined) {
      diagnostics.push(error(`Unknown root rule ${text(file.root.rule)}`, file.root.rule.span, {
        code: "grammar/unknown-root",
      }));
    } else rootIndex = found;
  } else if (file.rules.length > 0) {
    rootIndex = 0;
  } else {
    diagnostics.push(error("A grammar needs at least one rule", file.span, { code: "grammar/empty" }));
  }

  const rulesByName = new Map([...context.rules].map(([name, index]) => [index, name]));
  const nullableRule = lowered.map(() => false);
  const firstRule: Set<KeyId>[] = lowered.map(() => new Set<KeyId>());
  const nullableOf = (expr: PExpr): boolean => {
    switch (expr.t) {
      case "lit":
      case "word":
      case "token":
      case "re":
        return false;
      case "ref":
        return nullableRule[expr.rule] ?? false;
      case "seq":
        return expr.items.every((item) => nullableOf(item.expr));
      case "alt":
        return expr.alts.some(nullableOf);
      case "star":
      case "opt":
      case "and":
      case "not":
      case "cut":
        return true;
      case "plus":
        return nullableOf(expr.e);
      case "sep":
        return expr.min === 0 || nullableOf(expr.item);
      case "precedence":
        return nullableOf(expr.atom);
    }
  };
  const firstOf = (expr: PExpr): Set<KeyId> => {
    switch (expr.t) {
      case "lit":
        return new Set([expr.keyId]);
      case "word":
        return new Set<KeyId>([intern("word")]);
      case "token":
        return new Set<KeyId>([expr.keyId]);
      case "re":
        return new Set<KeyId>([expr.keyId]);
      case "ref":
        return firstRule[expr.rule] ?? new Set<KeyId>();
      case "seq": {
        const keys = new Set<KeyId>();
        for (const item of expr.items) {
          for (const key of firstOf(item.expr)) keys.add(key);
          if (!nullableOf(item.expr)) break;
        }
        return keys;
      }
      case "alt":
        return union(expr.alts.map(firstOf));
      case "star":
      case "plus":
      case "opt":
        return firstOf(expr.e);
      case "sep":
        return firstOf(expr.item);
      case "and":
      case "not":
      case "cut":
        return new Set<KeyId>();
      case "precedence": {
        const sets = [firstOf(expr.atom)];
        for (const level of expr.levels) {
          if (level.assoc === "prefix") sets.push(...level.operators.map(firstOf));
        }
        return union(sets);
      }
    }
  };

  let changed = true;
  while (changed) {
    changed = false;
    lowered.forEach((expr, index) => {
      const next = nullableOf(expr);
      if (next !== nullableRule[index]) {
        nullableRule[index] = next;
        changed = true;
      }
    });
  }
  changed = true;
  while (changed) {
    changed = false;
    lowered.forEach((expr, index) => {
      const keys = firstOf(expr);
      for (const key of keys) {
        if (firstRule[index]!.has(key)) continue;
        firstRule[index]!.add(key);
        changed = true;
      }
    });
  }

  const toBits = (keys: Iterable<KeyId>): Uint8Array => {
    const bits = new Uint8Array(keyText.length);
    for (const key of keys) bits[key] = 1;
    return bits;
  };

  const syncOf = (expr: PExpr, seen: Set<number>): Set<KeyId> => {
    switch (expr.t) {
      case "lit":
        return new Set([expr.keyId]);
      case "word":
        return new Set<KeyId>([intern("word")]);
      case "token":
        return new Set<KeyId>([expr.keyId]);
      case "re":
        return new Set<KeyId>([expr.keyId]);
      case "ref": {
        if (seen.has(expr.rule)) return new Set<KeyId>();
        seen.add(expr.rule);
        const value = firstRule[expr.rule] ?? new Set<KeyId>();
        seen.delete(expr.rule);
        return new Set(value);
      }
      case "seq": {
        const keys = new Set<KeyId>();
        for (const item of expr.items) {
          for (const key of syncOf(item.expr, seen)) keys.add(key);
          if (!nullableOf(item.expr)) break;
        }
        return keys;
      }
      case "alt":
        return new Set(union(expr.alts.map((alt) => syncOf(alt, seen))));
      case "star":
      case "plus":
      case "opt":
        return syncOf(expr.e, seen);
      case "sep":
        return syncOf(expr.item, seen);
      case "and":
      case "not":
      case "cut":
        return new Set<KeyId>();
      case "precedence": {
        const keys = syncOf(expr.atom, seen);
        for (const level of expr.levels) for (const operator of level.operators) {
          for (const key of syncOf(operator, seen)) keys.add(key);
        }
        return keys;
      }
    }
  };

  const hasPredicate = (expr: PExpr, seen: Set<number>): boolean => {
    switch (expr.t) {
      case "and":
      case "not":
        return true;
      case "ref": {
        if (seen.has(expr.rule)) return false;
        seen.add(expr.rule);
        const target = lowered[expr.rule];
        return target ? hasPredicate(target, seen) : false;
      }
      case "seq":
        return expr.items.some((item) => hasPredicate(item.expr, seen));
      case "alt":
        return expr.alts.some((alt) => hasPredicate(alt, seen));
      case "star":
      case "plus":
      case "opt":
        return hasPredicate(expr.e, seen);
      case "sep":
        return hasPredicate(expr.item, seen) || hasPredicate(expr.separator, seen);
      case "precedence":
        return hasPredicate(expr.atom, seen)
          || expr.levels.some((level) => level.operators.some((operator) => hasPredicate(operator, seen)));
      case "lit":
      case "word":
      case "token":
      case "re":
      case "cut":
        return false;
    }
  };

  let recoverTarget: PExpr | null = null;
  let incremental: GrammarSpec["incremental"] = null;
  if (lowered[rootIndex]) {
    const root = lowered[rootIndex]!;
    const sequence = root.t === "alt" && root.alts.length === 1 && root.alts[0]!.t === "seq" ? root.alts[0]! : null;
    if (sequence) {
      const repetitions = sequence.items
        .map((item) => item.expr)
        .filter((expr): expr is Extract<PExpr, { readonly t: "star" | "plus"; }> => expr.t === "star" || expr.t === "plus");
      const last = repetitions[repetitions.length - 1] ?? null;
      if (last) {
        recoverTarget = last;
        const label = sequence.items.find((item) => item.expr === last)?.label ?? null;
        const shape = sequence.tag !== null ? (label ? "field" as const : null) : sequence.captures === 1 ? "array" as const : null;
        // A predicate inside an item can read tokens beyond that item. Reuse
        // cannot track what it observed, so such grammars stay full-parse.
        // Predicates in root syntax outside the repetition are also unsafe to
        // reuse without reparsing the root.
        const predicates = hasPredicate(last.e, new Set())
          || sequence.items.some((item) => item.expr !== last && hasPredicate(item.expr, new Set()));
        if (shape !== null && !predicates) {
          incremental = {
            item: last.e,
            shape,
            field: shape === "field" ? label : null,
            sync: toBits(syncOf(last.e, new Set())),
            min: last.t === "plus" ? 1 : 0,
            guarded: sequence.items.some((item) => {
              if (item.expr === last) return false;
              return item.label === null || item.label === "_";
            }),
          };
        }
      }
    }
  }

  const annotate = (expr: PExpr): PExpr => {
    switch (expr.t) {
      case "lit":
      case "word":
      case "token":
      case "re":
      case "cut":
        return expr;
      case "ref":
        return { ...expr, first: toBits(firstRule[expr.rule] ?? []), nullable: nullableRule[expr.rule] ?? false };
      case "seq":
        return {
          ...expr,
          items: expr.items.map((item) => ({ ...item, expr: annotate(item.expr) })),
          first: toBits(firstOf(expr)),
          nullable: nullableOf(expr),
        };
      case "alt":
        return {
          ...expr,
          alts: expr.alts.map(annotate),
          first: toBits(firstOf(expr)),
          nullable: nullableOf(expr),
        };
      case "star":
      case "plus":
        return {
          ...expr,
          e: annotate(expr.e),
          first: toBits(firstOf(expr)),
          nullable: expr.t === "star" || nullableOf(expr.e),
          recover: recoverTarget === expr,
          sync: recoverTarget === expr ? toBits(syncOf(expr.e, new Set())) : EMPTY_BITS,
        };
      case "opt":
        return { ...expr, e: annotate(expr.e), first: toBits(firstOf(expr.e)), nullable: true };
      case "and":
      case "not":
        return { ...expr, e: annotate(expr.e), first: EMPTY_BITS, nullable: true };
      case "sep":
        return {
          ...expr,
          item: annotate(expr.item),
          separator: annotate(expr.separator),
          first: toBits(firstOf(expr.item)),
          nullable: expr.min === 0 || nullableOf(expr.item),
        };
      case "precedence":
        return {
          ...expr,
          levels: expr.levels.map((level) => ({
            ...level,
            operators: level.operators.map(annotate),
            first: toBits(union(level.operators.map(firstOf))),
          })),
          atom: annotate(expr.atom),
          first: toBits(firstOf(expr)),
          nullable: nullableOf(expr),
        };
    }
  };

  const annotated = lowered.map((expr) => annotate(expr));

  const declarators = new Set<string>();
  const usedRules = new Set<number>();
  const usedTokens = new Set<string>();
  const visit = (expr: PExpr, rulesSeen: Set<number>): void => {
    switch (expr.t) {
      case "ref":
        usedRules.add(expr.rule);
        if (!rulesSeen.has(expr.rule)) {
          rulesSeen.add(expr.rule);
          const target = annotated[expr.rule];
          if (target) visit(target, rulesSeen);
        }
        return;
      case "token":
        usedTokens.add(expr.name);
        return;
      case "lit":
      case "word":
      case "re":
      case "cut":
        return;
      case "seq":
        for (const item of expr.items) visit(item.expr, rulesSeen);
        return;
      case "alt":
        for (const alt of expr.alts) visit(alt, rulesSeen);
        return;
      case "star":
      case "plus":
      case "opt":
      case "and":
      case "not":
        visit(expr.e, rulesSeen);
        return;
      case "sep":
        visit(expr.item, rulesSeen);
        visit(expr.separator, rulesSeen);
        return;
      case "precedence":
        visit(expr.atom, rulesSeen);
        for (const level of expr.levels) for (const operator of level.operators) visit(operator, rulesSeen);
        return;
    }
  };
  annotated.forEach((expr) => visit(expr, new Set()));

  const nullableLoop = (expr: PExpr): void => {
    switch (expr.t) {
      case "star":
      case "plus":
        if (nullableOf(expr.e)) {
          diagnostics.push(error("This repetition can match nothing, so it would never advance", expr.span, {
            code: "grammar/nullable-loop",
          }));
        }
        nullableLoop(expr.e);
        return;
      case "sep":
        if (nullableOf(expr.item) || nullableOf(expr.separator)) {
          diagnostics.push(error("A separated list cannot have a nullable item or separator", expr.span, {
            code: "grammar/nullable-loop",
          }));
        }
        nullableLoop(expr.item);
        nullableLoop(expr.separator);
        return;
      case "seq":
        for (const item of expr.items) nullableLoop(item.expr);
        return;
      case "alt":
        for (const alt of expr.alts) nullableLoop(alt);
        return;
      case "opt":
      case "and":
      case "not":
        nullableLoop(expr.e);
        return;
      case "precedence":
        nullableLoop(expr.atom);
        for (const level of expr.levels) for (const operator of level.operators) nullableLoop(operator);
        return;
      case "lit":
      case "word":
      case "token":
      case "re":
      case "ref":
      case "cut":
        return;
    }
  };
  annotated.forEach(nullableLoop);

  // Ordered choice picks the first alternative that succeeds. If one before the
  // last can match nothing, every later alternative is unreachable.
  const unreachableChoice = (expr: PExpr): void => {
    switch (expr.t) {
      case "alt": {
        const index = expr.alts.findIndex((alternative, at) => at < expr.alts.length - 1 && nullableOf(alternative));
        if (index >= 0) {
          diagnostics.push(warning(
            `Alternative ${index + 1} can match nothing, so later alternatives are unreachable`,
            expr.alts[index]!.span,
            { code: "grammar/unreachable-alternative" },
          ));
        }
        for (const alternative of expr.alts) unreachableChoice(alternative);
        return;
      }
      case "seq":
        for (const item of expr.items) unreachableChoice(item.expr);
        return;
      case "star":
      case "plus":
      case "opt":
      case "and":
      case "not":
        unreachableChoice(expr.e);
        return;
      case "sep":
        unreachableChoice(expr.item);
        unreachableChoice(expr.separator);
        return;
      case "precedence":
        unreachableChoice(expr.atom);
        for (const level of expr.levels) for (const operator of level.operators) unreachableChoice(operator);
        return;
      case "lit":
      case "word":
      case "token":
      case "re":
      case "ref":
      case "cut":
        return;
    }
  };
  annotated.forEach(unreachableChoice);

  const leading = annotated.map(() => new Set<number>());
  const leadingOf = (expr: PExpr): Set<number> => {
    switch (expr.t) {
      case "lit":
      case "word":
      case "token":
      case "re":
      case "cut":
        return new Set();
      case "ref":
        return new Set([expr.rule]);
      case "seq": {
        const result = new Set<number>();
        for (const item of expr.items) {
          for (const rule of leadingOf(item.expr)) result.add(rule);
          if (!nullableOf(item.expr)) break;
        }
        return result;
      }
      case "alt":
        return unionRules(expr.alts.map(leadingOf));
      case "star":
      case "plus":
      case "opt":
      case "and":
      case "not":
        return leadingOf(expr.e);
      case "sep":
        return leadingOf(expr.item);
      case "precedence": {
        const result = leadingOf(expr.atom);
        for (const level of expr.levels) {
          if (level.assoc !== "prefix") continue;
          for (const operator of level.operators) {
            for (const rule of leadingOf(operator)) result.add(rule);
          }
        }
        return result;
      }
    }
  };
  changed = true;
  while (changed) {
    changed = false;
    annotated.forEach((expr, index) => {
      for (const rule of leadingOf(expr)) {
        if (leading[index]!.has(rule)) continue;
        leading[index]!.add(rule);
        changed = true;
      }
    });
  }
  const reported = new Set<string>();
  annotated.forEach((_, start) => {
    if (!leading[start]!.has(start)) return;
    const queue: number[][] = [[start]];
    const seen = new Set<number>();
    let cycle: number[] | undefined;
    while (queue.length && !cycle) {
      const path = queue.shift()!;
      const at = path[path.length - 1]!;
      if (seen.has(at)) continue;
      seen.add(at);
      for (const next of leading[at]!) {
        if (next === start) {
          cycle = [...path, start];
          break;
        }
        if (!seen.has(next)) queue.push([...path, next]);
      }
    }
    if (!cycle) return;
    const key = cycle.join(">");
    if (reported.has(key)) return;
    reported.add(key);
    const names = cycle.map((rule) => rulesByName.get(rule) ?? `#${rule}`).join(" -> ");
    const span = file.rules[start]?.name.span ?? file.span;
    diagnostics.push(error(`Left recursion: ${names}. Consume a token first, or use a repetition or a precedence block`, span, {
      code: "grammar/left-recursion",
    }));
  });

  annotated.forEach((expr, index) => {
    if (!usedRules.has(index) && index !== rootIndex) {
      const rule = file.rules[index];
      if (rule) {
        diagnostics.push(error(`Unused rule: ${text(rule.name)} is not reachable from the root`, rule.name.span, {
          code: "grammar/unused-rule",
        }));
      }
    }
  });
  for (const [name, token] of context.tokens) {
    if (!usedTokens.has(name)) {
      diagnostics.push(error(`Unused token: ${name}`, token.span, { code: "grammar/unused-token" }));
    }
  }

  const inspectTags = (alternatives: readonly Alternative[]): void => {
    for (const alternative of alternatives) {
      if (alternative.tag !== null) {
        const tag = text(alternative.tag);
        const labels = alternative.items
          .map((item) => item.label === null ? null : text(item.label))
          .filter((label): label is string => label !== null && label !== "_");
        if (new Set(labels).size !== labels.length) {
          diagnostics.push(error(`Duplicate field label in @${tag}`, alternative.span, { code: "grammar/duplicate-field" }));
        }
      }
      for (const item of alternative.items) inspectUnaryTags(item.expr, inspectTags);
    }
  };
  const inspectBody = (body: Body): void => {
    if (body.kind === "alternatives") inspectTags(body.alts);
    else if (body.kind === "precedence") {
      for (const level of body.levels) for (const operator of level.operators) inspectUnaryTags(operator, inspectTags);
      inspectTags(body.atom);
    }
  };
  for (const rule of file.rules) inspectBody(rule.body);

  const ruleSpecs = file.rules.flatMap((rule, index) => {
    const expr = annotated[context.rules.get(text(rule.name)) ?? index];
    return expr ? [{ name: text(rule.name), expr, span: rule.span }] : [];
  });

  const symbols = [...context.symbols].sort((a, b) => b.length - a.length);
  const singleSymbols: (SymbolSpec | undefined)[] = new Array(128);
  const multiSymbolsByFirst = new Map<number, SymbolSpec[]>();
  for (const symbol of symbols) {
    const entry = { text: symbol, keyId: intern(`symbol:${symbol}`) };
    if (symbol.length === 1 && symbol.charCodeAt(0) < 128) {
      singleSymbols[symbol.charCodeAt(0)] = entry;
      continue;
    }
    const first = symbol.charCodeAt(0);
    const list = multiSymbolsByFirst.get(first);
    if (list) list.push(entry);
    else multiSymbolsByFirst.set(first, [entry]);
  }
  const fastWhitespace = skipSources.some(isFastWhitespace);
  const fastLineComment = skipSources.some(isFastLineComment);
  const fastBlockComment = skipSources.some(isFastBlockComment);
  const slowSkips = skips.filter((_, index) => {
    const source = skipSources[index]!;
    return !(isFastWhitespace(source) || isFastLineComment(source) || isFastBlockComment(source));
  });
  const keywordIds = new Map<string, KeyId>();
  let maxKeywordLength = 0;
  for (const keyword of context.keywords) {
    const keyId = intern(`word:${keyword}`);
    keywordIds.set(keyword, keyId);
    if (keyword.length > maxKeywordLength) maxKeywordLength = keyword.length;
  }
  const keywordCandidates: (SymbolSpec[] | undefined)[] = new Array(maxKeywordLength + 1);
  for (const [keyword, keyId] of keywordIds) {
    const list = keywordCandidates[keyword.length] ?? (keywordCandidates[keyword.length] = []);
    list.push({ text: keyword, keyId });
  }
  const wordKeyId = intern("word");
  const eofKeyId = intern("eof");
  const errorKeyId = intern("error");
  const ruleOf = new Int32Array(keyText.length).fill(-1);
  for (let index = 0; index < context.tokens.size; index++) {
    ruleOf[[...context.tokens.values()][index]!.keyId] = index;
  }
  for (let index = 0; index < context.inline.length; index++) {
    ruleOf[context.inline[index]!.keyId] = index;
  }
  const spec: GrammarSpec = {
    name: text(file.name),
    skips,
    slowSkips,
    word: wordRegex,
    wordSource,
    tokens: [...context.tokens.values()],
    inline: context.inline,
    symbols,
    singleSymbols,
    multiSymbolsByFirst,
    keyText,
    ruleOf,
    wordKeyId,
    eofKeyId,
    errorKeyId,
    keywordIds,
    keywordCandidates,
    maxKeywordLength,
    wordHighlight: highlightCode("variable"),
    keywordHighlight: highlightCode("keyword"),
    symbolHighlight: highlightCode("operator"),
    regexHighlight: highlightCode("regexp"),
    fastWhitespace,
    fastLineComment,
    fastBlockComment,
    asciiWord: wordSource === "[A-Za-z_][A-Za-z0-9_]*",
    keywords: context.keywords,
    rules: ruleSpecs,
    root: rootIndex,
    rootFirst: toBits(firstRule[rootIndex] ?? []),
    incremental,
  };

  const sorted = sortDiagnostics(diagnostics);
  const valid = sorted.every((entry) => entry.severity !== "error");

  return {
    name: spec.name,
    uri,
    file,
    spec,
    valid,
    diagnostics: sorted,
    parse: (source: string, options?: ParseOptions) => {
      if (!valid) {
        const list = lexTokens(spec, source);
        return {
          ok: false,
          value: null,
          tokens: list,
          trivia: list.trivia,
          diagnostics: sorted,
        };
      }
      return parseSource<A>(spec, source, options);
    },
    lex: (source: string) => lexTokens(spec, source),
    highlight: (source: string) => highlightOfSource(spec, source),
    highlightTokens: (tokens: TokenList) => highlightOfTokens(spec, tokens),
  };
};

const inspectUnaryTags = (unary: Unary, visit: (alts: readonly Alternative[]) => void): void => {
  switch (unary.kind) {
    case "group":
      visit(unary.alts);
      return;
    case "star":
    case "plus":
    case "opt":
    case "and":
    case "not":
      inspectUnaryTags(unary.expr, visit);
      return;
    case "sep":
    case "sep1":
    case "sepEnd":
    case "sepEnd1":
      inspectUnaryTags(unary.item, visit);
      inspectUnaryTags(unary.separator, visit);
      return;
    default:
      if (unary.kind === "word") return;
      if (unary.kind === "lit" || unary.kind === "re" || unary.kind === "token" || unary.kind === "cut" || unary.kind === "ref") {
        return;
      }
  }
};

const highlightOfSource = (spec: GrammarSpec, source: string): Token[] =>
  highlightOfTokens(spec, lexTokens(spec, source));

const highlightOfTokens = (spec: GrammarSpec, list: TokenList): Token[] => {
  void spec;
  const tokens: Token[] = [];
  const trivia = list.trivia;
  for (let index = 0; index < trivia.length; index++) {
    if (trivia.kind[index] !== 1) continue;
    tokens.push({ span: { start: trivia.start[index]!, end: trivia.end[index]! }, kind: "comment" });
  }
  for (let index = 0; index < list.length; index++) {
    const kind = list.kindAt(index);
    const highlight = list.highlightAt(index);
    if (kind === EOF || kind === ERROR || highlight === 0) continue;
    tokens.push({ span: { start: list.start[index]!, end: list.end[index]! }, kind: tokenKinds[highlight - 1]! });
  }
  return tokens.sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);
};

export const compileSource = <A = unknown>(source: string, uri = "grammar.parl"): CompiledGrammar<A> | {
  readonly error: Diagnostic;
} => {
  const parsed = parseGrammarSource(source, uri);
  if (!parsed.ok) return { error: parsed.diagnostics[0]! };
  return compileGrammar<A>(parsed.file, uri);
};

