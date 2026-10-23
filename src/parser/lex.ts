import type { GrammarSpec, LexToken, TokenList, Trivia } from "./spec.ts";

const anchored = (pattern: RegExp, source: string, offset: number): string | undefined => {
  pattern.lastIndex = offset;
  const match = pattern.exec(source);
  return match && match.index === offset && match[0].length > 0 ? match[0] : undefined;
};

export const lex = (spec: GrammarSpec, source: string): TokenList => {
  const tokens: LexToken[] = [];
  const trivia: Trivia[] = [];
  let offset = 0;
  while (offset < source.length) {
    const triviaStart = offset;
    let skipped = false;
    while (offset < source.length) {
      let matched = false;
      for (const pattern of spec.skips) {
        const text = anchored(pattern, source, offset);
        if (text === undefined) continue;
        offset += text.length;
        matched = true;
        skipped = true;
        break;
      }
      if (!matched) break;
    }
    if (skipped) {
      const span = { start: triviaStart, end: offset };
      const text = source.slice(span.start, span.end);
      trivia.push({ span, kind: text.trimStart().startsWith("//") || text.trimStart().startsWith("/*") ? "comment" : "space" });
      if (offset >= source.length) break;
    }

    let token: LexToken | undefined;
    for (let index = 0; index < spec.tokens.length; index++) {
      const rule = spec.tokens[index]!;
      const text = anchored(rule.regex, source, offset);
      if (text === undefined) continue;
      token = {
        kind: "token",
        text,
        span: { start: offset, end: offset + text.length },
        name: rule.name,
        index,
        highlight: rule.highlight,
      };
      break;
    }
    if (!token) {
      for (let index = 0; index < spec.inline.length; index++) {
        const rule = spec.inline[index]!;
        const text = anchored(rule.regex, source, offset);
        if (text === undefined) continue;
        token = {
          kind: "regex",
          text,
          span: { start: offset, end: offset + text.length },
          index,
          highlight: "regexp",
        };
        break;
      }
    }
    if (!token) {
      const word = anchored(spec.word, source, offset);
      if (word !== undefined) {
        token = {
          kind: "word",
          text: word,
          span: { start: offset, end: offset + word.length },
          highlight: spec.keywords.has(word) ? "keyword" : "variable",
        };
      }
    }
    if (!token) {
      for (const symbol of spec.symbols) {
        if (!source.startsWith(symbol, offset)) continue;
        token = {
          kind: "symbol",
          text: symbol,
          span: { start: offset, end: offset + symbol.length },
          highlight: "operator",
        };
        break;
      }
    }
    if (!token) {
      const code = source.codePointAt(offset)!;
      const text = String.fromCodePoint(code);
      token = {
        kind: "error",
        text,
        span: { start: offset, end: offset + text.length },
        highlight: null,
      };
    }
    tokens.push(token);
    offset = token.span.end;
  }
  tokens.push({ kind: "eof", text: "", span: { start: source.length, end: source.length }, highlight: null });
  return { tokens, trivia };
};
