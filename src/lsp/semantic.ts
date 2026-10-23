import type { TextDocument } from "vscode-languageserver-textdocument";
import type { FoldingRange } from "vscode-languageserver/node";
import { refinedKinds, type Token, type TokenKind, tokenKinds } from "../check/index.ts";
import type { Analysis } from "../language.ts";
import type { GrammarSpec } from "../parser/spec.ts";
import { SYMBOL, type TokenList } from "../parser/tokens.ts";

const kindIndex = new Map(tokenKinds.map((kind, index) => [kind, index]));
const kindCode = (kind: TokenKind): number => kindIndex.get(kind) ?? 0;
const COMMENT = kindCode("comment");
const HIGHLIGHT_CODES = tokenKinds.map((kind) => kindCode(kind));

const lineStartsOf = (source: string): number[] => {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);
    if (code === 13) {
      if (source.charCodeAt(index + 1) === 10) index++;
      starts.push(index + 1);
    } else if (code === 10) {
      starts.push(index + 1);
    }
  }
  return starts;
};

/** LSP delta encoding. One forward pass over the source and sorted spans. */
const encoder = (source: string, capacity: number) => {
  const starts = lineStartsOf(source);
  const data: number[] = new Array(capacity);
  let used = 0;
  let line = 0;
  let character = 0;
  let previousEnd = 0;
  let lineIndex = 0;
  return {
    finish(): number[] {
      data.length = used;
      return data;
    },
    push(start: number, end: number, type: number): void {
      let at = start < 0 ? 0 : start > source.length ? source.length : start;
      const limit = end < at ? at : end > source.length ? source.length : end;
      while (lineIndex + 1 < starts.length && starts[lineIndex + 1]! <= at) lineIndex++;
      while (at < limit) {
        const lineEnd = lineIndex + 1 < starts.length ? starts[lineIndex + 1]! : source.length;
        let segmentEnd = Math.min(limit, lineEnd);
        while (segmentEnd > at) {
          const code = source.charCodeAt(segmentEnd - 1);
          if (code === 10 || code === 13) segmentEnd--;
          else break;
        }
        if (segmentEnd > at) {
          const column = at - starts[lineIndex]!;
          if (lineIndex !== line || column >= previousEnd) {
            data[used++] = lineIndex - line;
            data[used++] = lineIndex === line ? column - character : column;
            data[used++] = segmentEnd - at;
            data[used++] = type;
            data[used++] = 0;
            line = lineIndex;
            character = column;
            previousEnd = column + (segmentEnd - at);
          }
        }
        at = Math.min(limit, lineEnd);
        if (at >= limit) break;
        lineIndex++;
      }
    },
  };
};

export const encodeTokens = (document: TextDocument, tokens: readonly Token[]): number[] => {
  const output = encoder(document.getText(), tokens.length * 5);
  for (const token of tokens) output.push(token.span.start, token.span.end, kindCode(token.kind));
  return output.finish();
};

/** Encode straight from the token buffer, refining kinds from check facts. */
export const encodeAnalysis = <Ast, Ir, Type>(document: TextDocument, analysis: Analysis<Ast, Ir, Type>): number[] => {
  const list = analysis.lex;
  const source = document.getText();
  const trivia = list.trivia;
  const output = encoder(source, list.length * 5 + trivia.length * 5);
  const exact = refinedKinds(analysis.facts);
  let comment = 0;
  for (let index = 0; index < list.length; index++) {
    const start = list.start[index]!;
    while (comment < trivia.length && trivia.start[comment]! < start) {
      if (trivia.kind[comment] === 1) {
        output.push(trivia.start[comment]!, trivia.end[comment]!, COMMENT);
      }
      comment++;
    }
    const highlight = list.highlightAt(index);
    if (highlight === 0) continue;
    const end = list.end[index]!;
    const refined = exact.get(start);
    output.push(start, end, refined === undefined ? HIGHLIGHT_CODES[highlight - 1]! : kindCode(refined));
  }
  for (; comment < trivia.length; comment++) {
    if (trivia.kind[comment] === 1) {
      output.push(trivia.start[comment]!, trivia.end[comment]!, COMMENT);
    }
  }
  return output.finish();
};

type Brackets = { readonly openers: ReadonlySet<number>; readonly closers: ReadonlyMap<number, number> };

const brackets = new WeakMap<GrammarSpec, Brackets>();

const bracketsOf = (spec: GrammarSpec): Brackets => {
  const cached = brackets.get(spec);
  if (cached !== undefined) return cached;
  const openers = new Set<number>();
  const closers = new Map<number, number>();
  const idOf = (text: string): number => spec.keyText.indexOf(`symbol:${text}`);
  for (const [close, open] of [["}", "{"], [")", "("], ["]", "["]] as const) {
    const openId = idOf(open);
    const closeId = idOf(close);
    if (openId < 0 || closeId < 0) continue;
    openers.add(openId);
    closers.set(closeId, openId);
  }
  const value = { openers, closers };
  brackets.set(spec, value);
  return value;
};

export const folding = (tokens: TokenList, document: TextDocument, spec: GrammarSpec): FoldingRange[] => {
  const { openers, closers } = bracketsOf(spec);
  const stack: { id: number; start: number; }[] = [];
  const ranges: FoldingRange[] = [];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens.kindAt(index) !== SYMBOL) continue;
    const id = tokens.keyId[index]!;
    if (openers.has(id)) {
      stack.push({ id, start: tokens.start[index]! });
      continue;
    }
    const open = closers.get(id);
    if (open === undefined) continue;
    for (let at = stack.length - 1; at >= 0; at--) {
      if (stack[at]!.id !== open) continue;
      const found = stack.splice(at, 1)[0]!;
      const start = document.positionAt(found.start);
      const end = document.positionAt(tokens.end[index]!);
      if (start.line < end.line) ranges.push({ startLine: start.line, endLine: end.line });
      break;
    }
  }
  return ranges;
};
