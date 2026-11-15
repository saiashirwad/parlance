import type { Span, Text } from "../source.ts";
import type { Checker } from "./checker.ts";
import type { Binding, DefinitionKind } from "./facts.ts";

/**
 * Declarative name binding. A grammar's `bind { ... }` block (docs/02-grammar.md) compiles to a
 * `BindSpec`; `bind` walks a parsed tree with it and feeds the checker's facts: definitions,
 * references, hover types, scope extents, and duplicate and unknown-name diagnostics.
 */
export type BindDef = {
  readonly node: string;
  readonly field: string;
  readonly kind: DefinitionKind;
  /** The namespace `ref` lines name and the noun in duplicate messages; defaults to `kind`. */
  readonly label: string;
  /** An explicit `"label"`, used as the binding's detail. */
  readonly detail: string | null;
  /** `in tag`: a member of the nearest enclosing `tag` node, not a lexical name. */
  readonly owner: string | null;
  /** `in tag.field`: visible only inside that field of the nearest `tag` node (itself included). */
  readonly within: { readonly node: string; readonly field: string } | null;
  /** `after`: visible from the end of its node to the end of its scope. */
  readonly after: boolean;
  readonly exported: boolean;
};
export type BindRef = { readonly node: string; readonly field: string; readonly label: string; readonly noun: string };
export type BindUnique = {
  readonly node: string;
  readonly field: string;
  /** Repeats are counted per nearest enclosing node of one of these kinds. */
  readonly owners: readonly string[];
  readonly message: string | null;
};
export type BindBuiltin = {
  readonly name: string;
  readonly kind: DefinitionKind;
  readonly label: string;
  readonly detail: string | null;
};
export type BindSpec = {
  readonly defs: readonly BindDef[];
  readonly refs: readonly BindRef[];
  readonly uniques: readonly BindUnique[];
  readonly builtins: readonly BindBuiltin[];
  /** Node kinds (`tag`) and fields (`tag.field`) that open a lexical scope. */
  readonly scopes: ReadonlySet<string>;
  readonly imports: readonly { readonly node: string; readonly field: string }[];
};

type Node = { readonly kind: string; readonly span: Span; readonly [field: string]: unknown };
type Entry<T> = {
  binding: Binding<T>;
  readonly index: number;
  readonly node: Node;
  readonly def: BindDef;
  /** The earliest offset a reference may sit at; 0 unless the definition is `after`. */
  readonly from: number;
  readonly sites: Text[];
};
type Scope<T> = { readonly parent: Scope<T> | null; readonly names: Map<string, Entry<T>>; readonly span: Span };
type Frame<T> = { readonly node: Node; readonly scope: Scope<T> };

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as Node).kind === "string";
const isText = (value: unknown): value is Text =>
  typeof value === "object" && value !== null && typeof (value as Text).text === "string";
/** The names a field holds: one text, a list of texts, or nothing. */
const allTexts = (value: unknown): readonly Text[] => (Array.isArray(value) ? value : [value]).filter(isText);
const isMissingName = (name: Text): boolean => name.text === "" || name.missing === true;
/** Present names only: a missing name, from a repaired parse, was already reported. */
const texts = (value: unknown): readonly Text[] => allTexts(value).filter((name) => !isMissingName(name));
const extent = (value: unknown, fallback: Span): Span => {
  const list = (Array.isArray(value) ? value : [value]).filter((entry) =>
    typeof entry === "object" && entry !== null && "span" in entry
  ) as { span: Span }[];
  if (list.length === 0) return fallback;
  return { start: list[0]!.span.start, end: list[list.length - 1]!.span.end };
};

const byNode = <E extends { readonly node: string }>(entries: readonly E[]): Map<string, E[]> => {
  const map = new Map<string, E[]>();
  for (const entry of entries) {
    const list = map.get(entry.node);
    if (list) list.push(entry);
    else map.set(entry.node, [entry]);
  }
  return map;
};

/**
 * Walks a tree, tracking the lexical scope: `scope tag` nodes and `scope tag.field` fields open one,
 * as does any field a `def ... in tag.field` names. Both passes walk the same way, so a scope created
 * lazily in the declare pass is the one the resolve pass enters.
 */
class Walker<T> {
  readonly root: Scope<T>;
  readonly #spec: BindSpec;
  readonly #nodeScopes = new Map<object, Scope<T>>();
  readonly #fieldScopes = new Map<object, Map<string, Scope<T>>>();
  readonly #fieldScoped: ReadonlySet<string>;
  readonly onScope: (scope: Scope<T>) => void;
  scope: Scope<T>;
  readonly frames: Frame<T>[] = [];

  constructor(spec: BindSpec, span: Span, onScope: (scope: Scope<T>) => void) {
    this.#spec = spec;
    this.onScope = onScope;
    this.root = { parent: null, names: new Map(), span };
    this.scope = this.root;
    const fieldScoped = new Set<string>();
    for (const key of spec.scopes) if (key.includes(".")) fieldScoped.add(key);
    for (const def of spec.defs) if (def.within) fieldScoped.add(`${def.within.node}.${def.within.field}`);
    this.#fieldScoped = fieldScoped;
  }

  #make(parent: Scope<T>, span: Span): Scope<T> {
    const scope = { parent, names: new Map(), span };
    this.onScope(scope);
    return scope;
  }

  /** The scope a field of `frame.node` opens, created on first use. */
  fieldScope(frame: Frame<T>, field: string): Scope<T> {
    let fields = this.#fieldScopes.get(frame.node);
    if (!fields) this.#fieldScopes.set(frame.node, fields = new Map());
    let scope = fields.get(field);
    if (!scope) {
      scope = this.#make(frame.scope, extent(frame.node[field], { start: frame.node.span.end, end: frame.node.span.end }));
      fields.set(field, scope);
    }
    return scope;
  }

  walk(value: unknown, visit: (node: Node) => void, leave?: (node: Node) => void): void {
    if (Array.isArray(value)) {
      for (const entry of value) this.walk(entry, visit, leave);
      return;
    }
    if (!isNode(value)) return;
    const outer = this.scope;
    if (this.#spec.scopes.has(value.kind)) {
      let scope = this.#nodeScopes.get(value);
      if (!scope) this.#nodeScopes.set(value, scope = this.#make(outer, value.span));
      this.scope = scope;
    }
    visit(value);
    const frame = { node: value, scope: this.scope };
    this.frames.push(frame);
    for (const key in value) {
      const child = value[key];
      if (key === "span" || typeof child !== "object" || child === null) continue;
      this.scope = this.#fieldScoped.has(`${value.kind}.${key}`) ? this.fieldScope(frame, key) : frame.scope;
      this.walk(child, visit, leave);
    }
    this.frames.pop();
    this.scope = outer;
    leave?.(value);
  }

  nearest(...kinds: readonly string[]): Frame<T> | undefined {
    return this.frames.findLast((frame) => kinds.includes(frame.node.kind));
  }
}

export type BindOptions<T> = {
  /** The type a definition gets when it is declared. Types known only later go through `define`. */
  readonly type?: (node: any) => T | undefined;
  /** The type of a builtin name, recorded at each reference to it. */
  readonly builtin?: (name: string, label: string) => T | undefined;
  /**
   * The escape hatch for names `bind` does not own, tried before reporting an unknown name.
   * Defaults to `cx.resolve`, so bindings a checker put in scope by hand (imports, say) resolve.
   * `bind` records the reference; at the top level a name the fallback finds is also a duplicate.
   */
  readonly resolve?: (name: string, site: Text) => Binding<T> | undefined;
};

export type Bound<T> = {
  /** The binding a defining node introduced; undefined for a rejected duplicate or a missing name. */
  readonly binding: (node: object) => Binding<T> | undefined;
  /** The binding a reference site resolved to, through `bind` or the `resolve` fallback. */
  readonly resolved: (site: Text) => Binding<T> | undefined;
  /** The defining node a reference site resolved to. */
  readonly target: <N = unknown>(site: Text) => N | undefined;
  /** The builtin name a reference site resolved to. */
  readonly builtin: (site: Text) => string | undefined;
  /** Member definitions (`def ... in tag`) owned by `node`, in source order, without duplicates. */
  readonly members: <N = unknown>(node: object) => readonly N[];
  /** True when some reference resolved to `binding`. */
  readonly used: (binding: Binding<T>) => boolean;
  /** True when a `unique` line rejected this site as a repeat. */
  readonly duplicate: (site: Text) => boolean;
  /**
   * Settles the type of the binding `node` introduced, once the checker knows it: the definition,
   * its name, and every reference site are typed. Returns the updated binding.
   */
  readonly define: (node: object, type: T) => Binding<T> | undefined;
  /** Bindings from `export def` lines, with their settled types. */
  readonly exports: readonly Binding<T>[];
};

const quote = (text: string): string => JSON.stringify(text);

export const bind = <T>(root: unknown, cx: Checker<T>, spec: BindSpec, options: BindOptions<T> = {}): Bound<T> => {
  const typeOf = options.type ?? (() => undefined);
  const fallback = options.resolve ?? ((name: string) => cx.resolve(name, undefined));
  const defs = byNode(spec.defs);
  const refs = byNode(spec.refs);
  const uniques = byNode(spec.uniques);
  const builtins = new Map(spec.builtins.map((entry) => [entry.name, entry]));
  const entries = new Map<object, Entry<T>>();
  const sites = new Map<Text, Entry<T>>();
  const foreign = new Map<Text, Binding<T>>();
  const builtinSites = new Map<Text, string>();
  const owned = new Map<object, { readonly names: Map<string, Entry<T>>; readonly list: Entry<T>[] }>();
  const used = new Set<number>();
  const repeats = new Set<Text>();
  const exported: Entry<T>[] = [];
  const own = new Set<number>();
  /** Nodes whose definition was a duplicate; like a skipped declaration, their subtree is not resolved. */
  const rejected = new Set<object>();
  let skipping = 0;
  const scopes: Scope<T>[] = [];
  const walker = new Walker<T>(spec, { start: 0, end: cx.source.length }, (scope) => scopes.push(scope));

  walker.walk(root, (node) => {
    for (const def of defs.get(node.kind) ?? []) {
      let names: Map<string, Entry<T>>;
      let members: Entry<T>[] | null = null;
      let detail = def.detail;
      let scope: Scope<T> | null = null;
      if (def.owner !== null) {
        const owner = walker.nearest(def.owner);
        if (!owner) continue;
        let group = owned.get(owner.node);
        if (!group) owned.set(owner.node, group = { names: new Map(), list: [] });
        names = group.names;
        members = group.list;
        detail = allTexts(owner.node["name"])[0]?.text ?? detail;
      } else if (def.within !== null) {
        const frame = node.kind === def.within.node
          ? { node, scope: walker.scope }
          : walker.nearest(def.within.node);
        if (!frame) continue;
        scope = walker.fieldScope(frame, def.within.field);
        names = scope.names;
      } else {
        scope = walker.scope;
        names = scope.names;
      }
      for (const name of allTexts(node[def.field])) {
        const top = scope === walker.root;
        if (isMissingName(name)) {
          // Like `cx.declare`, a missing name gets an unrecorded binding and is never in scope.
          const binding = cx.declare("", name.span, def.kind, typeOf(node), detail === null ? {} : { detail });
          const entry: Entry<T> = { binding, index: -1, node, def, from: 0, sites: [] };
          entries.set(node, entry);
          members?.push(entry);
          continue;
        }
        if (names.has(name.text) || (top && fallback(name.text, name) !== undefined)) {
          cx.error(`Duplicate ${def.owner === null ? "name" : def.label} ${quote(name.text)}`, name);
          rejected.add(node);
          continue;
        }
        const type = typeOf(node);
        const binding = cx.declare(name.text, name.span, def.kind, type, detail === null ? {} : { detail });
        // Top-level hoisted names are also put in the checker's scope, so `cx.resolve` sees them.
        if (top && !def.after) cx.bind(binding);
        if (type !== undefined) cx.typed(name, type);
        const from = def.after ? node.span.end : 0;
        const entry: Entry<T> = { binding, index: cx.facts.definitions.length - 1, node, def, from, sites: [] };
        names.set(name.text, entry);
        members?.push(entry);
        own.add(binding.id);
        entries.set(node, entry);
        if (def.exported) exported.push(entry);
        if (scope !== null) cx.facts.scopes.push({ id: binding.id, span: { start: Math.max(from, scope.span.start), end: scope.span.end } });
      }
    }
  });

  const lookup = (ref: BindRef, site: Text): Entry<T> | undefined => {
    for (let at: Scope<T> | null = walker.scope; at; at = at.parent) {
      const entry = at.names.get(site.text);
      if (entry && entry.def.label === ref.label && entry.from <= site.span.start) return entry;
    }
    return undefined;
  };

  const seen = new Map<object, Set<string>>();
  walker.walk(root, (node) => {
    if (rejected.has(node)) skipping++;
    if (skipping > 0) return;
    // After a repeat, a missing name, or an unknown name, later references in the same node are not
    // reported: `on nope -> Z` says only that `nope` is unknown, and a repaired parse does not cascade.
    let quiet = false;
    for (const unique of uniques.get(node.kind) ?? []) {
      const owner = walker.nearest(...unique.owners);
      if (!owner) continue;
      let names = seen.get(owner.node);
      if (!names) seen.set(owner.node, names = new Set());
      for (const site of texts(node[unique.field])) {
        if (!names.has(site.text)) {
          names.add(site.text);
          continue;
        }
        repeats.add(site);
        quiet = true;
        const ownerName = allTexts(owner.node["name"])[0]?.text ?? owner.node.kind;
        const message = unique.message === null
          ? `Duplicate ${quote(site.text)} in ${owner.node.kind} ${ownerName}`
          : unique.message.replaceAll("{owner}", ownerName).replaceAll("{name}", quote(site.text));
        cx.error(message, site);
      }
    }
    for (const ref of refs.get(node.kind) ?? []) {
      for (const site of allTexts(node[ref.field])) {
        if (isMissingName(site)) {
          quiet = true;
          continue;
        }
        const found = lookup(ref, site);
        if (found) {
          cx.reference(found.binding, site);
          if (found.binding.type !== undefined) cx.typed(site, found.binding.type);
          used.add(found.binding.id);
          found.sites.push(site);
          sites.set(site, found);
          continue;
        }
        const manual = fallback(site.text, site);
        if (manual && !own.has(manual.id)) {
          cx.reference(manual, site);
          if (manual.type !== undefined) cx.typed(site, manual.type);
          used.add(manual.id);
          foreign.set(site, manual);
          continue;
        }
        const builtin = builtins.get(site.text);
        if (builtin && builtin.label === ref.label) {
          const type = options.builtin?.(builtin.name, builtin.label);
          if (type !== undefined) cx.typed(site, type);
          builtinSites.set(site, builtin.name);
          continue;
        }
        if (!quiet) cx.error(`Unknown ${ref.noun} ${quote(site.text)}`, site);
        quiet = true;
      }
    }
  }, (node) => {
    if (rejected.has(node)) skipping--;
  });

  return {
    binding: (node) => entries.get(node)?.binding,
    resolved: (site) => sites.get(site)?.binding ?? foreign.get(site),
    target: <N>(site: Text) => sites.get(site)?.node as N | undefined,
    builtin: (site) => builtinSites.get(site),
    members: <N>(node: object) => (owned.get(node)?.list ?? []).map((entry) => entry.node as N),
    used: (binding) => used.has(binding.id),
    duplicate: (site) => repeats.has(site),
    define: (node, type) => {
      const entry = entries.get(node);
      if (!entry) return undefined;
      entry.binding = { ...entry.binding, type };
      if (entry.index < 0) return entry.binding;
      cx.facts.definitions[entry.index] = entry.binding;
      cx.typed(entry.binding.span, type);
      for (const site of entry.sites) cx.typed(site, type);
      return entry.binding;
    },
    get exports() {
      return exported.map((entry) => entry.binding);
    },
  };
};

/** The import specifiers `import tag.field` lines name, in source order. */
export const boundImports = (root: unknown, spec: BindSpec): Text[] => {
  const found: Text[] = [];
  if (spec.imports.length === 0) return found;
  const imports = byNode(spec.imports);
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (!isNode(value)) return;
    for (const entry of imports.get(value.kind) ?? []) found.push(...texts(value[entry.field]));
    for (const key in value) {
      const child = value[key];
      if (key !== "span" && typeof child === "object" && child !== null) visit(child);
    }
  };
  visit(root);
  return found;
};
