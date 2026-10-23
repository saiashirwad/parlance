import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

type Message = Record<string, any>;

const root = new URL("..", import.meta.url).pathname;

class Client {
  readonly child: ChildProcessWithoutNullStreams;
  #pending = Buffer.alloc(0);
  #waiting = new Map<number, { resolve: (value: Message) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout }>();
  #next = 1;
  #logs = "";

  constructor(command: string, args: string[]) {
    this.child = spawn(command, args, { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (chunk: Buffer) => this.#receive(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.#logs = `${this.#logs}${chunk.toString()}`.slice(-8000);
    });
    this.child.on("exit", (code, signal) => {
      for (const entry of this.#waiting.values()) entry.reject(new Error(`LSP exited ${code ?? signal}\n${this.#logs}`));
      this.#waiting.clear();
    });
  }

  #receive(chunk: Buffer): void {
    this.#pending = Buffer.concat([this.#pending, chunk]);
    for (;;) {
      const end = this.#pending.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = /Content-Length: *(\d+)/i.exec(this.#pending.subarray(0, end).toString())?.[1];
      if (length === undefined) {
        this.#pending = this.#pending.subarray(end + 4);
        continue;
      }
      const stop = end + 4 + Number(length);
      if (this.#pending.length < stop) return;
      const message = JSON.parse(this.#pending.subarray(end + 4, stop).toString("utf8")) as Message;
      this.#pending = this.#pending.subarray(stop);
      if (message.id !== undefined && this.#waiting.has(message.id)) {
        const entry = this.#waiting.get(message.id)!;
        this.#waiting.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
        else entry.resolve(message.result);
        continue;
      }
      if (typeof message.method === "string" && message.id !== undefined) {
        let result: unknown = null;
        if (message.method === "workspace/configuration") {
          result = (message.params?.items ?? []).map(() => ({}));
        } else if (message.method === "workspace/workspaceFolders") {
          result = [{ uri: pathToFileURL(root).href, name: "parlance" }];
        } else if (!["client/registerCapability", "window/workDoneProgress/create"].includes(message.method)) {
          this.#send({ id: message.id, error: { code: -32601, message: `Unsupported ${message.method}` } });
          continue;
        }
        this.#send({ id: message.id, result });
      }
    }
  }

  #send(message: Message): void {
    const body = JSON.stringify({ jsonrpc: "2.0", ...message });
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  request(method: string, params?: unknown): Promise<Message> {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id);
        reject(new Error(`timeout ${method}\n${this.#logs}`));
      }, 30_000);
      this.#waiting.set(id, { resolve, reject, timer });
      this.#send({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.#send({ method, params });
  }

  kill(): void {
    this.child.kill();
  }
}

const position = (source: string, needle: string, occurrence = 0) => {
  let index = -1;
  for (let count = 0; count <= occurrence; count++) index = source.indexOf(needle, index + 1);
  assert.ok(index >= 0, `missing ${needle}`);
  const before = source.slice(0, index).split("\n");
  return { line: before.length - 1, character: before.at(-1)!.length };
};

const file = join(root, "examples/typescript/calc.ts");
const guest = pathToFileURL(join(root, "examples/calc/demo.calc")).href;

test("tsgo hovers and navigates from TypeScript into a calc file", async () => {
  const source = readFileSync(file, "utf8");
  const client = new Client(
    process.execPath,
    [join(root, "node_modules/typescript/bin/tsc"), "--lsp", "--stdio"],
  );
  try {
    await client.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(root).href,
      workspaceFolders: [{ uri: pathToFileURL(root).href, name: "parlance" }],
      initializationOptions: { runExternalCode: true },
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        textDocument: { hover: { contentFormat: ["markdown"] } },
      },
    });
    client.notify("initialized", {});
    const uri = pathToFileURL(file).href;
    client.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "typescript", version: 1, text: source },
    });

    const at = position(source, "subtotal", 1);
    const hover = await client.request("textDocument/hover", { textDocument: { uri }, position: at });
    const hoverText = typeof hover.contents === "string" ? hover.contents : hover.contents.value;
    assert.match(hoverText, /subtotal/);
    assert.match(hoverText, /number/);

    const definition = await client.request("textDocument/definition", { textDocument: { uri }, position: at });
    const locations = Array.isArray(definition) ? definition : [definition];
    const target = locations.find((entry) => entry.uri === guest || entry.targetUri === guest);
    assert.ok(target, `definition should land in demo.calc: ${JSON.stringify(definition)}`);
    const range = target.range ?? target.targetSelectionRange;
    assert.equal(range.start.line, 0);

    const diagnostics = await client.request("textDocument/diagnostic", { textDocument: { uri } });
    assert.deepEqual(diagnostics.items, []);
  } finally {
    client.kill();
  }
});

test("tsgo hovers and navigates from TypeScript into an advanced file", async () => {
  const consumer = join(root, "examples/typescript/advanced.ts");
  const source = readFileSync(consumer, "utf8");
  const guestUri = pathToFileURL(join(root, "examples/advanced/trees.advanced")).href;
  const client = new Client(
    process.execPath,
    [join(root, "node_modules/typescript/bin/tsc"), "--lsp", "--stdio"],
  );
  try {
    await client.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(root).href,
      workspaceFolders: [{ uri: pathToFileURL(root).href, name: "parlance" }],
      initializationOptions: { runExternalCode: true },
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        textDocument: { hover: { contentFormat: ["markdown"] } },
      },
    });
    client.notify("initialized", {});
    const uri = pathToFileURL(consumer).href;
    client.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "typescript", version: 1, text: source },
    });

    const at = position(source, "fromList");
    const hover = await client.request("textDocument/hover", { textDocument: { uri }, position: at });
    const hoverText = typeof hover.contents === "string" ? hover.contents : hover.contents.value;
    assert.match(hoverText, /fromList/);
    assert.match(hoverText, /Tree<A>/);

    const definition = await client.request("textDocument/definition", { textDocument: { uri }, position: at });
    const locations = Array.isArray(definition) ? definition : [definition];
    const target = locations.find((entry) => entry.uri === guestUri || entry.targetUri === guestUri);
    assert.ok(target, `definition should land in trees.advanced: ${JSON.stringify(definition)}`);
    const range = target.range ?? target.targetSelectionRange;
    assert.ok(range.start.line > 0);

    const diagnostics = await client.request("textDocument/diagnostic", { textDocument: { uri } });
    assert.deepEqual(diagnostics.items, []);
  } finally {
    client.kill();
  }
});

test("tsgo hovers and navigates from TypeScript into a schema file", async () => {
  const consumer = join(root, "examples/typescript/schema.ts");
  const source = readFileSync(consumer, "utf8");
  const guestUri = pathToFileURL(join(root, "examples/schema/blog.schema")).href;
  const client = new Client(
    process.execPath,
    [join(root, "node_modules/typescript/bin/tsc"), "--lsp", "--stdio"],
  );
  try {
    await client.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(root).href,
      workspaceFolders: [{ uri: pathToFileURL(root).href, name: "parlance" }],
      initializationOptions: { runExternalCode: true },
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        textDocument: { hover: { contentFormat: ["markdown"] } },
      },
    });
    client.notify("initialized", {});
    const uri = pathToFileURL(consumer).href;
    client.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "typescript", version: 1, text: source },
    });

    const at = position(source, "userByEmail");
    const hover = await client.request("textDocument/hover", { textDocument: { uri }, position: at });
    const hoverText = typeof hover.contents === "string" ? hover.contents : hover.contents.value;
    assert.match(hoverText, /userByEmail/);
    assert.match(hoverText, /User \| undefined/);

    const definition = await client.request("textDocument/definition", { textDocument: { uri }, position: at });
    const locations = Array.isArray(definition) ? definition : [definition];
    const target = locations.find((entry) => entry.uri === guestUri || entry.targetUri === guestUri);
    assert.ok(target, `definition should land in blog.schema: ${JSON.stringify(definition)}`);
    const range = target.range ?? target.targetSelectionRange;
    assert.ok(range.start.line > 0);

    const diagnostics = await client.request("textDocument/diagnostic", { textDocument: { uri } });
    assert.deepEqual(diagnostics.items, []);
  } finally {
    client.kill();
  }
});
