import { readFileSync } from "node:fs";
import { type Binding, type Checker } from "../../src/check/index.ts";
import { compileGrammar } from "../../src/grammar/compile.ts";
import { parseGrammar } from "../../src/grammar/parse.ts";
import { defineLanguage } from "../../src/language.ts";
import { runtimeModule } from "../../src/runtime/index.ts";
import type { Span, Text } from "../../src/source.ts";
import { source, synth, ts } from "../../src/ts/index.ts";
import type { File } from "./machine.ast.ts";

const sourceText = readFileSync(new URL("./machine.parl", import.meta.url), "utf8");
const parsed = parseGrammar(sourceText, "machine.parl");
if (!parsed.ok) throw new Error(parsed.diagnostics.map((entry) => entry.message).join("\n"));
const grammar = compileGrammar<File>(parsed.file, "machine.parl");
if (!grammar.valid) throw new Error(grammar.diagnostics.map((entry) => entry.message).join("\n"));

type Checked =
  | { readonly kind: "machine"; readonly name: string }
  | { readonly kind: "state"; readonly name: string; readonly final: boolean }
  | { readonly kind: "event"; readonly name: string };

type EventIR = { readonly name: Text; readonly binding: Binding<Checked> };
type TransitionIR = {
  readonly event: EventIR;
  readonly target: StateIR;
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
};

const display = (value: Checked): string =>
  value.kind === "machine" ? `machine ${value.name}` : `${value.kind} ${value.name}`;

const check = (file: File, cx: Checker<Checked>): MachineModule => {
  const machineType: Checked = { kind: "machine", name: file.name.text };
  const machine = cx.declare(file.name.text, file.name.span, "namespace", machineType);
  cx.bind(machine);
  cx.typed(file.name, machineType);

  const names = new Set<string>();
  const events: EventIR[] = [];
  const eventMap = new Map<string, EventIR>();
  for (const event of file.events) {
    if (names.has(event.name.text)) {
      cx.error(`Duplicate name ${JSON.stringify(event.name.text)}`, event.name);
      continue;
    }
    names.add(event.name.text);
    const type: Checked = { kind: "event", name: event.name.text };
    const binding = cx.declare(event.name.text, event.name.span, "event", type, { detail: "event" });
    cx.bind(binding);
    cx.typed(event.name, type);
    const value: EventIR = { name: event.name, binding };
    events.push(value);
    eventMap.set(event.name.text, value);
  }

  const states: StateIR[] = [];
  const stateMap = new Map<string, StateIR>();
  let initial: StateIR | null = null;
  for (const declaration of file.states) {
    if (names.has(declaration.name.text)) {
      cx.error(`Duplicate name ${JSON.stringify(declaration.name.text)}`, declaration.name);
      continue;
    }
    names.add(declaration.name.text);
    const type: Checked = { kind: "state", name: declaration.name.text, final: declaration.kind === "final" };
    const binding = cx.declare(declaration.name.text, declaration.name.span, "class", type, { detail: "state" });
    cx.bind(binding);
    cx.typed(declaration.name, type);
    const value: StateIR = { name: declaration.name, final: declaration.kind === "final", transitions: [], binding };
    states.push(value);
    stateMap.set(declaration.name.text, value);
    if (declaration.kind === "initial") {
      if (initial) cx.error("A machine has only one initial state", declaration.name);
      else initial = value;
    }
  }
  if (!initial) cx.error("A machine needs an initial state", file.name);

  const usedEvents = new Set<string>();
  for (const declaration of file.states) {
    const state = stateMap.get(declaration.name.text);
    if (!state) continue;
    const seen = new Set<string>();
    const transitions: TransitionIR[] = [];
    const transitionsOf = declaration.kind === "final" ? [] : declaration.transitions;
    for (const transition of transitionsOf) {
      const key = `${state.name.text}:${transition.event.text}`;
      void key;
      if (seen.has(transition.event.text)) {
        cx.error(
          `State ${state.name.text} already handles ${JSON.stringify(transition.event.text)}`,
          transition.event,
        );
        continue;
      }
      seen.add(transition.event.text);
      const event = eventMap.get(transition.event.text);
      if (!event) {
        cx.error(`Unknown event ${JSON.stringify(transition.event.text)}`, transition.event);
        continue;
      }
      const target = stateMap.get(transition.target.text);
      if (!target) {
        cx.error(`Unknown state ${JSON.stringify(transition.target.text)}`, transition.target);
        continue;
      }
      usedEvents.add(event.name.text);
      cx.reference(event.binding, transition.event);
      cx.reference(target.binding, transition.target);
      cx.typed(transition.event, event.binding.type!);
      cx.typed(transition.target, target.binding.type!);
      transitions.push({ event, target, span: transition.span });
    }
    state.transitions.push(...transitions);
    if (!state.final && transitions.length === 0) {
      cx.error(`State ${state.name.text} is not final and has no transitions`, state.name);
    }
  }
  for (const event of events) {
    if (!usedEvents.has(event.name.text)) {
      cx.warn(`Event ${event.name.text} is never used`, event.name);
    }
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
    for (const state of states) {
      if (!reachable.has(state)) cx.error(`State ${state.name.text} is unreachable`, state.name);
    }
  }

  return { name: file.name, events, states, initial: initial ?? states[0]! };
};

const types = (module: MachineModule) => {
  const prefix = module.name.text;
  return ts`export type ${synth(`${prefix}State`, module.name.span)} = ${
    module.states.map((state, index) => ts`${index ? " | " : ""}"${source(state.name)}"`)
  };
export type ${synth(`${prefix}Event`, module.name.span)} = ${
    module.events.map((event, index) => ts`${index ? " | " : ""}"${source(event.name)}"`)
  };
export interface ${source(module.name)} {
  readonly state: ${prefix}State;
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
  typescript: types,
  runtime,
  show: display,
  describe: (binding) => binding.type ? display(binding.type) : undefined,
});
