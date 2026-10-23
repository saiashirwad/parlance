import type { GrammarSpec, KeyId } from "./spec.ts";
import { EOF, ERROR, REGEX, SYMBOL, TOKEN, TokenBuilder, TriviaBuilder, WORD } from "./tokens.ts";
import type { TokenList } from "./tokens.ts";

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

/**
 * Lex from a token boundary. `stop` runs after each token and can end the run
 * early; a stopped run has no eof token.
 */
/** Lex into caller-provided builders. Pushes eof only when it reaches the end. */
export const lexInto = (
  spec: GrammarSpec,
  source: string,
  start: number,
  tokens: TokenBuilder,
  trivia: TriviaBuilder,
  stop?: (tokens: TokenBuilder, offset: number) => boolean,
): void => {
  const singleSymbols = spec.singleSymbols;
  const multiSymbolsByFirst = spec.multiSymbolsByFirst;
  const keywordCandidates = spec.keywordCandidates;
  const maxKeywordLength = spec.maxKeywordLength;
  const wordKeyId = spec.wordKeyId;
  const slowSkips = spec.slowSkips;
  const tokenSpecs = spec.tokens;
  const inlineSpecs = spec.inline;
  const length = source.length;
  let offset = start;
  while (offset < length) {
    const triviaStart = offset;
    let sawComment = false;
    if (spec.fastWhitespace && slowSkips.length === 0 && !spec.fastBlockComment) {
      for (;;) {
        const before = offset;
        while (offset < length && isSpace(source.charCodeAt(offset))) offset++;
        if (spec.fastLineComment && source.charCodeAt(offset) === 47 && source.charCodeAt(offset + 1) === 47) {
          offset += 2;
          while (offset < length && source.charCodeAt(offset) !== 10 && source.charCodeAt(offset) !== 13) offset++;
          sawComment = true;
        }
        if (offset === before) break;
      }
    } else for (;;) {
      let moved = false;
      if (spec.fastWhitespace) {
        const before = offset;
        while (offset < length && isSpace(source.charCodeAt(offset))) offset++;
        moved = offset > before;
      }
      if (spec.fastLineComment && source.charCodeAt(offset) === 47 && source.charCodeAt(offset + 1) === 47) {
        offset += 2;
        while (offset < length && source.charCodeAt(offset) !== 10 && source.charCodeAt(offset) !== 13) offset++;
        sawComment = true;
        moved = true;
      }
      if (spec.fastBlockComment && source.charCodeAt(offset) === 47 && source.charCodeAt(offset + 1) === 42) {
        const close = source.indexOf("*/", offset + 2);
        offset = close < 0 ? length : close + 2;
        sawComment = true;
        moved = true;
      }
      for (let index = 0; index < slowSkips.length; index++) {
        const text = anchored(slowSkips[index]!, source, offset);
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
      trivia.push(triviaStart, offset, sawComment);
      if (offset >= length) break;
    }

    let kind = -1;
    let keyId: KeyId = 0;
    let end = offset;
    let highlight = 0;
    const code = source.charCodeAt(offset);
    const tokenCount = tokenSpecs.length;
    for (let index = 0; index < tokenCount; index++) {
      const spec0 = tokenSpecs[index]!;
      if (spec0.fast !== 0) {
        let scan = offset;
        while (scan < length) {
          const digit = source.charCodeAt(scan) - 48;
          if (digit < 0 || digit > 9) break;
          scan++;
        }
        if (scan === offset) continue;
        if (spec0.fast === 2 && source.charCodeAt(scan) === 46) {
          let fraction = scan + 1;
          while (fraction < length) {
            const digit = source.charCodeAt(fraction) - 48;
            if (digit < 0 || digit > 9) break;
            fraction++;
          }
          if (fraction > scan + 1) scan = fraction;
        }
        kind = TOKEN;
        keyId = spec0.keyId;
        end = scan;
        highlight = spec0.highlightCode;
        break;
      }
      if (spec0.first !== null && (code >= 128 || spec0.first[code] === 0)) continue;
      const text = anchored(spec0.regex, source, offset);
      if (text === undefined) continue;
      kind = TOKEN;
      keyId = spec0.keyId;
      end = offset + text.length;
      highlight = spec0.highlightCode;
      break;
    }
    if (kind < 0) {
      const inlineCount = inlineSpecs.length;
      for (let index = 0; index < inlineCount; index++) {
        const spec0 = inlineSpecs[index]!;
        const text = anchored(spec0.regex, source, offset);
        if (text === undefined) continue;
        kind = REGEX;
        keyId = spec0.keyId;
        end = offset + text.length;
        highlight = spec.regexHighlight;
        break;
      }
    }
    if (kind < 0) {
      if (spec.asciiWord) {
        if (isWordStart(code)) {
          const wordStart = offset++;
          while (offset < length && isWordPart(source.charCodeAt(offset))) offset++;
          const wordEnd = offset;
          offset = wordStart;
          let keyword = -1;
          const wordLength = wordEnd - wordStart;
          if (wordLength <= maxKeywordLength) {
            const candidates = keywordCandidates[wordLength];
            if (candidates !== undefined) {
              for (let index = 0; index < candidates.length; index++) {
                const candidate = candidates[index]!;
                if (source.startsWith(candidate.text, wordStart)) {
                  keyword = candidate.keyId;
                  break;
                }
              }
            }
          }
          kind = WORD;
          keyId = keyword < 0 ? wordKeyId : keyword;
          end = wordEnd;
          highlight = keyword < 0 ? spec.wordHighlight : spec.keywordHighlight;
        }
      } else {
        const word = anchored(spec.word, source, offset);
        if (word !== undefined) {
          let keyword = -1;
          if (word.length <= maxKeywordLength) {
            const candidates = keywordCandidates[word.length];
            if (candidates !== undefined) {
              for (let index = 0; index < candidates.length; index++) {
                if (candidates[index]!.text === word) {
                  keyword = candidates[index]!.keyId;
                  break;
                }
              }
            }
          }
          kind = WORD;
          keyId = keyword < 0 ? wordKeyId : keyword;
          end = offset + word.length;
          highlight = keyword < 0 ? spec.wordHighlight : spec.keywordHighlight;
        }
      }
    }
    if (kind < 0) {
      const candidates = multiSymbolsByFirst.get(code);
      if (candidates !== undefined) {
        for (let index = 0; index < candidates.length; index++) {
          const entry = candidates[index]!;
          if (!source.startsWith(entry.text, offset)) continue;
          kind = SYMBOL;
          keyId = entry.keyId;
          end = offset + entry.text.length;
          highlight = spec.symbolHighlight;
          break;
        }
      }
      if (kind < 0) {
        const single = code < 128 ? singleSymbols[code] : undefined;
        if (single !== undefined) {
          kind = SYMBOL;
          keyId = single.keyId;
          end = offset + 1;
          highlight = spec.symbolHighlight;
        }
      }
    }
    if (kind < 0) {
      const point = source.codePointAt(offset)!;
      kind = ERROR;
      keyId = spec.errorKeyId;
      end = offset + (point > 0xffff ? 2 : 1);
    }
    tokens.push(kind, keyId, offset, end, highlight);
    offset = end;
    if (stop !== undefined && stop(tokens, offset)) return;
  }
  tokens.push(EOF, spec.eofKeyId, length, length, 0);
};

export const lexFrom = (
  spec: GrammarSpec,
  source: string,
  start: number,
  stop?: (tokens: TokenBuilder, offset: number) => boolean,
): TokenList => {
  const tokens = new TokenBuilder(source.length >> 2);
  const trivia = new TriviaBuilder(source.length >> 4);
  lexInto(spec, source, start, tokens, trivia, stop);
  return tokens.finish(source, trivia, spec);
};

export const lex = (spec: GrammarSpec, source: string): TokenList => lexFrom(spec, source, 0);
