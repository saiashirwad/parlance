import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { analyze } from "../src/language.ts";
import { serveContentMapper } from "../src/ts/host.ts";
import { calc, type CalcModule } from "../examples/calc/calc.ts";

const root = new URL("..", import.meta.url).pathname;

const typeError = (source: string): string =>
  analyze(calc, source).diagnostics.map((entry) => entry.message).join("\n");

test("calc infers literal and arithmetic types", () => {
  const analysis = analyze(calc, "let x = 1 + 2 * 3;\nlet ok = x == 7;\nshow !ok;\n");
  assert.deepEqual(analysis.diagnostics, []);
  assert.equal(analysis.valid, true);
  const module = analysis.ir as CalcModule;
  assert.equal(module.declarations.length, 3);
  const first = module.declarations[0]!;
  assert.equal(first.kind, "let");
  if (first.kind === "let") assert.equal(first.binding.type?.kind, "number");
  assert.equal(module.resultType?.kind, "boolean");
});

test("calc reports type errors at the guest span", () => {
  const source = "let x = 1;\nshow x + true;\n";
  const analysis = analyze(calc, source);
  assert.equal(analysis.valid, false);
  assert.match(analysis.diagnostics.map((entry) => entry.message).join("\n"), /Expected number, found boolean/);
  const span = analysis.diagnostics[0]!.span;
  assert.equal(source.slice(span.start, span.end), "true");
  assert.match(typeError("show nope;"), /Unknown name/);
  assert.match(typeError("let x = 1;\nlet x = 2;"), /Duplicate name/);
  assert.match(typeError("let default = 1;"), /reserved in TypeScript/);
});

test("calc TypeScript surface maps exported names to guest spans", () => {
  const source = "let subtotal = 85 + 40;\nlet freeShipping = subtotal == 125;\nshow subtotal * 2;\n";
  const analysis = analyze(calc, source);
  const doc = calc.typescript!(analysis.ir as CalcModule);
  assert.equal(
    doc.text,
    [
      "export declare const subtotal: number;",
      "export declare const freeShipping: boolean;",
      "declare const _default: number;",
      "export default _default;",
      "",
    ].join("\n"),
  );
  assert.ok(!doc.text.includes("\\n"));
  const at = doc.text.indexOf("freeShipping");
  const mapping = doc.mappings.find(([virtual]) => virtual === at);
  assert.ok(mapping, "name mapping is recorded");
  assert.equal(mapping[4], 0);
  assert.equal(source.slice(mapping[2], mapping[2] + mapping[3]), "freeShipping");
});

test("calc runs through the Node loader", () => {
  const result = spawnSync(process.execPath, ["--import", "./examples/register.ts", "examples/typescript/calc.ts"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "250\n250 125 true\n");
});

test("a runtime error's stack points at the .calc line under --enable-source-maps", () => {
  const directory = mkdtempSync(join(tmpdir(), "parlance-calc-"));
  try {
    const guest = join(directory, "boom.calc");
    writeFileSync(guest, "let a = 1;\nlet b = a + 2;\n\nshow b * 3;\n");
    // calc cannot throw by itself, so a console.log that throws stands in for a failing call.
    const explode = join(directory, "explode.mjs");
    writeFileSync(explode, `console.log = () => { throw new Error("boom"); };\n`);
    const consumer = join(directory, "run.mjs");
    writeFileSync(consumer, `import(${JSON.stringify(guest)}).catch((error) => { console.error(error.stack); });\n`);
    const run = (flag: string) =>
      spawnSync(process.execPath, [flag, "--import", explode, "--import", join(root, "examples/register.ts"), consumer], {
        cwd: root,
        encoding: "utf8",
      });
    const mapped = run("--enable-source-maps");
    assert.match(mapped.stderr, /Error: boom/);
    assert.match(mapped.stderr, /boom\.calc:4:1/, mapped.stderr);
    // Without source maps the same frame is a position in the generated module instead.
    assert.doesNotMatch(run("--no-warnings").stderr, /boom\.calc:4:1/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the Node loader reports guest type errors with positions", () => {
  const directory = mkdtempSync(join(tmpdir(), "parlance-calc-"));
  try {
    const guest = join(directory, "bad.calc");
    writeFileSync(guest, "let x = 1 + true;\n");
    const consumer = join(directory, "run.mjs");
    writeFileSync(consumer, `import(${JSON.stringify(guest)});\n`);
    const result = spawnSync(process.execPath, ["--import", join(root, "examples/register.ts"), consumer], {
      cwd: root,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Expected number, found boolean/);
    assert.match(result.stderr, /bad\.calc: 1:/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const mapper = () => {
  const input = new PassThrough();
  const output = new PassThrough();
  serveContentMapper({ input, output });
  let id = 0;
  let pending = "";
  const waiting = new Map<number, (value: unknown) => void>();
  output.on("data", (chunk: Buffer) => {
    pending += chunk.toString();
    for (let end = pending.indexOf("\r\n\r\n"); end >= 0; end = pending.indexOf("\r\n\r\n")) {
      const length = Number(/Content-Length: (\d+)/.exec(pending.slice(0, end))![1]);
      const message = JSON.parse(pending.slice(end + 4, end + 4 + length));
      pending = pending.slice(end + 4 + length);
      waiting.get(message.id)?.(message.result);
    }
  });
  return (method: string, params: unknown) =>
    new Promise<any>((resolve) => {
      waiting.set(++id, resolve);
      const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      input.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    });
};

test("the content mapper serves a project config and maps a guest file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "parlance-mapper-"));
  try {
    writeFileSync(
      join(directory, "parlance.config.ts"),
      `import { calc } from ${JSON.stringify(join(root, "examples/calc/calc.ts"))};\nexport default { languages: [calc] };\n`,
    );
    const request = mapper();
    const initialize = await request("initialize", {});
    assert.equal(initialize.positionEncoding, "utf-16");
    const opened = await request("openProject", {
      configFileName: join(directory, "tsconfig.json"),
      projectHandle: "test",
      options: { config: "./parlance.config.ts" },
    });
    assert.deepEqual(opened.watchedFiles, []);
    const transformed = await request("transform", {
      fileName: join(directory, "demo.calc"),
      content: "let x = 1 + 2;\nshow x;\n",
      projectHandle: "test",
    });
    assert.match(transformed.text, /export declare const x: number;/);
    assert.equal(transformed.diagnostics.length, 0);
    assert.ok(transformed.mappings.length > 0);
    const broken = await request("transform", {
      fileName: join(directory, "demo.calc"),
      content: "let x = 1 + true;\n",
      projectHandle: "test",
    });
    assert.equal(broken.diagnostics[0].messageText.includes("Expected number"), true);
    const closed = await request("closeProject", { projectHandle: "test" });
    assert.equal(closed, null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

type Value = number | boolean;
type Generated = {
  readonly source: string;
  readonly result: Value;
};

const generated = (seed: number): Generated => {
  let state = seed >>> 0;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const names: { name: string; type: "number" | "boolean" }[] = [];
  const lines: string[] = [];
  const valueOf = new Map<string, Value>();
  let counter = 0;

  const expression = (type: "number" | "boolean", depth: number): { source: string; value: Value } => {
    const choices: (() => { source: string; value: Value; })[] = [];
    if (type === "number") {
      choices.push(() => {
        const value = Math.floor(random() * 90);
        return { source: String(value), value };
      });
    } else {
      choices.push(() => {
        const value = random() < 0.5;
        return { source: String(value), value };
      });
    }
    const candidates = names.filter((entry) => entry.type === type);
    if (candidates.length) {
      choices.push(() => {
        const entry = candidates[Math.floor(random() * candidates.length)]!;
        return { source: entry.name, value: valueOf.get(entry.name)! };
      });
    }
    if (depth > 0) {
      if (type === "number") {
        choices.push(() => {
          const left = expression("number", depth - 1);
          const right = expression("number", depth - 1);
          const operator = ["+", "-", "*"][Math.floor(random() * 3)]!;
          const value = operator === "+"
            ? (left.value as number) + (right.value as number)
            : operator === "-"
            ? (left.value as number) - (right.value as number)
            : (left.value as number) * (right.value as number);
          return { source: `(${left.source} ${operator} ${right.source})`, value };
        });
        choices.push(() => {
          const operand = expression("number", depth - 1);
          return { source: `(-${operand.source})`, value: -(operand.value as number) };
        });
      } else {
        choices.push(() => {
          const left = expression("number", depth - 1);
          const right = expression("number", depth - 1);
          const operator = random() < 0.5 ? "==" : "!=";
          const value = operator === "==" ? left.value === right.value : left.value !== right.value;
          return { source: `(${left.source} ${operator} ${right.source})`, value };
        });
        choices.push(() => {
          const operand = expression("boolean", depth - 1);
          return { source: `(!${operand.source})`, value: !operand.value };
        });
      }
    }
    return choices[Math.floor(random() * choices.length)]!();
  };

  const count = 2 + Math.floor(random() * 5);
  for (let index = 0; index < count; index++) {
    const name = `v${counter++}`;
    const type = random() < 0.5 ? "number" : "boolean";
    const value = expression(type, 2);
    names.push({ name, type });
    valueOf.set(name, value.value);
    lines.push(`let ${name} = ${value.source};`);
  }
  let result: Value = 0;
  const shows = 1 + Math.floor(random() * 2);
  for (let index = 0; index < shows; index++) {
    const type = random() < 0.5 ? "number" : "boolean";
    const value = expression(type, 2);
    result = value.value;
    lines.push(`show ${value.source};`);
  }
  return { source: lines.join("\n") + "\n", result };
};

const evaluate = (module: CalcModule): Value => {
  const values = new Map<number, Value>();
  const walk = (expr: CalcModule["declarations"][number] extends never ? never : any): Value => {
    switch (expr.kind) {
      case "number":
      case "boolean":
        return expr.value;
      case "name":
        return values.get(expr.binding.id) ?? 0;
      case "binary": {
        const left = walk(expr.left) as number;
        const right = walk(expr.right) as number;
        if (expr.operator === "==") return left === right;
        if (expr.operator === "!=") return left !== right;
        if (expr.operator === "+") return left + right;
        if (expr.operator === "-") return left - right;
        return left * right;
      }
      case "prefix": {
        const value = walk(expr.operand);
        return expr.operator === "!" ? !value : -(value as number);
      }
      default:
        return 0;
    }
  };
  let result: Value = 0;
  for (const declaration of module.declarations) {
    const value = walk(declaration.value);
    if (declaration.kind === "let") values.set(declaration.binding.id, value);
    else result = value;
  }
  return result;
};

test("property: random well-typed calc programs typecheck and evaluate consistently", () => {
  for (let seed = 1; seed <= 80; seed++) {
    const program = generated(seed);
    const analysis = analyze(calc, program.source, `memory://calc/${seed}`);
    assert.deepEqual(
      analysis.diagnostics,
      [],
      `seed ${seed}\n${program.source}\n${analysis.diagnostics.map((entry) => entry.message).join("\n")}`,
    );
    const module = analysis.ir as CalcModule;
    assert.equal(evaluate(module), program.result, `seed ${seed}\n${program.source}`);
    const doc = calc.typescript!(module);
    assert.ok(!doc.text.includes("\\n"));
  }
});
