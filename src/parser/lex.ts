import type { GrammarSpec, Key, LexToken, TokenList, Trivia } from "./spec.ts";

const anchored = (pattern: RegExp, source: string, offset: number): string | undefined => {
  pattern.lastIndex = offset;
  const match = pattern.exec(source);
  return match && match.index === offset && match[0].length > 0 ? match[0] : undefined;
};

const isSpace = (code: number): boolean =>
  code === 32 || code === 9 || code === 10 || code === 13 || code === 11 || code === 12;

const isWordStart = (code: number): boolean =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;

const isWordPart = (code: number): boolean => isWordStart(code) || (code >= 48 && code <= 57);

export const lex = (spec: GrammarSpec, source: string): TokenList => {
  const tokens: LexToken[] = [];
  const trivia: Trivia[] = [];
  const tokenKeys = spec.tokens.map((token) => `token:${token.name}` as Key);
  const regexKeys = spec.inline.map((_, index) => `regex:${index}` as Key);
  const symbolKeys = new Map(spec.symbols.map((symbol) => [symbol, `symbol:${symbol}` as Key]));
  const wordKeys = new Map<string, Key>();
  const wordKey = (word: string): Key => {
    let key = wordKeys.get(word);
    if (key === undefined) {
      key = `word:${word}`;
      wordKeys.set(word, key);
    }
    return key;
  };
  let offset = 0;
  while (offset < source.length) {
    const triviaStart = offset;
    let sawComment = false;
    for (;;) {
      let moved = false;
      if (spec.fastWhitespace) {
        const before = offset;
        while (offset < source.length && isSpace(source.charCodeAt(offset))) offset++;
        moved = offset > before;
      }
      if (
        spec.fastLineComment && source.charCodeAt(offset) === 47 && source.charCodeAt(offset + 1) === 47
      ) {
        offset += 2;
        while (offset < source.length && source.charCodeAt(offset) !== 10 && source.charCodeAt(offset) !== 13) offset++;
        sawComment = true;
        moved = true;
      }
      if (
        spec.fastBlockComment && source.charCodeAt(offset) === 47 && source.charCodeAt(offset + 1) === 42
      ) {
        const close = source.indexOf("*/", offset + 2);
        offset = close < 0 ? source.length : close + 2;
        sawComment = true;
        moved = true;
      }
      for (const pattern of spec.skips) {
        const text = anchored(pattern, source, offset);
        if (text === undefined) continue;
        const trimmed = text.trimStart();
        if (trimmed.startsWith("//") || trimmed.startsWith("/*")) sawComment = true;
        offset += text.length;
        moved = true;
        break;
      }
      if (!moved) break;
    }
    if (offset > triviaStart) {
      trivia.push({ span: { start: triviaStart, end: offset }, kind: sawComment ? "comment" : "space" });
      if (offset >= source.length) break;
    }

    let token: LexToken | undefined;
    const code = source.charCodeAt(offset);
    for (let index = 0; index < spec.tokens.length; index++) {
      const rule = spec.tokens[index]!;
      if (rule.first !== null && (code >= 128 || rule.first[code] === 0)) continue;
      const text = anchored(rule.regex, source, offset);
      if (text === undefined) continue;
      token = {
        kind: "token",
        text,
        span: { start: offset, end: offset + text.length },
        key: tokenKeys[index]!,
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
          key: regexKeys[index]!,
          index,
          highlight: "regexp",
        };
        break;
      }
    }
    if (!token) {
      let word: string | undefined;
      if (spec.asciiWord) {
        if (isWordStart(source.charCodeAt(offset))) {
          const start = offset++;
          while (offset < source.length && isWordPart(source.charCodeAt(offset))) offset++;
          word = source.slice(start, offset);
        }
      } else {
        word = anchored(spec.word, source, offset);
      }
      if (word !== undefined) {
        token = {
          kind: "word",
          text: word,
          span: { start: offset - word.length, end: offset },
          key: wordKey(word),
          highlight: spec.keywords.has(word) ? "keyword" : "variable",
        };
      }
    }
    if (!token) {
      const candidates = spec.symbolsByFirst.get(source[offset]!) ?? [];
      for (const symbol of candidates) {
        if (!source.startsWith(symbol, offset)) continue;
        token = {
          kind: "symbol",
          text: symbol,
          span: { start: offset, end: offset + symbol.length },
          key: symbolKeys.get(symbol)!,
          highlight: "operator",
        };
        break;
      }
    }
    if (!token) {
      const point = source.codePointAt(offset)!;
      const text = String.fromCodePoint(point);
      token = {
        kind: "error",
        text,
        span: { start: offset, end: offset + text.length },
        key: `symbol:${text}`,
        highlight: null,
      };
    }
    tokens.push(token);
    offset = token.span.end;
  }
  tokens.push({
    kind: "eof",
    text: "",
    span: { start: source.length, end: source.length },
    key: "eof",
    highlight: null,
  });
  return { tokens, trivia };
};
