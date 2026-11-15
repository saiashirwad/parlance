import { readFileSync } from "node:fs";
import { bind, type Binding, type Checker } from "../../src/check/index.ts";
import { compileGrammar } from "../../src/grammar/compile.ts";
import { parseGrammar } from "../../src/grammar/parse.ts";
import { defineLanguage } from "../../src/language.ts";
import { runtimeModule } from "../../src/runtime/index.ts";
import type { Span, Text } from "../../src/source.ts";
import { source, synth, ts } from "../../src/ts/index.ts";
import type { EventEventNode, Field, File, StateDecl } from "./machine.ast.ts";

const sourceText = readFileSync(new URL("./machine.parl", import.meta.url), "utf8");
const parsed = parseGrammar(sourceText, "machine.parl");
if (!parsed.ok) throw new Error(parsed.diagnostics.map((entry) => entry.message).join("\n"));
const grammar = compileGrammar<File>(parsed.file, "machine.parl");
if (!grammar.valid) throw new Error(grammar.diagnostics.map((entry) => entry.message).join("\n"));

/** The `builtin` names in machine.parl. */
type Scalar = "Int" | "String" | "Bool" | "DateTime";

type Checked =
  | { readonly kind: "machine"; readonly name: string }
  | { readonly kind: "state"; readonly name: string; readonly final: boolean }
  | { readonly kind: "event"; readonly name: string }
  | { readonly kind: "scalar"; readonly name: Scalar };

type PayloadFieldIR = {
  readonly name: Text;
  readonly type: Scalar | null;
  readonly binding: Binding<Checked>;
};
type EventIR = {
  readonly name: Text;
  readonly fields: readonly PayloadFieldIR[];
  readonly binding: Binding<Checked>;
};
type TransitionIR = {
  readonly event: EventIR;
  readonly target: StateIR;
  readonly payload: readonly PayloadFieldIR[];
  readonly span: Span;
};
type StateIR = {
  readonly name: Text;
  readonly final: boolean;
  readonly transitions: TransitionIR[];
  readonly binding: Binding<Checked>;
};

export type MachineModule = {
  readonly name: Text;
  readonly events: readonly EventIR[];
  readonly states: readonly StateIR[];
  readonly initial: StateIR;
  readonly exports: readonly Binding<Checked>[];
};

const display = (value: Checked): string => {
  switch (value.kind) {
    case "machine":
      return `machine ${value.name}`;
    case "scalar":
      return value.name;
    default:
      return `${value.kind} ${value.name}`;
  }
};

const typeOf = (node: File | EventEventNode | StateDecl): Checked => {
  switch (node.kind) {
    case "machine":
    case "event":
      return { kind: node.kind, name: node.name.text };
    default:
      return { kind: "state", name: node.name.text, final: node.kind === "final" };
  }
};

const check = (file: File, cx: Checker<Checked>): MachineModule => {
  const bound = bind<Checked>(file, cx, grammar.bind!, {
    type: (node: File | EventEventNode | Field | StateDecl) => node.kind === "field" ? undefined : typeOf(node),
    builtin: (name) => ({ kind: "scalar", name: name as Scalar }),
  });

  const events = new Map<EventEventNode, EventIR>();
  for (const event of file.events) {
    if (event.kind === "import") continue;
    const binding = bound.binding(event);
    if (!binding) continue;
    const fields: PayloadFieldIR[] = [];
    for (const field of bound.members<Field>(event)) {
      if (field.name.text === "type") {
        cx.error(`Payload field "type" is reserved for the event tag`, field.name);
        continue;
      }
      const scalar = (bound.builtin(field.type) ?? null) as Scalar | null;
      const fieldBinding = scalar === null
        ? bound.binding(field)!
        : bound.define(field, { kind: "scalar", name: scalar })!;
      fields.push({ name: field.name, type: scalar, binding: fieldBinding });
    }
    events.set(event, { name: event.name, fields, binding });
  }

  const states = new Map<StateDecl, StateIR>();
  let initial: StateIR | null = null;
  for (const declaration of file.states) {
    const binding = bound.binding(declaration);
    if (!binding) continue;
    const value: StateIR = { name: declaration.name, final: declaration.kind === "final", transitions: [], binding };
    states.set(declaration, value);
    if (declaration.kind === "initial") {
      if (initial) cx.error("A machine has only one initial state", declaration.name);
      else initial = value;
    }
  }
  if (!initial) cx.error("A machine needs an initial state", file.name);

  const usedEvents = new Set<EventIR>();
  for (const [declaration, state] of states) {
    for (const transition of declaration.kind === "final" ? [] : declaration.transitions) {
      if (bound.duplicate(transition.event)) continue;
      const event = events.get(bound.target<EventEventNode>(transition.event)!);
      const target = states.get(bound.target<StateDecl>(transition.target)!);
      if (!event || !target) continue;
      const binding = transition.binding?.fields ?? [];
      if (event.fields.length > 0 && !transition.binding) {
        cx.error(`Event ${event.name.text} needs a payload binding`, transition.event);
        continue;
      }
      if (event.fields.length === 0 && transition.binding) {
        cx.error(`Event ${event.name.text} has no payload`, transition.binding);
        continue;
      }
      if (event.fields.length !== binding.length) {
        cx.error(
          `Event ${event.name.text} expects ${event.fields.length} payload field(s), found ${binding.length}`,
          transition.binding ?? transition.event,
        );
        continue;
      }
      let mismatched = false;
      for (const [index, name] of binding.entries()) {
        const field = event.fields[index]!;
        if (name.text === field.name.text) {
          cx.reference(field.binding, name);
          if (field.type) cx.typed(name, { kind: "scalar", name: field.type });
          continue;
        }
        cx.error(
          `Event ${event.name.text} payload field ${index + 1} is ${JSON.stringify(field.name.text)}, found ${
            JSON.stringify(name.text)
          }`,
          name,
        );
        mismatched = true;
      }
      if (mismatched) continue;
      usedEvents.add(event);
      state.transitions.push({ event, target, payload: event.fields, span: transition.span });
    }
    if (!state.final && state.transitions.length === 0) {
      cx.error(`State ${state.name.text} is not final and has no transitions`, state.name);
    }
  }
  for (const event of events.values()) {
    if (!usedEvents.has(event)) cx.warn(`Event ${event.name.text} is never used`, event.name);
  }

  if (initial) {
    const reachable = new Set<StateIR>([initial]);
    const queue = [initial];
    while (queue.length) {
      const state = queue.shift()!;
      for (const transition of state.transitions) {
        if (reachable.has(transition.target)) continue;
        reachable.add(transition.target);
        queue.push(transition.target);
      }
    }
    for (const state of states.values()) {
      if (!reachable.has(state)) cx.error(`State ${state.name.text} is unreachable`, state.name);
    }
  }

  const all = [...states.values()];
  return { name: file.name, events: [...events.values()], states: all, initial: initial ?? all[0]!, exports: bound.exports };
};

const scalarTs = (type: Scalar | null): string =>
  type === null ? "unknown" : type === "Int" ? "number" : type === "Bool" ? "boolean" : "string";

const types = (module: MachineModule) => {
  const prefix = module.name.text;
  return ts`export type ${synth(`${prefix}State`, module.name.span)} = ${
    module.states.map((state, index) => ts`${index ? " | " : ""}"${source(state.name)}"`)
  };
export type ${synth(`${prefix}Event`, module.name.span)} = ${
    module.events.map((event, index) =>
      ts`${index ? " | " : ""}{ type: "${source(event.name)}"${
        event.fields.map((field) => ts`; ${source(field.name)}: ${scalarTs(field.type)}`)
      } }`
    )
  };
export interface ${source(module.name)} {
  readonly state: ${prefix}State;
  readonly lastEvent: ${prefix}Event | null;
  send(event: ${prefix}Event): ${prefix}State;
}
export declare function start(): ${source(module.name)};
`;
};

const runtime = (module: MachineModule): string =>
  runtimeModule({
    data: {
      name: module.name.text,
      initial: module.initial.name.text,
      events: module.events.map((event) => ({
        name: event.name.text,
        fields: event.fields.map((field) => ({ name: field.name.text, type: field.type })),
      })),
      transitions: module.states.flatMap((state) =>
        state.transitions.map((transition) => ({
          state: state.name.text,
          event: transition.event.name.text,
          target: transition.target.name.text,
        }))
      ),
    },
    from: new URL("./runtime.ts", import.meta.url).href,
    imports: ["create"],
    factory: "create(data)",
    exports: { start: "runtime.start" },
  });

export const machine = defineLanguage<File, MachineModule, Checked>({
  name: "machine",
  extensions: [".machine"],
  grammar,
  check,
  exports: (module) => module.exports,
  typescript: types,
  runtime,
  show: display,
  describe: (binding) => binding.type ? display(binding.type) : undefined,
});
