export type RuntimeScalar = "Int" | "String" | "Bool" | "DateTime";

export type RuntimeEvent = { readonly type: string; readonly [field: string]: unknown };

export type RuntimeMachine = {
  readonly name: string;
  readonly initial: string;
  readonly events: readonly {
    readonly name: string;
    readonly fields: readonly {
      readonly name: string;
      readonly type: RuntimeScalar | null;
    }[];
  }[];
  readonly transitions: readonly {
    readonly state: string;
    readonly event: string;
    readonly target: string;
  }[];
};

const jsType = (type: RuntimeScalar): "number" | "string" | "boolean" =>
  type === "Int" ? "number" : type === "Bool" ? "boolean" : "string";

export const create = (machine: RuntimeMachine) => ({
  start() {
    let state = machine.initial;
    let lastEvent: RuntimeEvent | null = null;
    return {
      get state(): string {
        return state;
      },
      get lastEvent(): RuntimeEvent | null {
        return lastEvent;
      },
      send(event: RuntimeEvent): string {
        if (event === null || typeof event !== "object" || typeof event.type !== "string") {
          throw new Error(`${machine.name}: send expects an event object like { type: "pay" }`);
        }
        const declaration = machine.events.find((entry) => entry.name === event.type);
        if (!declaration) throw new Error(`${machine.name}: unknown event ${JSON.stringify(event.type)}`);
        const payload: { type: string; [field: string]: unknown } = { type: declaration.name };
        for (const field of declaration.fields) {
          const value = event[field.name];
          if (value === undefined) {
            throw new Error(
              `${machine.name}: event ${JSON.stringify(declaration.name)} needs payload field ${
                JSON.stringify(field.name)
              }`,
            );
          }
          if (field.type !== null && typeof value !== jsType(field.type)) {
            throw new Error(
              `${machine.name}: payload field ${
                JSON.stringify(`${declaration.name}.${field.name}`)
              } must be ${field.type}`,
            );
          }
          payload[field.name] = value;
        }
        const transition = machine.transitions.find(
          (entry) => entry.state === state && entry.event === declaration.name,
        );
        if (!transition) throw new Error(`${machine.name}: no transition from ${state} on ${declaration.name}`);
        state = transition.target;
        lastEvent = payload;
        return state;
      },
    };
  },
});
