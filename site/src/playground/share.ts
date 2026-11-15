/**
 * The playground's URL: `/<language>/<file>`, then a hash with an optional position and, once
 * the workspace differs from the example, the whole workspace.
 *
 *   /calc/demo.calc                 a file
 *   /calc/demo.calc#L3              a line
 *   /calc/demo.calc#L3-L5           a line range
 *   /calc/demo.calc#L3:5-L3:12      a range with columns (1-based)
 *   /calc/demo.calc#L3&w=<data>     with the workspace: every file, as deflated, base64url JSON
 *
 * The old `#calc:<data>` links (the changed files only) still open.
 */

/** One-based lines and columns. Without columns a position names whole lines. */
export type Position = {
  readonly line: number;
  readonly column?: number;
  readonly endLine: number;
  readonly endColumn?: number;
};

/** A workspace in file order: name and text. */
export type Files = readonly (readonly [name: string, text: string])[];

export type Place = {
  readonly language: string | null;
  readonly file: string | null;
  readonly position: Position | null;
  /** The encoded workspace, when the link carries one. */
  readonly data: string | null;
  /** An old `#language:<data>` link: the changed files by name. */
  readonly legacy?: string;
};

const encode = async (text: string): Promise<string> => {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const decode = async (data: string): Promise<string> => {
  const binary = atob(data.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Response(stream).text();
};

export const encodeFiles = (files: Files): Promise<string> => encode(JSON.stringify(files));

/** The workspace a link carries, or null when it does not decode. */
export const decodeFiles = async (data: string): Promise<Files | null> => {
  try {
    const value: unknown = JSON.parse(await decode(data));
    const valid = Array.isArray(value)
      && value.every((entry) => Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string");
    return valid ? value as Files : null;
  } catch {
    return null;
  }
};

/** The changed files of an old `#language:<data>` link. */
export const decodeLegacy = async (data: string): Promise<Readonly<Record<string, string>>> => {
  try {
    return JSON.parse(await decode(data));
  } catch {
    return {};
  }
};

const point = /^L(\d+)(?::(\d+))?$/;

export const parsePosition = (text: string): Position | null => {
  const [start, end] = text.split("-", 2);
  const from = start?.match(point);
  const to = end === undefined ? from : end.match(point);
  if (!from || !to) return null;
  const line = Number(from[1]);
  const endLine = Number(to[1]);
  if (line < 1 || endLine < 1) return null;
  const [first, last] = endLine < line ? [to, from] : [from, to];
  return {
    line: Number(first[1]),
    endLine: Number(last[1]),
    ...(first[2] ? { column: Number(first[2]) } : {}),
    ...(end !== undefined && last[2] ? { endColumn: Number(last[2]) } : {}),
  };
};

export const formatPosition = (position: Position): string => {
  const start = `L${position.line}${position.column ? `:${position.column}` : ""}`;
  const end = `L${position.endLine}${position.endColumn ? `:${position.endColumn}` : ""}`;
  return start === end || (position.endLine === position.line && !position.endColumn) ? start : `${start}-${end}`;
};

/** Reads a URL under `base` (the site's root path, ending in `/`). */
export const parsePlace = (url: URL, base: string): Place => {
  const hash = url.hash.slice(1);
  const old = hash.match(/^([a-z]+)(?::(.*))?$/);
  if (old && url.pathname === base) {
    return { language: old[1]!, file: null, position: null, data: null, ...(old[2] ? { legacy: old[2] } : {}) };
  }
  const [language, file] = url.pathname.slice(base.length).split("/").filter(Boolean).map(decodeURIComponent);
  const parts = hash.split("&");
  return {
    language: language ?? null,
    file: file ?? null,
    position: parts[0]?.startsWith("L") ? parsePosition(parts[0]) : null,
    data: parts.find((part) => part.startsWith("w="))?.slice(2) || null,
  };
};

export const formatPlace = (place: Place, base: string): string => {
  const hash = [place.position ? formatPosition(place.position) : "", place.data ? `w=${place.data}` : ""]
    .filter(Boolean).join("&");
  const path = [place.language, place.file].filter((part) => part !== null).map((part) => encodeURIComponent(part!)).join("/");
  return `${base}${path}${hash ? `#${hash}` : ""}`;
};
