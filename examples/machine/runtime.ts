export type RuntimeMachine = {
  readonly name: string;
  readonly initial: string;
  readonly transitions: readonly {
    readonly state: string;
    readonly event: string;
    readonly target: string;
  }[];
};

export const create = (machine: RuntimeMachine) => ({
  start() {
    let state = machine.initial;
    return {
      get state(): string {
        return state;
      },
      send(event: string): string {
        const transition = machine.transitions.find((entry) => entry.state === state && entry.event === event);
        if (!transition) {
          throw new Error(`${machine.name}: no transition from ${state} on ${event}`);
        }
        state = transition.target;
        return state;
      },
    };
  },
});
