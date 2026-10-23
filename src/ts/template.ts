import type { Span } from "../source.ts";

/** A virtual range and the original range it came from. Kind 0 is verbatim, kind 1 is an atom. */
export type Mapping = readonly [number, number, number, number, 0 | 1, number?];

export type TsDoc = { readonly text: string; readonly mappings: readonly Mapping[] };

/** Text with a source span. Interpolating one records a mapping at that virtual offset. */
export type Mapped = {
  readonly text: string;
  readonly span: Span;
  readonly mode?: "verbatim" | "atom";
  readonly features?: number;
};

export type TsNode = string | TsDoc | Mapped | readonly TsNode[] | null | undefined | false;

/** Interpolations also accept numbers and booleans, which are stringified without a mapping. */
export type TsValue =
  | string
  | TsDoc
  | Mapped
  | number
  | boolean
  | readonly TsValue[]
  | null
  | undefined;

type Buffer = {
  readonly parts: string[];
  length: number;
  readonly mappings: Mapping[];
};

export const feature = {
  hover: 1,
  definition: 8,
  references: 64,
  atom: 73,
} as const;

const assertVerbatim = (text: string, originalLength: number): void => {
  if (text.length !== originalLength) {
    throw new RangeError(`verbatim text has ${text.length} UTF-16 units but its span has ${originalLength}`);
  }
};

export const mapped = (
  text: string,
  span: Span,
  options: { readonly mode?: "verbatim" | "atom"; readonly features?: number } = {},
): Mapped => {
  if (options.mode === "verbatim") assertVerbatim(text, span.end - span.start);
  return {
    text,
    span,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.features === undefined ? {} : { features: options.features }),
  };
};

export const atom = (text: string, span: Span, features?: number): Mapped =>
  features === undefined ? mapped(text, span, { mode: "atom" }) : mapped(text, span, { mode: "atom", features });

export const verbatim = (text: string, span: Span): Mapped => mapped(text, span, { mode: "verbatim" });

/** Emits a node's own text with a verbatim mapping. The common case for identifiers and literals. */
export const source = (value: { readonly text: string; readonly span: Span } | string, span?: Span): Mapped =>
  typeof value === "string" ? verbatim(value, span!) : verbatim(value.text, value.span);

/** Emits synthesized text mapped to a source span. Hover, definition, and references are kept. */
export const synth = (text: string, span: Span, features: number = feature.atom): Mapped =>
  atom(text, span, features);

const create = (): Buffer => ({ parts: [], length: 0, mappings: [] });

const build = (buffer: Buffer): TsDoc => ({ text: buffer.parts.join(""), mappings: buffer.mappings });

const shift = (mapping: Mapping, offset: number): Mapping => {
  const [virtualStart, virtualLength, originalStart, originalLength, kind, features] = mapping;
  return features === undefined
    ? [virtualStart + offset, virtualLength, originalStart, originalLength, kind]
    : [virtualStart + offset, virtualLength, originalStart, originalLength, kind, features];
};

const mappingFor = (value: Mapped, offset: number): Mapping => {
  const virtualLength = value.text.length;
  const originalLength = value.span.end - value.span.start;
  if (value.mode === "verbatim") {
    assertVerbatim(value.text, originalLength);
    return [offset, virtualLength, value.span.start, originalLength, 0];
  }
  return [offset, virtualLength, value.span.start, originalLength, 1, value.features ?? feature.atom];
};

const isArray = (value: TsValue): value is readonly TsValue[] => Array.isArray(value);

const isDoc = (value: TsDoc | Mapped): value is TsDoc => "mappings" in value;

const write = (buffer: Buffer, value: TsValue): void => {
  if (value === null || value === undefined || value === false) return;
  if (typeof value === "string") {
    buffer.parts.push(value);
    buffer.length += value.length;
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    const text = String(value);
    buffer.parts.push(text);
    buffer.length += text.length;
    return;
  }
  if (isArray(value)) {
    for (const child of value) write(buffer, child);
    return;
  }
  if (isDoc(value)) {
    const offset = buffer.length;
    buffer.parts.push(value.text);
    buffer.length += value.text.length;
    for (const mapping of value.mappings) buffer.mappings.push(shift(mapping, offset));
    return;
  }
  buffer.mappings.push(mappingFor(value, buffer.length));
  buffer.parts.push(value.text);
  buffer.length += value.text.length;
};

export const doc = (parts: TemplateStringsArray, ...values: readonly TsValue[]): TsDoc => {
  const buffer = create();
  for (let index = 0; index < parts.length; index++) {
    write(buffer, parts.raw[index] ?? "");
    if (index < values.length) write(buffer, values[index]);
  }
  return build(buffer);
};

/** Alias for `doc`, named after the TypeScript surface it builds. */
export const ts = doc;

export const join = (nodes: readonly TsValue[], separator = ""): TsDoc => {
  const buffer = create();
  for (let index = 0; index < nodes.length; index++) {
    if (index > 0) write(buffer, separator);
    write(buffer, nodes[index]);
  }
  return build(buffer);
};

export const line = (node: TsValue): TsDoc => join([node, "\n"]);

export const empty: TsDoc = { text: "", mappings: [] };
