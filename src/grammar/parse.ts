import { error, type Diagnostic } from "../diagnostic.ts";
import { type Span, type Text } from "../source.ts";
import {
  type Alternative,
  type Alternatives,
  assoc,
  type Bind,
  type BindEntry,
  type BindPath,
  type BindVisibility,
  type Body,
  builtins,
  type GrammarFile,
  type Highlight,
  type Item,
  type Level,
  type Precedence,
  type Primary,
  type Rule,
  type Skip,
  type TokenDecl,
  type Unary,
  type Word,
  type Root,
} from "./ast.ts";

type Lexeme = {
  readonly kind: "word" | "string" | "regex" | "symbol" | "eof";
  readonly text: string;
  readonly span: Span;
};

type Result =
  | { readonly ok: true; readonly file: GrammarFile }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

class Failure extends Error {
  readonly span: Span;

  constructor(message: string, span: Span) {
    super(message);
    this.name = "GrammarFailure";
    this.span = span;
  }
}

const isWordStart = (code: number): boolean =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;

const isWordPart = (code: number): boolean => isWordStart(code) || (code >= 48 && code <= 57);

const lex = (source: string): readonly Lexeme[] => {
  const tokens: Lexeme[] = [];
  let offset = 0;
  const push = (kind: Lexeme["kind"], start: number, text: string) => {
    tokens.push({ kind, text, span: { start, end: start + text.length } });
  };
  while (offset < source.length) {
    const code = source.charCodeAt(offset);
    if (code === 32 || code === 9 || code === 10 || code === 13 || code === 0xfeff) {
      offset++;
      continue;
    }
    if (code === 47 && source.charCodeAt(offset + 1) === 47) {
      while (offset < source.length && source[offset] !== "\n") offset++;
      continue;
    }
    if (code === 47 && source.charCodeAt(offset + 1) === 42) {
      const close = source.indexOf("*/", offset + 2);
      offset = close < 0 ? source.length : close + 2;
      continue;
    }
    if (code === 34) {
      const start = offset++;
      let closed = false;
      while (offset < source.length) {
        const current = source.charCodeAt(offset);
        if (current === 92) {
          offset += 2;
          continue;
        }
        offset++;
        if (current === 34) {
          closed = true;
          break;
        }
      }
      if (!closed) throw new Failure("Unterminated string", { start, end: source.length });
      push("string", start, source.slice(start, offset));
      continue;
    }
    if (code === 47) {
      const start = offset++;
      let inClass = false;
      let closed = false;
      while (offset < source.length) {
        const current = source.charCodeAt(offset);
        if (current === 92) {
          offset += 2;
          continue;
        }
        if (current === 91) inClass = true;
        else if (current === 93) inClass = false;
        else if (current === 47 && !inClass) {
          offset++;
          closed = true;
          break;
        } else if (current === 10 || current === 13) {
          break;
        }
        offset++;
      }
      if (!closed) throw new Failure("Unterminated regular expression", { start, end: offset });
      push("regex", start, source.slice(start, offset));
      continue;
    }
    if (isWordStart(code)) {
      const start = offset++;
      while (offset < source.length && isWordPart(source.charCodeAt(offset))) offset++;
      push("word", start, source.slice(start, offset));
      continue;
    }
    if ("@$~&!|*+?:(){}[],=;.".includes(source[offset]!)) {
      push("symbol", offset, source[offset]!);
      offset++;
      continue;
    }
    throw new Failure(`Unexpected character ${JSON.stringify(source[offset])}`, {
      start: offset,
      end: offset + 1,
    });
  }
  tokens.push({ kind: "eof", text: "", span: { start: source.length, end: source.length } });
  return tokens;
};

class Bootstrap {
  readonly #tokens: readonly Lexeme[];
  #position = 0;

  constructor(tokens: readonly Lexeme[]) {
    this.#tokens = tokens;
  }

  get current(): Lexeme {
    return this.#tokens[this.#position]!;
  }

  get next(): Lexeme {
    return this.#tokens[this.#position + 1] ?? this.#tokens[this.#tokens.length - 1]!;
  }

  advance(): Lexeme {
    return this.#tokens[this.#position++]!;
  }

  atWord(text: string): boolean {
    return this.current.kind === "word" && this.current.text === text;
  }

  atSymbol(text: string): boolean {
    return this.current.kind === "symbol" && this.current.text === text;
  }

  takeWord(text: string): void {
    if (!this.atWord(text)) this.fail(`Expected ${JSON.stringify(text)}`);
    this.advance();
  }

  takeSymbol(text: string): void {
    if (!this.atSymbol(text)) this.fail(`Expected ${JSON.stringify(text)}`);
    this.advance();
  }

  fail(message: string, at: Span = this.current.span): never {
    throw new Failure(message, at);
  }

  /** A name is a word at this position; keyword collision is a compile-time check. */
  text(): Text {
    if (this.current.kind !== "word") this.fail("Expected a name");
    const token = this.advance();
    return { text: token.text, span: token.span };
  }

  pattern(): Text {
    if (this.current.kind !== "regex") this.fail("Expected a /pattern/");
    const token = this.advance();
    return { text: token.text, span: token.span };
  }

  parse(): GrammarFile {
    const start = this.current.span.start;
    this.takeWord("grammar");
    const name = this.text();
    const skips: Skip[] = [];
    const tokens: TokenDecl[] = [];
    let word: Word | null = null;
    let root: Root | null = null;
    const rules: Rule[] = [];
    let bind: Bind | null = null;
    while (this.current.kind !== "eof") {
      if (this.atWord("skip")) {
        const begin = this.advance().span.start;
        const pattern = this.pattern();
        skips.push({ kind: "skip", pattern, span: { start: begin, end: pattern.span.end } });
      } else if (this.atWord("word")) {
        const begin = this.advance().span.start;
        if (word) this.fail("`word` is declared more than once", this.current.span);
        const pattern = this.pattern();
        word = { kind: "word", pattern, span: { start: begin, end: pattern.span.end } };
      } else if (this.atWord("token")) {
        const begin = this.advance().span.start;
        const tokenName = this.text();
        const pattern = this.pattern();
        let highlight: Highlight | null = null;
        if (this.atSymbol("@")) {
          const mark = this.advance().span.start;
          const kind = this.text();
          highlight = { kind: "highlight", name: kind, span: { start: mark, end: kind.span.end } };
        }
        tokens.push({
          kind: "token",
          name: tokenName,
          pattern,
          highlight,
          span: { start: begin, end: (highlight?.span ?? pattern.span).end },
        });
      } else if (this.atWord("root")) {
        const begin = this.advance().span.start;
        if (root) this.fail("`root` is declared more than once", this.current.span);
        const ruleName = this.text();
        root = { kind: "root", rule: ruleName, span: { start: begin, end: ruleName.span.end } };
      } else if (this.atWord("rule")) {
        const begin = this.advance().span.start;
        const ruleName = this.text();
        this.takeSymbol("=");
        let body: Body;
        if (this.atWord("precedence") && this.next.kind === "symbol" && this.next.text === "{") {
          body = this.precedence();
        } else {
          this.takeSymbol("{");
          body = this.body();
          this.takeSymbol("}");
        }
        this.takeSymbol(";");
        rules.push({
          kind: "rule",
          name: ruleName,
          body,
          span: { start: begin, end: this.#tokens[this.#position - 1]!.span.end },
        });
      } else if (this.atWord("bind")) {
        if (bind) this.fail("`bind` is declared more than once", this.current.span);
        bind = this.bind();
      } else {
        this.fail(`Expected a declaration, found ${JSON.stringify(this.current.text)}`);
      }
    }
    const end = this.current.span.end;
    return {
      kind: "grammar",
      name,
      skips,
      word,
      tokens,
      root,
      rules,
      bind,
      span: { start, end },
    };
  }

  bind(): Bind {
    const start = this.advance().span.start;
    this.takeSymbol("{");
    const entries: BindEntry[] = [];
    while (!this.atSymbol("}")) entries.push(this.bindEntry());
    this.advance();
    return { kind: "bind", entries, span: { start, end: this.#tokens[this.#position - 1]!.span.end } };
  }

  bindEntry(): BindEntry {
    const start = this.current.span.start;
    const end = (): Span => ({ start, end: this.#tokens[this.#position - 1]!.span.end });
    const string = (): Text | null => {
      if (this.current.kind !== "string") return null;
      const token = this.advance();
      return { text: token.text, span: token.span };
    };
    if (this.atWord("import") || this.atWord("scope")) {
      const kind = this.advance().text as "import" | "scope";
      const paths = this.bindPaths();
      return { kind, paths, span: end() };
    }
    if (this.atWord("builtin")) {
      this.advance();
      const names = [this.text()];
      while (this.atSymbol(",")) {
        this.advance();
        names.push(this.text());
      }
      this.takeSymbol(":");
      const type = this.text();
      const label = string();
      return { kind: "builtin", names, type, label, span: end() };
    }
    if (this.atWord("export") || this.atWord("def")) {
      let exported: Text | null = null;
      if (this.atWord("export")) exported = this.text();
      this.takeWord("def");
      const paths = this.bindPaths();
      this.takeSymbol(":");
      const type = this.text();
      const label = string();
      let visibility: BindVisibility | null = null;
      if (this.atWord("after")) {
        visibility = { kind: "after", span: this.advance().span };
      } else if (this.atWord("in")) {
        const begin = this.advance().span.start;
        const target = this.bindPath();
        visibility = { kind: "in", target, span: { start: begin, end: target.span.end } };
      }
      return { kind: "def", exported, paths, type, label, visibility, span: end() };
    }
    if (this.atWord("ref")) {
      this.advance();
      const paths = this.bindPaths();
      this.takeSymbol(":");
      const label = this.text();
      const noun = string();
      return { kind: "ref", paths, label, noun, span: end() };
    }
    if (this.atWord("unique")) {
      this.advance();
      const paths = this.bindPaths();
      this.takeWord("in");
      const owners = [this.text()];
      while (this.atSymbol(",")) {
        this.advance();
        owners.push(this.text());
      }
      const message = string();
      return { kind: "unique", paths, owners, message, span: end() };
    }
    return this.fail(`Expected a bind entry, found ${JSON.stringify(this.current.text)}`);
  }

  bindPaths(): BindPath[] {
    const paths = [this.bindPath()];
    while (this.atSymbol(",")) {
      this.advance();
      paths.push(this.bindPath());
    }
    return paths;
  }

  bindPath(): BindPath {
    const node = this.text();
    let field: Text | null = null;
    if (this.atSymbol(".")) {
      this.advance();
      field = this.text();
    }
    return { kind: "path", node, field, span: { start: node.span.start, end: (field ?? node).span.end } };
  }

  body(): Body {
    if (this.atWord("precedence") && this.next.kind === "symbol" && this.next.text === "{") {
      return this.precedence();
    }
    const alternatives = this.alternatives(new Set(["}"]));
    return { kind: "alternatives", alts: alternatives.alts, span: alternatives.span };
  }

  precedence(): Precedence {
    const start = this.advance().span.start;
    this.takeSymbol("{");
    const levels: Level[] = [];
    while (this.current.kind === "word" && assoc.has(this.current.text)) levels.push(this.level());
    this.takeWord("atom");
    const atom = this.alternatives(new Set(["}"])).alts;
    this.takeSymbol("}");
    return { kind: "precedence", levels, atom, span: { start, end: this.#tokens[this.#position - 1]!.span.end } };
  }

  level(): Level {
    const start = this.current.span.start;
    const assocText = this.text();
    const operators: Unary[] = [];
    operators.push(this.unary());
    while (this.atSymbol("|")) {
      const mark = this.#position;
      this.advance();
      if (this.current.kind === "word" && (assoc.has(this.current.text) || this.current.text === "atom")) {
        this.#position = mark;
        break;
      }
      operators.push(this.unary());
    }
    const end = operators[operators.length - 1]!.span.end;
    return { kind: "level", assoc: assocText, operators, span: { start, end } };
  }

  alternatives(closing: ReadonlySet<string>): Alternatives {
    const start = this.current.span.start;
    if (this.atSymbol("|")) this.advance();
    const alts: Alternative[] = [];
    const first = this.alternative(closing);
    alts.push(first);
    while (this.atSymbol("|")) {
      this.advance();
      alts.push(this.alternative(closing));
    }
    return { kind: "alternatives", alts, span: { start, end: alts[alts.length - 1]!.span.end } };
  }

  startsItem(closing: ReadonlySet<string>): boolean {
    if (this.current.kind === "eof") return false;
    if (this.current.kind === "symbol") {
      return !["|", ")", "}", "]", ",", "=", ";"].includes(this.current.text) && !closing.has(this.current.text);
    }
    if (closing.has(this.current.text)) return false;
    return true;
  }

  alternative(closing: ReadonlySet<string>): Alternative {
    const start = this.current.span.start;
    let tag: Text | null = null;
    if (this.atSymbol("@")) {
      this.advance();
      tag = this.text();
    }
    const items: Item[] = [];
    while (this.startsItem(closing)) items.push(this.item());
    if (items.length === 0) {
      const near = tag ?? { text: "", span: { start, end: start } };
      this.fail("An alternative needs at least one element", near.span);
    }
    return { kind: "alternative", tag, items, span: { start, end: items[items.length - 1]!.span.end } };
  }

  item(): Item {
    const start = this.current.span.start;
    let label: Text | null = null;
    if (this.current.kind === "word" && this.next.kind === "symbol" && this.next.text === ":") {
      label = this.text();
      this.advance();
    }
    const expr = this.unary();
    return { kind: "item", label, expr, span: { start, end: expr.span.end } };
  }

  unary(): Unary {
    if (this.atSymbol("&") || this.atSymbol("!")) {
      const start = this.advance().span.start;
      const kind = this.#tokens[this.#position - 1]!.text === "&" ? "and" as const : "not" as const;
      const expr = this.unary();
      return { kind, expr, span: { start, end: expr.span.end } };
    }
    return this.postfix();
  }

  postfix(): Unary {
    const primary = this.primary();
    if (!this.atSymbol("*") && !this.atSymbol("+") && !this.atSymbol("?")) return primary;
    const operator = this.advance();
    const kind = operator.text === "*" ? "star" as const : operator.text === "+" ? "plus" as const : "opt" as const;
    return { kind, expr: primary, span: { start: primary.span.start, end: operator.span.end } };
  }

  primary(): Primary {
    const token = this.current;
    if (token.kind === "string") {
      this.advance();
      return { kind: "lit", text: { text: token.text, span: token.span }, span: token.span };
    }
    if (token.kind === "regex") {
      this.advance();
      return { kind: "re", source: { text: token.text, span: token.span }, span: token.span };
    }
    if (this.atSymbol("$")) {
      const start = this.advance().span.start;
      const name = this.text();
      return { kind: "token", name, span: { start, end: name.span.end } };
    }
    if (this.atSymbol("~")) {
      this.advance();
      return { kind: "cut", span: token.span };
    }
    if (this.atSymbol("(")) {
      const start = this.advance().span.start;
      const alts = this.alternatives(new Set([")"]));
      this.takeSymbol(")");
      return { kind: "group", alts: alts.alts, span: { start, end: this.#tokens[this.#position - 1]!.span.end } };
    }
    if (
      token.kind === "word"
      && ["sep", "sep1", "sepEnd", "sepEnd1"].includes(token.text)
      && this.next.kind === "symbol" && this.next.text === "("
    ) {
      const start = this.advance().span.start;
      this.takeSymbol("(");
      const item = this.unary();
      this.takeSymbol(",");
      const separator = this.unary();
      this.takeSymbol(")");
      return {
        kind: token.text as "sep" | "sep1" | "sepEnd" | "sepEnd1",
        item,
        separator,
        span: { start, end: this.#tokens[this.#position - 1]!.span.end },
      };
    }
    if (token.kind === "word") {
      this.advance();
      if (builtins.has(token.text)) {
        return { kind: "word", span: token.span };
      }
      return { kind: "ref", name: { text: token.text, span: token.span }, span: token.span };
    }
    return this.fail(`Expected an expression, found ${JSON.stringify(token.text)}`);
  }
}

export const parseGrammar = (source: string, uri = "grammar.parl"): Result => {
  try {
    const tokens = lex(source);
    const file = new Bootstrap(tokens).parse();
    return { ok: true, file };
  } catch (failure) {
    if (!(failure instanceof Failure)) throw failure;
    return { ok: false, diagnostics: [error(failure.message, failure.span, { code: "grammar/parse" })] };
  }
};

export type { Result as GrammarParseResult };
