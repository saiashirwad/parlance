import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyze } from "../src/language.ts";
import { machine, type MachineModule } from "../examples/machine/machine.ts";

const root = new URL("..", import.meta.url).pathname;
const source = "machine Order {\n  event edit\n  event pay(amount: Int)\n  event cancel\n  initial state Cart {\n    on edit -> Cart\n    on pay(amount) -> Checkout\n    on cancel -> Cancelled\n  }\n  state Checkout {\n    on edit -> Checkout\n    on pay(amount) -> Paid\n    on cancel -> Cancelled\n  }\n  state Paid {\n    on edit -> Paid\n    on cancel -> Cancelled\n  }\n  final state Cancelled {}\n}\n";

const errors = (input: string): string =>
  analyze(machine, input).diagnostics.map((entry) => `${entry.severity}: ${entry.message}`).join("\n");

const spanOf = (input: string, needle: string, occurrence = 0): { start: number; end: number } => {
  let start = -1;
  for (let index = 0; index <= occurrence; index++) start = input.indexOf(needle, start + 1);
  assert.notEqual(start, -1, `missing ${JSON.stringify(needle)}`);
  return { start, end: start + needle.length };
};

const diagnostic = (input: string, pattern: RegExp) => {
  const found = analyze(machine, input, "memory://payload.machine").diagnostics.find((entry) =>
    pattern.test(entry.message)
  );
  assert.ok(found, `missing diagnostic ${pattern}`);
  return found;
};

test("the machine checker accepts a deterministic, reachable machine", () => {
  const analysis = analyze(machine, source, "order.machine");
  assert.deepEqual(analysis.diagnostics, []);
  const module = analysis.ir as MachineModule;
  assert.equal(module.initial.name.text, "Cart");
  assert.deepEqual(module.states.map((state) => state.name.text), ["Cart", "Checkout", "Paid", "Cancelled"]);
  assert.deepEqual(module.events.map((event) => event.name.text), ["edit", "pay", "cancel"]);
  const pay = module.events.find((event) => event.name.text === "pay")!;
  assert.deepEqual(pay.fields.map((field) => [field.name.text, field.type]), [["amount", "Int"]]);
  const cart = module.states[0]!;
  const transition = cart.transitions.find((entry) => entry.event.name.text === "pay")!;
  assert.deepEqual(transition.payload.map((field) => [field.name.text, field.type]), [["amount", "Int"]]);
});

test("payload declarations and transition bindings are checked at their spans", () => {
  const duplicate = "machine M {\n  event pay(amount: Int, amount: Int)\n  initial state A {\n    on pay(amount) -> A\n  }\n}\n";
  assert.deepEqual(diagnostic(duplicate, /Duplicate payload field/).span, spanOf(duplicate, "amount", 1));

  const unknown = "machine M {\n  event pay(amount: Money)\n  initial state A {\n    on pay(amount) -> A\n  }\n}\n";
  assert.deepEqual(diagnostic(unknown, /Unknown payload type "Money"/).span, spanOf(unknown, "Money"));

  const arity = "machine M {\n  event pay(amount: Int, note: String)\n  initial state A {\n    on pay(amount) -> A\n  }\n}\n";
  assert.deepEqual(diagnostic(arity, /expects 2 payload field\(s\), found 1/).span, spanOf(arity, "(amount)"));

  const wrong = "machine M {\n  event pay(amount: Int)\n  initial state A {\n    on pay(total) -> A\n  }\n}\n";
  assert.deepEqual(diagnostic(wrong, /payload field 1 is "amount", found "total"/).span, spanOf(wrong, "total"));

  const payloadless = "machine M {\n  event cancel\n  initial state A {\n    on cancel(amount) -> A\n  }\n}\n";
  assert.deepEqual(diagnostic(payloadless, /Event cancel has no payload/).span, spanOf(payloadless, "(amount)"));

  const unbound = "machine M {\n  event pay(amount: Int)\n  initial state A {\n    on pay -> A\n  }\n}\n";
  assert.deepEqual(diagnostic(unbound, /Event pay needs a payload binding/).span, spanOf(unbound, "pay", 1));
});

test("machine legality errors point at the transition or declaration", () => {
  assert.match(errors("machine M {\n  event e\n  state A {\n    on e -> A\n  }\n}\n"), /needs an initial state/);
  assert.match(
    errors("machine M {\n  event e\n  initial state A {\n    on e -> A\n  }\n  final state B {}\n}\n"),
    /State B is unreachable/,
  );
  assert.match(
    errors("machine M {\n  event e\n  event e\n  initial state A {\n    on e -> A\n  }\n}\n"),
    /Duplicate name/,
  );
  assert.match(
    errors("machine M {\n  event e\n  initial state A {\n    on nope -> A\n  }\n}\n"),
    /Unknown event/,
  );
  assert.match(
    errors("machine M {\n  event e\n  initial state A {\n    on e -> Nope\n  }\n}\n"),
    /Unknown state/,
  );
  assert.match(
    errors(
      "machine M {\n  event e\n  initial state A {\n    on e -> A\n    on e -> A\n  }\n}\n",
    ),
    /already handles/,
  );
  assert.match(
    errors("machine M {\n  event e\n  initial state A {}\n}\n"),
    /not final and has no transitions/,
  );
  assert.match(
    errors(
      "machine M {\n  event e\n  event unused\n  initial state A {\n    on e -> A\n  }\n}\n",
    ),
    /warning: Event unused is never used/,
  );
});

test("machine projects a discriminated state/event union", () => {
  const analysis = analyze(machine, source, "order.machine");
  const doc = machine.typescript!(analysis.ir as MachineModule);
  assert.equal(
    doc.text,
    [
      "export type OrderState = \"Cart\" | \"Checkout\" | \"Paid\" | \"Cancelled\";",
      "export type OrderEvent = { type: \"edit\" } | { type: \"pay\"; amount: number } | { type: \"cancel\" };",
      "export interface Order {",
      "  readonly state: OrderState;",
      "  readonly lastEvent: OrderEvent | null;",
      "  send(event: OrderEvent): OrderState;",
      "}",
      "export declare function start(): Order;",
      "",
    ].join("\n"),
  );
  assert.ok(!doc.text.includes("\\n"));
});

test("the machine runtime transitions and rejects illegal events", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "./examples/register.ts", "examples/typescript/machine.ts"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Paid Checkout Paid pay 50\n");

  const directory = mkdtempSync(join(tmpdir(), "parlance-machine-"));
  try {
    const run = (name: string, body: string) => {
      const consumer = join(directory, name);
      writeFileSync(
        consumer,
        `import { start } from ${JSON.stringify(join(root, "examples/machine/order.machine"))};\n${body}`,
      );
      return spawnSync(process.execPath, ["--import", join(root, "examples/register.ts"), consumer], {
        cwd: root,
        encoding: "utf8",
      });
    };

    const illegal = run(
      "illegal.mjs",
      `const order = start();\n`
        + `order.send({ type: "pay", amount: 1 });\n`
        + `order.send({ type: "cancel" });\n`
        + `order.send({ type: "pay", amount: 1 });\n`,
    );
    assert.notEqual(illegal.status, 0);
    assert.match(illegal.stderr, /no transition from Cancelled on pay/);

    const missing = run("missing.mjs", `start().send({ type: "pay" });\n`);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /event "pay" needs payload field "amount"/);

    const wrongType = run("wrong-type.mjs", `start().send({ type: "pay", amount: "25" });\n`);
    assert.notEqual(wrongType.status, 0);
    assert.match(wrongType.stderr, /payload field "pay.amount" must be Int/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("property: generated connected machines check and keep every transition legal", () => {
  for (let seed = 1; seed <= 30; seed++) {
    let state = seed * 2654435761 >>> 0;
    const random = () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    const count = 3 + Math.floor(random() * 4);
    const names = Array.from({ length: count }, (_, index) => `S${index}`);
    const events = Array.from({ length: 2 + Math.floor(random() * 2) }, (_, index) => `e${index}`);
    const lines = [`machine Generated${seed} {`];
    for (const event of events) lines.push(`  event ${event}`);
    for (let index = 0; index < count; index++) {
      const final = index === count - 1;
      if (index === 0) lines.push(`  initial state ${names[index]} {`);
      else if (final) {
        lines.push(`  final state ${names[index]} {}`);
        continue;
      } else lines.push(`  state ${names[index]} {`);
      for (const [eventIndex, event] of events.entries()) {
        const target = eventIndex === 0 && index < count - 1
          ? names[index + 1]
          : names[Math.min(count - 1, index + Math.floor(random() * (count - index)))];
        lines.push(`    on ${event} -> ${target}`);
      }
      lines.push("  }");
    }
    lines.push("}");
    const program = lines.join("\n") + "\n";
    const analysis = analyze(machine, program, `memory://machine/${seed}`);
    assert.equal(
      analysis.diagnostics.filter((entry) => entry.severity === "error").length,
      0,
      `seed ${seed}\n${program}\n${analysis.diagnostics.map((entry) => entry.message).join("\n")}`,
    );
    const module = analysis.ir as MachineModule;
    for (const current of module.states) {
      for (const transition of current.transitions) {
        assert.ok(module.events.includes(transition.event));
        assert.ok(module.states.includes(transition.target));
      }
    }
  }
});
