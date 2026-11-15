import { type Span, positionAt, type Source } from "./source.ts";

export type Severity = "error" | "warning" | "info";

export type SourceLocation = { readonly uri: string; readonly span: Span };

export type Related = { readonly location: SourceLocation; readonly message: string };

/** A text replacement in the reported document. */
export type Edit = { readonly span: Span; readonly newText: string };

/** A quick fix an editor can apply for a diagnostic. */
export type Fix = { readonly title: string; readonly edits: readonly Edit[] };

export type Diagnostic = {
  readonly message: string;
  readonly severity: Severity;
  readonly span: Span;
  readonly code?: string;
  readonly context?: readonly string[];
  readonly related?: readonly Related[];
  /** An edit that resolves the diagnostic, offered as an editor quick fix. */
  readonly fix?: Fix;
  /** Where the error originated, when it is not the reported document. */
  readonly origin?: SourceLocation;
  /** Where the error should be shown, when that differs from `origin`. */
  readonly location?: SourceLocation;
};

export type DiagnosticOptions = {
  readonly code?: string;
  readonly context?: readonly string[];
  readonly related?: readonly Related[];
  readonly severity?: Severity;
  readonly fix?: Fix;
};

export const diagnostic = (message: string, at: Span, options: DiagnosticOptions = {}): Diagnostic => ({
  message,
  severity: options.severity ?? "error",
  span: at,
  ...(options.code === undefined ? {} : { code: options.code }),
  ...(options.context === undefined ? {} : { context: options.context }),
  ...(options.related === undefined ? {} : { related: options.related }),
  ...(options.fix === undefined ? {} : { fix: options.fix }),
});

export const error = (message: string, at: Span, options: Omit<DiagnosticOptions, "severity"> = {}): Diagnostic =>
  diagnostic(message, at, { ...options, severity: "error" });

export const warning = (message: string, at: Span, options: Omit<DiagnosticOptions, "severity"> = {}): Diagnostic =>
  diagnostic(message, at, { ...options, severity: "warning" });

/** Attaches a document to a span-only diagnostic exactly once. */
export const withDocument = (value: Diagnostic, uri: string): Diagnostic => {
  if (value.origin ?? value.location) return value;
  return {
    ...value,
    origin: { uri, span: value.span },
    location: { uri, span: value.span },
  };
};

/** Where this diagnostic should be read, as seen from `here`. */
export const site = (value: Diagnostic, here: string): SourceLocation =>
  value.location ?? value.origin ?? { uri: here, span: value.span };

/** Moves a dependency's diagnostic onto the import that pulled it in. */
export const route = (value: Diagnostic, location: SourceLocation): Diagnostic => ({
  ...value,
  location,
  span: location.span,
  related: [...(value.related ?? []), {
    location: value.origin ?? location,
    message: "Reported here",
  }],
});

export const render = (value: Diagnostic, input: Source | string): string => {
  const source = typeof input === "string" ? { text: input, lineStarts: undefined } : input;
  const starts = source.lineStarts ?? lineStartsOf(source.text);
  const { line, character } = positionAt(starts, value.span.start);
  const lineStart = starts[line] ?? 0;
  const lineEnd = nextLine(starts, source.text, line);
  const text = source.text.slice(lineStart, lineEnd);
  const length = Math.max(1, Math.min(value.span.end - value.span.start, Math.max(1, text.length - character)));
  const context = value.context?.length ? `\n  ${value.context.join(" > ")}` : "";
  const label = value.severity === "error" ? "error" : value.severity;
  return [
    `${line + 1}:${character + 1} ${label}: ${value.message}${context}`,
    text,
    `${" ".repeat(character)}${"^".repeat(length)}`,
  ].join("\n");
};

const lineStartsOf = (text: string): readonly number[] => {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 13) {
      if (text.charCodeAt(index + 1) === 10) index++;
      starts.push(index + 1);
    } else if (code === 10) {
      starts.push(index + 1);
    }
  }
  return starts;
};

const nextLine = (starts: readonly number[], text: string, line: number): number => {
  const start = starts[line + 1];
  if (start === undefined) return text.length;
  return text[start - 1] === "\n" && text[start - 2] === "\r" ? start - 2 : text[start - 1] === "\n" ? start - 1 : start - 1;
};

export const sortDiagnostics = (values: readonly Diagnostic[]): readonly Diagnostic[] =>
  [...values].sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);
