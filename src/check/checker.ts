import {
  type Diagnostic,
  type DiagnosticOptions,
  diagnostic,
  type Related,
} from "../diagnostic.ts";
import type { ErrorNode, Span } from "../source.ts";
import {
  type Binding,
  type DefinitionKind,
  type Facts,
  facts as emptyFacts,
  type Reference,
  type Token,
  type Typed,
} from "./facts.ts";

export type Spanned = { readonly span: Span };

export const at = (value: Span | Spanned): Span => "start" in value ? value : value.span;

/** A zero-width error node a repair parse left where a node is missing. */
export const isError = (value: object): value is ErrorNode => (value as { readonly kind?: unknown }).kind === "error";

/** An error node or a missing token (`{ text: "", missing: true }`): syntax the parser already reported. */
export const isMissing = (value: Span | Spanned): boolean =>
  isError(value) || (value as { readonly missing?: unknown }).missing === true;

/** One analyzed dependency, as seen by a checker. */
export type Dependency<Type = unknown> = {
  /** The specifier exactly as written in the importing file. */
  readonly specifier: string;
  /** The specifier's span in the importing file. */
  readonly span: Span;
  /** The resolved document URI. */
  readonly uri: string;
  /** Exported bindings, already carrying their defining `uri`. */
  readonly exports: ReadonlyMap<string, Binding<Type>>;
  /** The dependency's checked IR, for languages that need more than a binding. */
  readonly module: unknown;
};

/** Read-only dependency view. A language resolves imported names without graph internals. */
export type Dependencies<Type = unknown> = {
  readonly all: readonly Dependency<Type>[];
  readonly of: (specifier: string) => Dependency<Type> | undefined;
};

class AbortCheck extends Error {
  constructor() {
    super("check aborted");
    this.name = "AbortCheck";
  }
}

const abort = new AbortCheck();

export type CheckOptions = DiagnosticOptions & { readonly related?: readonly Related[] };

/**
 * Mutable analysis state for one document. Plain functions receive a checker and call it.
 * A binding is recorded once with `declare` and put in scope with `bind`.
 */
export class Checker<T = unknown> {
  readonly uri: string;
  readonly source: string;
  readonly facts: Facts<T>;
  readonly dependencies: Dependencies<T>;
  readonly #scopes: Map<string, Binding<T>>[] = [new Map()];
  /** Parallel to `#scopes`: bindings bound there that still need a visibility extent. */
  readonly #bound: Binding<T>[][] = [[]];
  readonly #extended = new Set<number>();
  readonly #imported = new Map<string, Binding<T>>();
  #nextBinding = 1;
  #references = new Set<string>();

  constructor(
    uri: string,
    source: string,
    tokens: readonly Token[] = [],
    diagnostics: readonly Diagnostic[] = [],
    dependencies: readonly Dependency<T>[] = [],
  ) {
    this.uri = uri;
    this.source = source;
    this.facts = emptyFacts<T>([...diagnostics], [...tokens], uri);
    this.dependencies = {
      all: dependencies,
      of: (specifier) => dependencies.find((dependency) => dependency.specifier === specifier),
    };
  }

  diagnostic(message: string, value: Span | Spanned, options: CheckOptions = {}): Diagnostic {
    return diagnostic(message, at(value), options);
  }

  /** A guard for error nodes; see `isError`. */
  isError(value: object): value is ErrorNode {
    return isError(value);
  }

  /** True for an error node or a missing token; see `isMissing`. */
  isMissing(value: Span | Spanned): boolean {
    return isMissing(value);
  }

  /**
   * Reports at `value`. A report at an error node or a missing token is dropped:
   * the parser already reported it, and a second message would only cascade.
   */
  error(message: string, value: Span | Spanned, options: CheckOptions = {}): void {
    if (isMissing(value)) return;
    this.facts.diagnostics.push(diagnostic(message, at(value), { ...options, severity: "error" }));
  }

  warn(message: string, value: Span | Spanned, options: CheckOptions = {}): void {
    if (isMissing(value)) return;
    this.facts.diagnostics.push(diagnostic(message, at(value), { ...options, severity: "warning" }));
  }

  info(message: string, value: Span | Spanned, options: CheckOptions = {}): void {
    if (isMissing(value)) return;
    this.facts.diagnostics.push(diagnostic(message, at(value), { ...options, severity: "info" }));
  }

  /**
   * Runs `body` in a child lexical scope, restoring the parent even if it throws. Pass the node's
   * span when you have it: completion uses it as the extent where the scope's names are visible.
   * Without it the extent is inferred from the facts recorded inside `body`.
   */
  scope<A>(body: () => A): A;
  scope<A>(extent: Span | Spanned, body: () => A): A;
  scope<A>(first: Span | Spanned | (() => A), second?: () => A): A {
    const body = typeof first === "function" ? first : second!;
    const given = typeof first === "function" ? undefined : at(first);
    const { definitions, references, types } = this.facts;
    const before = [definitions.length, references.length, types.length] as const;
    this.#scopes.push(new Map());
    this.#bound.push([]);
    try {
      return body();
    } finally {
      this.#scopes.pop();
      const bound = this.#bound.pop()!;
      if (bound.length > 0) {
        let start = given?.start ?? Infinity;
        let end = given?.end ?? -1;
        if (given === undefined) {
          const widen = (span: Span): void => {
            if (span.start < start) start = span.start;
            if (span.end > end) end = span.end;
          };
          for (let i = before[0]; i < definitions.length; i++) widen(definitions[i]!.span);
          for (let i = before[1]; i < references.length; i++) widen(references[i]!.span);
          for (let i = before[2]; i < types.length; i++) widen(types[i]!.span);
        }
        if (end >= 0) this.#extend(bound, { start, end });
      }
    }
  }

  /** Records the extent where `id` is visible (a `bind` block records its own). */
  visible(id: number, span: Span): void {
    this.#extended.add(id);
    this.facts.scopes.push({ id, span });
  }

  /** Records extents for names bound in the file scope. Called once, after checking. */
  seal(): void {
    this.#extend(this.#bound[0]!, { start: 0, end: this.source.length });
    this.#bound[0]!.length = 0;
  }

  #extend(bound: readonly Binding<T>[], span: Span): void {
    for (const binding of bound) {
      if (this.#extended.has(binding.id)) continue;
      this.#extended.add(binding.id);
      this.facts.scopes.push({ id: binding.id, span });
    }
  }

  /** Adds a binding to the current scope. A missing (empty) name is never bound. */
  bind(binding: Binding<T>): Binding<T> {
    if (binding.name === "") return binding;
    this.#scopes[this.#scopes.length - 1]!.set(binding.name, binding);
    this.#bound[this.#bound.length - 1]!.push(binding);
    return binding;
  }

  /** Adds several bindings to the current scope. */
  bindAll(bindings: Iterable<Binding<T>>): void {
    for (const binding of bindings) this.bind(binding);
  }

  /**
   * Records a definition. The definition is not in scope until `bind`.
   * A missing (empty) name, from a repaired parse, gets a binding that is not recorded.
   */
  declare(
    name: string,
    value: Span | Spanned,
    kind: DefinitionKind,
    type?: T,
    extra: { readonly uri?: string; readonly detail?: string } = {},
  ): Binding<T> {
    const binding: Binding<T> = {
      id: this.#nextBinding++,
      name,
      kind,
      span: at(value),
      ...(type === undefined ? {} : { type }),
      ...(extra.uri === undefined ? {} : { uri: extra.uri }),
      ...(extra.detail === undefined ? {} : { detail: extra.detail }),
    };
    if (name !== "") this.facts.definitions.push(binding);
    return binding;
  }

  /** Looks up a name and records a reference when found. A missing (empty) name finds nothing. */
  resolve(name: string, value: Span | Spanned | undefined): Binding<T> | undefined {
    if (name === "") return undefined;
    let found: Binding<T> | undefined;
    for (let index = this.#scopes.length - 1; index >= 0; index--) {
      found = this.#scopes[index]!.get(name);
      if (found) break;
    }
    if (found && value !== undefined) this.reference(found, value);
    return found;
  }

  /**
   * Registers a binding defined in another document as a local definition with a fresh id.
   * References to the returned alias navigate to `uri`.
   */
  alias(binding: Binding<T>, uri: string, value?: Span | Spanned): Binding<T> {
    const key = `${uri}:${binding.span.start}:${binding.span.end}`;
    let local = this.#imported.get(key);
    if (!local) {
      local = { ...binding, id: this.#nextBinding++, uri };
      this.facts.definitions.push(local);
      this.bind(local);
      this.#imported.set(key, local);
    }
    if (value !== undefined) this.reference(local, value);
    return local;
  }

  /**
   * Binds an exported name from the first dependency that provides it. The returned binding keeps
   * the defining document's `uri` and span but receives a local id so references stay unambiguous.
   */
  imported(name: string, value?: Span | Spanned): Binding<T> | undefined {
    for (const dependency of this.dependencies.all) {
      const binding = dependency.exports.get(name);
      if (!binding) continue;
      return this.alias(binding, binding.uri ?? dependency.uri, value);
    }
    return undefined;
  }

  reference(binding: { readonly id: number; readonly uri?: string }, value: Span | Spanned): void {
    if (isMissing(value)) return;
    const span = at(value);
    const key = `${binding.id}:${span.start}:${span.end}`;
    if (this.#references.has(key)) return;
    this.#references.add(key);
    this.facts.references.push({ id: binding.id, span });
  }

  typed(value: Span | Spanned, type: T): void {
    this.facts.types.push({ span: at(value), type } satisfies Typed<T>);
  }

  /** Records a binding's type at its definition site as well. */
  define(binding: Binding<T>, value: Span | Spanned, type: T): Binding<T> {
    if (binding.name === "") return { ...binding, type };
    this.typed(value, type);
    this.facts.definitions.push({ ...binding, type });
    return { ...binding, type };
  }

  /** Builds a diagnostic at `value` and aborts the current unit. `check` catches it. */
  abort(message: string, value: Span | Spanned, options: CheckOptions = {}): never {
    this.error(message, value, options);
    throw abort;
  }

  /** Runs one recoverable unit. A thrown `abort` produces the diagnostic and `undefined`. */
  check<A>(body: () => A): A | undefined;
  check<A>(value: Span | Spanned, body: () => A): A | undefined;
  check<A>(first: (() => A) | Span | Spanned, second?: () => A): A | undefined {
    const body = typeof first === "function" ? first : second!;
    try {
      return body();
    } catch (error) {
      if (error === abort) return undefined;
      throw error;
    }
  }

  /** Runs a unit that must not fail; an abort becomes the fallback instead of propagating. */
  attempt<A>(body: () => A): A | undefined {
    return this.check(body);
  }

  text(value: Span | Spanned): string {
    const span = at(value);
    return this.source.slice(span.start, span.end);
  }
}
