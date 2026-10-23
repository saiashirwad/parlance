import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyze } from "../src/language.ts";
import { machine, type MachineModule } from "../examples/machine/machine.ts";

const root = new URL("..", import.meta.url).pathname;
const source = "machine Order {\n  event edit\n  event pay\n  event cancel\n  initial state Cart {\n    on edit -> Cart\n    on pay -> Checkout\n    on cancel -> Cancelled\n  }\n  state Checkout {\n    on edit -> Checkout\n    on pay -> Paid\n    on cancel -> Cancelled\n  }\n  state Paid {\n    on edit -> Paid\n    on cancel -> Cancelled\n  }\n  final state Cancelled {}\n}\n";

const errors = (input: string): string =>
  analyze(machine, input).diagnostics.map((entry) => `${entry.severity}: ${entry.message}`).join("\n");

test("the machine checker accepts a deterministic, reachable machine", () => {
  const analysis = analyze(machine, source, "order.machine");
  assert.deepEqual(analysis.diagnostics, []);
  const module = analysis.ir as MachineModule;
  assert.equal(module.initial.name.text, "Cart");
  assert.deepEqual(module.states.map((state) => state.name.text), ["Cart", "Checkout", "Paid", "Cancelled"]);
  assert.deepEqual(module.events.map((event) => event.name.text), ["edit", "pay", "cancel"]);
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
      "export type OrderEvent = \"edit\" | \"pay\" | \"cancel\";",
      "export interface Order {",
      "  readonly state: OrderState;",
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
  assert.equal(result.stdout, "Cart Checkout Checkout\n");

  const directory = mkdtempSync(join(tmpdir(), "parlance-machine-"));
  try {
    const consumer = join(directory, "illegal.mjs");
    writeFileSync(
      consumer,
      `import { start } from ${JSON.stringify(join(root, "examples/machine/order.machine"))};\n`
        + `const order = start();\n`
        + `order.send("pay");\n`
        + `order.send("cancel");\n`
        + `order.send("pay");\n`,
    );
    const failed = spawnSync(process.execPath, ["--import", join(root, "examples/register.ts"), consumer], {
      cwd: root,
      encoding: "utf8",
    });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /no transition from Cancelled on pay/);
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
