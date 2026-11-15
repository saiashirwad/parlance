import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SyntaxKind } from "typescript/ast";
import { createScanner } from "typescript/ast/scanner";
import { type Diagnostic, type Severity, site } from "../diagnostic.ts";
import type { Analysis, AnyLanguage } from "../language.ts";
import type { ModuleGraph } from "../modules.ts";
import { lineStarts, positionAt, type Span } from "../source.ts";
import type { Mapping, TsDoc } from "./template.ts";

/** The stub a TypeScript file imports tag functions from: `import { schema } from "./parlance.embeds"`. */
export const embedsExtension = ".embeds";

/** One `tag("Key")` template in a TypeScript file. Offsets without a qualifier are host offsets. */
export type Snippet = {
  readonly language: AnyLanguage;
  readonly tag: string;
  readonly key: string;
  /** The host file's URL. */
  readonly file: string;
  /** `<file>#embed=<tag>:<key>`, the snippet's identity in the module graph. */
  readonly uri: string;
  /** The cooked template text, escapes applied, with one space for each hole. */
  readonly text: string;
  /** The template literal, backticks included. */
  readonly span: Span;
  /** The key string literal, quotes included. */
  readonly keySpan: Span;
  /** `${...}` holes, which snippets do not support yet. */
  readonly holes: readonly Span[];
  /** The host offset of each snippet offset; `text.length + 1` entries. */
  readonly offsets: Int32Array;
};

/** A snippet problem located in the host file. */
export type HostDiagnostic = {
  readonly message: string;
  readonly severity: Severity;
  readonly span: Span;
  readonly source: Diagnostic | null;
};

/** Embed languages by tag. Tags must be identifiers and unique. */
export const embedTags = (languages: readonly AnyLanguage[]): ReadonlyMap<string, AnyLanguage> => {
  const tags = new Map<string, AnyLanguage>();
  for (const language of languages) {
    const tag = language.embed?.tag;
    if (tag === undefined) continue;
    if (!/^[A-Za-z_$][\w$]*$/.test(tag)) throw new Error(`${language.name}: embed tag ${JSON.stringify(tag)} is not an identifier`);
    const existing = tags.get(tag);
    if (existing) throw new Error(`embed tag ${tag} is used by both ${existing.name} and ${language.name}`);
    tags.set(tag, language);
  }
  return tags;
};

export const isHostFile = (path: string): boolean => /\.[cm]?tsx?$/.test(path) && !/\.d\.[cm]?tsx?$/.test(path);

export const isSnippetUri = (uri: string): boolean => uri.includes("#embed=");

/** Tokens after which a slash divides; anywhere else it starts a regular expression. */
const endsExpression = new Set<SyntaxKind>([
  SyntaxKind.Identifier,
  SyntaxKind.PrivateIdentifier,
  SyntaxKind.NumericLiteral,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateTail,
  SyntaxKind.CloseParenToken,
  SyntaxKind.CloseBracketToken,
  SyntaxKind.CloseBraceToken,
  SyntaxKind.PlusPlusToken,
  SyntaxKind.MinusMinusToken,
  SyntaxKind.ExclamationToken,
  SyntaxKind.ThisKeyword,
  SyntaxKind.SuperKeyword,
  SyntaxKind.TrueKeyword,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
]);

type Piece = { readonly start: number; readonly end: number };

const simpleEscapes: Readonly<Record<string, string>> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v" };

const hexAt = (source: string, start: number, length: number, end: number): number | null => {
  const digits = source.slice(start, start + length);
  return start + length <= end && new RegExp(`^[0-9A-Fa-f]{${length}}$`).test(digits) ? Number.parseInt(digits, 16) : null;
};

/**
 * Cooks raw template pieces into guest text and records where each guest unit came from. Escapes
 * follow ECMAScript template rules; CR LF and CR become LF; an invalid escape keeps its character.
 */
const cook = (source: string, pieces: readonly Piece[]): { text: string; offsets: Int32Array } => {
  let text = "";
  const at: number[] = [];
  const push = (value: string, host: number) => {
    text += value;
    for (let index = 0; index < value.length; index++) at.push(host);
  };
  for (let piece = 0; piece < pieces.length; piece++) {
    const { start, end } = pieces[piece]!;
    if (piece > 0) push(" ", pieces[piece - 1]!.end);
    let index = start;
    while (index < end) {
      const char = source[index]!;
      if (char === "\r") {
        push("\n", index);
        index += index + 1 < end && source[index + 1] === "\n" ? 2 : 1;
        continue;
      }
      if (char !== "\\" || index + 1 >= end) {
        push(char, index);
        index++;
        continue;
      }
      const next = source[index + 1]!;
      if (next in simpleEscapes) {
        push(simpleEscapes[next]!, index);
        index += 2;
      } else if (next === "0" && !/[0-9]/.test(source[index + 2] ?? "")) {
        push("\0", index);
        index += 2;
      } else if (next === "\n" || next === "\u2028" || next === "\u2029") {
        index += 2;
      } else if (next === "\r") {
        index += source[index + 2] === "\n" ? 3 : 2;
      } else if (next === "x" && hexAt(source, index + 2, 2, end) !== null) {
        push(String.fromCharCode(hexAt(source, index + 2, 2, end)!), index);
        index += 4;
      } else if (next === "u" && source[index + 2] === "{") {
        const close = source.indexOf("}", index + 3);
        const code = close > 0 && close < end ? hexAt(source, index + 3, close - index - 3, end) : null;
        if (code !== null && code <= 0x10ffff) {
          push(String.fromCodePoint(code), index);
          index = close + 1;
        } else {
          push(next, index);
          index += 2;
        }
      } else if (next === "u" && hexAt(source, index + 2, 4, end) !== null) {
        push(String.fromCharCode(hexAt(source, index + 2, 4, end)!), index);
        index += 6;
      } else {
        push(next, index);
        index += 2;
      }
    }
  }
  const offsets = new Int32Array(at.length + 1);
  offsets.set(at);
  offsets[at.length] = pieces.at(-1)?.end ?? 0;
  return { text, offsets };
};

type Building = {
  readonly tag: string;
  readonly key: string;
  readonly keySpan: Span;
  readonly start: number;
  readonly pieces: Piece[];
  readonly holes: Span[];
  holeStart: number;
};

type Recent = { readonly kind: SyntaxKind; readonly start: number; readonly end: number; readonly value: string };

/**
 * Finds `tag("Key")` templates with the TypeScript scanner, so strings, comments, regular expressions,
 * and nested templates never produce false matches. A member call such as `db.schema("K")` is not one.
 */
export const findSnippets = (
  source: string,
  file: string,
  tags: ReadonlyMap<string, AnyLanguage>,
): Snippet[] => {
  if (tags.size === 0) return [];
  const scanner = createScanner(true, 0, source);
  const found: Snippet[] = [];
  /** Open braces and template heads. A snippet's template entry holds the snippet being built. */
  const stack: ({ readonly kind: "brace" } | { readonly kind: "template"; readonly snippet: Building | null })[] = [];
  const recent: Recent[] = [];
  const finish = (building: Building, end: number) => {
    const { text, offsets } = cook(source, building.pieces);
    found.push({
      language: tags.get(building.tag)!,
      tag: building.tag,
      key: building.key,
      file,
      uri: `${file}#embed=${building.tag}:${encodeURIComponent(building.key)}`,
      text,
      span: { start: building.start, end },
      keySpan: building.keySpan,
      holes: building.holes,
      offsets,
    });
  };
  /** The snippet a template starting here opens, read from the tokens before it. */
  const keyed = (start: number): Building | null => {
    const [close, key, open, tag, before] = [recent.at(-1), recent.at(-2), recent.at(-3), recent.at(-4), recent.at(-5)];
    if (!tag || !open || !key || !close) return null;
    if (tag.kind !== SyntaxKind.Identifier || !tags.has(tag.value)) return null;
    if (open.kind !== SyntaxKind.OpenParenToken || key.kind !== SyntaxKind.StringLiteral) return null;
    if (close.kind !== SyntaxKind.CloseParenToken) return null;
    if (before && (before.kind === SyntaxKind.DotToken || before.kind === SyntaxKind.QuestionDotToken)) return null;
    return { tag: tag.value, key: key.value, keySpan: { start: key.start, end: key.end }, start, pieces: [], holes: [], holeStart: 0 };
  };
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if (kind === SyntaxKind.SlashToken || kind === SyntaxKind.SlashEqualsToken) {
      const previous = recent.at(-1)?.kind;
      if (previous === undefined || !endsExpression.has(previous)) kind = scanner.reScanSlashToken();
    }
    if (kind === SyntaxKind.CloseBraceToken && stack.at(-1)?.kind === "template") {
      kind = scanner.reScanTemplateToken(false);
    }
    const start = scanner.getTokenStart();
    const end = scanner.getTokenEnd();
    const closed = !scanner.isUnterminated();
    switch (kind) {
      case SyntaxKind.OpenBraceToken:
        stack.push({ kind: "brace" });
        break;
      case SyntaxKind.CloseBraceToken:
        stack.pop();
        break;
      case SyntaxKind.NoSubstitutionTemplateLiteral: {
        const building = keyed(start);
        if (building) {
          building.pieces.push({ start: start + 1, end: closed ? end - 1 : end });
          finish(building, end);
        }
        break;
      }
      case SyntaxKind.TemplateHead: {
        const building = keyed(start);
        if (building) {
          building.pieces.push({ start: start + 1, end: end - 2 });
          building.holeStart = end - 2;
        }
        stack.push({ kind: "template", snippet: building });
        break;
      }
      case SyntaxKind.TemplateMiddle:
      case SyntaxKind.TemplateTail: {
        const top = stack.at(-1);
        const building = top?.kind === "template" ? top.snippet : null;
        const tail = kind === SyntaxKind.TemplateTail;
        if (building) {
          building.holes.push({ start: building.holeStart, end: start + 1 });
          building.pieces.push({ start: start + 1, end: tail ? (closed ? end - 1 : end) : end - 2 });
          building.holeStart = end - 2;
          if (tail) finish(building, end);
        }
        if (tail) stack.pop();
        break;
      }
    }
    const value = kind === SyntaxKind.Identifier || kind === SyntaxKind.StringLiteral ? scanner.getTokenValue() : "";
    recent.push({ kind, start, end, value });
    if (recent.length > 5) recent.shift();
  }
  return found;
};

/** The host offset of a snippet offset. */
export const toHost = (snippet: Snippet, offset: number): number =>
  snippet.offsets[Math.max(0, Math.min(snippet.text.length, offset))]!;

/** One past the raw text the snippet unit at `offset` came from. */
const rawEnd = (snippet: Snippet, offset: number): number => {
  const host = snippet.offsets[offset]!;
  let index = offset + 1;
  while (index < snippet.text.length && snippet.offsets[index] === host) index++;
  return Math.max(host + 1, snippet.offsets[index]!);
};

/** A snippet span in host offsets. A span over an escape covers the whole escape sequence. */
export const hostSpan = (snippet: Snippet, span: Span): Span => {
  const start = toHost(snippet, span.start);
  return { start, end: span.end > span.start ? rawEnd(snippet, Math.min(span.end, snippet.text.length) - 1) : start };
};

/** The snippet offset of a host offset inside the template's text, or undefined outside it. */
export const toSnippet = (snippet: Snippet, host: number): number | undefined => {
  if (host <= snippet.span.start || host >= snippet.span.end) return undefined;
  const { offsets } = snippet;
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (offsets[middle]! <= host) low = middle;
    else high = middle - 1;
  }
  return low;
};

export const snippetAt = (snippets: readonly Snippet[], host: number): Snippet | undefined =>
  snippets.find((snippet) => toSnippet(snippet, host) !== undefined);

export const analyzeSnippet = (graph: ModuleGraph, snippet: Snippet): Analysis =>
  graph.analyze(snippet.uri, { source: snippet.text, language: snippet.language });

/** The snippet's own diagnostics and its unsupported holes, in host offsets. */
export const snippetDiagnostics = (snippet: Snippet, analysis: Analysis): HostDiagnostic[] => [
  ...snippet.holes.map((span): HostDiagnostic => ({
    message: `${snippet.tag} snippets do not support ${"${}"} holes yet`,
    severity: "error",
    span,
    source: null,
  })),
  ...analysis.diagnostics.flatMap((entry): HostDiagnostic[] => {
    const location = site(entry, snippet.uri);
    if (location.uri !== snippet.uri) return [];
    return [{ message: entry.message, severity: entry.severity, span: hostSpan(snippet, location.span), source: entry }];
  }),
];

/** Keys repeated for one tag. The first snippet keeps the key; later ones are reported at their key. */
export const duplicateKeys = (snippets: readonly Snippet[], seen = new Map<string, Snippet>()): HostDiagnostic[] =>
  snippets.flatMap((snippet): HostDiagnostic[] => {
    const id = `${snippet.tag}:${snippet.key}`;
    if (!seen.has(id)) {
      seen.set(id, snippet);
      return [];
    }
    return [{
      message: `Duplicate ${snippet.tag} snippet key ${JSON.stringify(snippet.key)}; keys are unique per ${embedsExtension} stub`,
      severity: "error",
      span: snippet.keySpan,
      source: null,
    }];
  });

/** TypeScript files under a directory, skipping `node_modules` and dot directories. */
export const hostFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
      try {
        return hostFiles(path);
      } catch {
        return [];
      }
    }
    return entry.isFile() && isHostFile(entry.name) ? [path] : [];
  }).sort();

const read = (path: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

/** Stubs covering a host file: `.embeds` files in its directory and each ancestor. */
export const stubsFor = (path: string): string[] => {
  const found: string[] = [];
  for (let directory = dirname(resolve(path)); ; directory = dirname(directory)) {
    try {
      for (const name of readdirSync(directory)) if (name.endsWith(embedsExtension)) found.push(join(directory, name));
    } catch {
      // An unreadable directory has no stubs.
    }
    if (dirname(directory) === directory) return found;
  }
};

/**
 * A file outside the project that the content mapper watches for a stub. tsgo ignores disk events
 * for files open in the editor, so saving a snippet in an open file would not refresh its types;
 * the LSP writes this file instead, which makes tsgo reopen the project and rebuild the registry.
 */
export const embedStamp = (stub: string): string =>
  join(tmpdir(), "parlance-embeds", `${createHash("sha256").update(resolve(stub)).digest("hex").slice(0, 16)}.stamp`);

export const touchStamp = (stub: string, onlyIfMissing = false): void => {
  const path = embedStamp(stub);
  if (onlyIfMissing && existsSync(path)) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${Date.now()}\n`);
  } catch {
    // Types then refresh on the next project reload.
  }
};

/** What a stub's registry depends on in one host file. */
export const snippetSignature = (snippets: readonly Snippet[]): string =>
  snippets.map((snippet) => `${snippet.tag}\0${snippet.key}\0${snippet.text}`).join("\0\0");

export type HostFile = { readonly path: string; readonly source: string; readonly snippets: readonly Snippet[] };

/** The snippets a stub covers: every TypeScript file under its directory, read from disk. */
export const stubSnippets = (stub: string, tags: ReadonlyMap<string, AnyLanguage>): HostFile[] =>
  tags.size === 0 ? [] : hostFiles(dirname(stub)).flatMap((path) => {
    const source = read(path);
    if (![...tags.keys()].some((tag) => source.includes(tag))) return [];
    const snippets = findSnippets(source, pathToFileURL(path).href, tags);
    return snippets.length === 0 ? [] : [{ path, source, snippets }];
  });

const interfaceName = (tag: string): string => `${tag[0]!.toUpperCase()}${tag.slice(1)}Embeds`;

const importLine = /^import\s+(type\s+)?(.+?)\s+from\s+(["'])([^"']*)\3\s*;?\s*$/;

const rebase = (specifier: string, from: string, to: string): string => {
  if (!specifier.startsWith(".")) return specifier;
  const path = relative(to, resolve(from, specifier)).replaceAll("\\", "/");
  return path.startsWith(".") ? path : `./${path}`;
};

/**
 * A module-shaped declaration file as the body of an ambient namespace. Each import becomes a
 * hoisted namespace import with aliases inside, so snippets cannot collide; a default import is
 * hoisted under its own name. Relative specifiers move from the host's directory to the stub's.
 */
const namespaced = (text: string, from: string, to: string, counter: { next: number }): { hoisted: string[]; body: string } => {
  const hoisted: string[] = [];
  const body: string[] = [];
  for (const line of text.split("\n")) {
    const found = importLine.exec(line);
    if (found) {
      const type = found[1] ?? "";
      const clause = found[2]!;
      const specifier = JSON.stringify(rebase(found[4]!, from, to));
      const alias = `__import${counter.next++}`;
      hoisted.push(`import ${type}* as ${alias} from ${specifier};`);
      const named = /\{([^}]*)\}/.exec(clause)?.[1];
      const star = /\*\s+as\s+([\w$]+)/.exec(clause)?.[1];
      const fallback = /^([\w$]+)\s*(,|$)/.exec(clause)?.[1];
      if (fallback) hoisted.push(`import ${type}${fallback} from ${specifier};`);
      if (star) body.push(`  import ${star} = ${alias};`);
      for (const part of (named ?? "").split(",").map((entry) => entry.trim()).filter(Boolean)) {
        const [name, local = name] = part.replace(/^type\s+/, "").split(/\s+as\s+/) as [string, string?];
        body.push(`  import ${local} = ${alias}.${name};`);
      }
      continue;
    }
    if (/^import\s+["']/.test(line)) continue;
    const exported = /^export\s+default\s+([\w$]+)\s*;\s*$/.exec(line);
    if (exported) body.push(`  export { ${exported[1]} as default };`);
    else body.push(line === "" ? "" : `  ${line.replace(/^(\s*)(export\s+)?declare\s+/, "$1$2")}`);
  }
  return { hoisted, body: body.join("\n").trimEnd() };
};

export type Registry = {
  readonly text: string;
  readonly diagnostics: readonly { readonly file: HostFile; readonly diagnostic: HostDiagnostic }[];
  readonly files: readonly HostFile[];
};

/**
 * The typed tag functions for one stub: a namespace per snippet holding the language's TypeScript
 * surface, an interface per tag keyed by snippet key, and a tag function over those keys.
 */
export const embedRegistry = (stub: string, graph: ModuleGraph, tags: ReadonlyMap<string, AnyLanguage>): Registry => {
  const directory = dirname(stub);
  const hoisted: string[] = [];
  const namespaces: string[] = [];
  const entries = new Map<string, string[]>([...tags.keys()].map((tag) => [tag, []]));
  const diagnostics: { file: HostFile; diagnostic: HostDiagnostic }[] = [];
  const counter = { next: 0 };
  const seen = new Map<string, Snippet>();
  const files = stubSnippets(stub, tags);
  for (const file of files) {
    for (const diagnostic of duplicateKeys(file.snippets, seen)) diagnostics.push({ file, diagnostic });
    for (const snippet of file.snippets) {
      if (seen.get(`${snippet.tag}:${snippet.key}`) !== snippet) continue;
      const analysis = analyzeSnippet(graph, snippet);
      for (const diagnostic of snippetDiagnostics(snippet, analysis)) diagnostics.push({ file, diagnostic });
      const doc = snippet.language.typescript && analysis.ir !== null ? snippet.language.typescript(analysis.ir) : null;
      const name = `__${snippet.tag}${namespaces.length}`;
      const wrapped = namespaced(doc?.text ?? "", dirname(file.path), directory, counter);
      hoisted.push(...wrapped.hoisted);
      namespaces.push(`/** ${snippet.tag}(${JSON.stringify(snippet.key)}) in ${relative(directory, file.path)} */\ndeclare namespace ${name} {\n${wrapped.body}\n}\n`);
      entries.get(snippet.tag)!.push(`  readonly ${JSON.stringify(snippet.key)}: typeof ${name};`);
    }
  }
  const tagged = [...entries].map(([tag, list]) => {
    const name = interfaceName(tag);
    return `export interface ${name} {\n${list.map((entry) => `${entry}\n`).join("")}}\n`
      + `export declare function ${tag}<K extends keyof ${name}>(key: K): (strings: TemplateStringsArray, ...holes: unknown[]) => ${name}[K];\n`;
  });
  const text = [...hoisted, ...(hoisted.length ? [""] : []), ...namespaces, ...tagged].join("\n");
  return { text: text || "export {};\n", diagnostics, files };
};

/** `file.ts(line,col)`, one-based, for messages outside an editor. */
export const hostLocation = (path: string, source: string, offset: number): string => {
  const { line, character } = positionAt(lineStarts(source), offset);
  return `${path}(${line + 1},${character + 1})`;
};

/** The query the loader puts on a host URL to load one snippet's runtime. */
export const snippetQuery = "parlance-embed";

/**
 * The runtime registry for one importer: each of its snippets is imported from
 * `<file>?parlance-embed=tag:key`, and each tag function returns the keyed snippet's module.
 */
export const embedModule = (importer: string, source: string, tags: ReadonlyMap<string, AnyLanguage>): string => {
  const lines: string[] = [];
  const table = new Map<string, string[]>([...tags.keys()].map((tag) => [tag, []]));
  findSnippets(source, importer, tags).forEach((snippet, index) => {
    const url = new URL(importer);
    url.searchParams.set(snippetQuery, `${snippet.tag}:${snippet.key}`);
    lines.push(`import * as _s${index} from ${JSON.stringify(url.href)};`);
    table.get(snippet.tag)!.push(`${JSON.stringify(snippet.key)}: _s${index}`);
  });
  lines.push(
    "const tag = (name, table) => (key) => {",
    "  if (!Object.hasOwn(table, key)) throw new Error(`No ${name} snippet keyed ${JSON.stringify(key)} in this file`);",
    "  return () => table[key];",
    "};",
  );
  for (const [tag, list] of table) lines.push(`export const ${tag} = tag(${JSON.stringify(tag)}, { ${list.join(", ")} });`);
  return `${lines.join("\n")}\n`;
};

/** One snippet's runtime module. Guest positions in a `TsDoc` move to host positions. */
export const snippetRuntime = (snippet: Snippet, analysis: Analysis): string | TsDoc => {
  if (!snippet.language.runtime) throw new SyntaxError(`${snippet.language.name} has no runtime`);
  const emitted = snippet.language.runtime(analysis.ir);
  if (typeof emitted === "string") return emitted;
  return {
    text: emitted.text,
    mappings: emitted.mappings.map((mapping): Mapping => {
      const span = hostSpan(snippet, { start: mapping[2], end: mapping[2] + mapping[3] });
      const [virtual, length, , , kind, features] = mapping;
      const size = span.end - span.start;
      return features === undefined ? [virtual, length, span.start, size, kind] : [virtual, length, span.start, size, kind, features];
    }),
  };
};

/** A host file's path from a snippet URI or a loader URL with a query. */
export const hostPath = (uri: string): string => fileURLToPath(uri.replace(/[?#].*$/, ""));
