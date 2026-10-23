import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import test from "node:test";
import { pathToFileURL } from "node:url";

type Message = Record<string, any>;

class LspClient {
  readonly child: ChildProcessWithoutNullStreams;
  #pending = Buffer.alloc(0);
  #waiting = new Map<number, (value: Message) => void>();
  #notifications: Message[] = [];
  #next = 1;

  constructor() {
    this.child = spawn(process.execPath, ["src/lsp/cli.ts", "--config", "./parlance.config.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.#receive(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      if (chunk.length) process.stderr.write(`[lsp] ${chunk.toString()}`);
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
        this.#waiting.get(message.id)!(message);
        this.#waiting.delete(message.id);
      } else if (message.method) {
        this.#notifications.push(message);
      }
    }
  }

  send(message: Message): void {
    const body = JSON.stringify({ jsonrpc: "2.0", ...message });
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  request(method: string, params?: unknown): Promise<Message> {
    const id = this.#next++;
    return new Promise((resolve) => {
      this.#waiting.set(id, resolve);
      this.send({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ method, params });
  }

  async waitDiagnostics(uri: string, version: number): Promise<Message> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const diagnostic = this.#notifications.find((message) =>
        message.method === "textDocument/publishDiagnostics"
        && message.params?.uri === uri
        && message.params?.version === version
      );
      if (diagnostic) return diagnostic;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`no diagnostics notification for version ${version}`);
  }

  async open(uri: string, text: string): Promise<Message> {
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "calc", version: 1, text },
    });
    return this.waitDiagnostics(uri, 1);
  }

  close(): void {
    this.notify("shutdown");
    this.notify("exit");
    this.child.kill();
  }
}

const uri = pathToFileURL("/virtual/editor.calc").href;
const source = "let x = 1 + 2;\nshow x * 3;\n";

test("the generic LSP drives calc facts and features", async () => {
  const client = new LspClient();
  try {
    const initialize = await client.request("initialize", { processId: null, rootUri: null, capabilities: {} });
    assert.equal(initialize.result.capabilities.hoverProvider, true);
    assert.equal(initialize.result.capabilities.semanticTokensProvider.full, true);
    client.notify("initialized", {});
    const diagnostics = await client.open(uri, source);
    assert.deepEqual(diagnostics.params.diagnostics, []);

    const tokens = await client.request("textDocument/semanticTokens/full", { textDocument: { uri } });
    assert.ok(tokens.result.data.length > 0);
    const first = tokens.result.data.slice(0, 5);
    assert.deepEqual(first.slice(0, 2), [0, 0]);
    assert.equal(first[2], 3); // "let"
    assert.equal(tokens.result.data[3], 16); // keyword

    const hover = await client.request("textDocument/hover", {
      textDocument: { uri },
      position: { line: 1, character: 5 },
    });
    assert.match(hover.result.contents.value, /variable x: number|number/);

    const definition = await client.request("textDocument/definition", {
      textDocument: { uri },
      position: { line: 1, character: 5 },
    });
    assert.deepEqual(definition.result.range, {
      start: { line: 0, character: 4 },
      end: { line: 0, character: 5 },
    });

    const references = await client.request("textDocument/references", {
      textDocument: { uri },
      position: { line: 1, character: 5 },
      context: { includeDeclaration: true },
    });
    assert.equal(references.result.length >= 2, true);

    const symbols = await client.request("textDocument/documentSymbol", { textDocument: { uri } });
    assert.deepEqual(symbols.result.map((symbol: Message) => symbol.name), ["x"]);

    const completion = await client.request("textDocument/completion", {
      textDocument: { uri },
      position: { line: 1, character: 0 },
    });
    const labels = completion.result.map((item: Message) => item.label);
    assert.ok(labels.includes("let"));
    assert.ok(labels.includes("show"));
    assert.ok(labels.includes("x"));

    const rename = await client.request("textDocument/rename", {
      textDocument: { uri },
      position: { line: 1, character: 5 },
      newName: "total",
    });
    assert.equal(rename.result.changes[uri].length >= 2, true);
  } finally {
    client.close();
  }
});

test("the LSP publishes calc diagnostics on broken input", async () => {
  const client = new LspClient();
  try {
    await client.request("initialize", { processId: null, rootUri: null, capabilities: {} });
    client.notify("initialized", {});
    const published = await client.open(uri, "let x = 1 + true;\n");
    assert.equal(published.params.diagnostics.length, 1);
    assert.match(published.params.diagnostics[0].message, /Expected number/);
  } finally {
    client.close();
  }
});

test("the LSP resolves a definition across imported files", async () => {
  const blogUri = pathToFileURL("/virtual/imports/blog.schema").href;
  const catalogUri = pathToFileURL("/virtual/imports/catalog.schema").href;
  const blog = "schema Blog\nmodel User {\n  id: Int @primary\n}\n";
  const catalog = "schema Catalog\nimport \"./blog.schema\";\nmodel Catalog {\n  id: Int @primary\n  owner: User\n}\n";
  const client = new LspClient();
  try {
    await client.request("initialize", { processId: null, rootUri: null, capabilities: {} });
    client.notify("initialized", {});
    const blogPublished = await client.open(blogUri, blog);
    assert.deepEqual(blogPublished.params.diagnostics, []);
    const catalogPublished = await client.open(catalogUri, catalog);
    assert.deepEqual(catalogPublished.params.diagnostics, []);

    const line = catalog.split("\n").findIndex((entry) => entry.includes("owner: User"));
    const character = catalog.split("\n")[line]!.indexOf("User") + 1;
    const definition = await client.request("textDocument/definition", {
      textDocument: { uri: catalogUri },
      position: { line, character },
    });
    assert.equal(definition.result.uri, blogUri);
    assert.equal(definition.result.range.start.line, 1);

    const references = await client.request("textDocument/references", {
      textDocument: { uri: blogUri },
      position: { line: 1, character: 6 },
      context: { includeDeclaration: true },
    });
    const uris = references.result.map((entry: Message) => entry.uri);
    assert.ok(uris.includes(blogUri), `references did not include the declaration: ${JSON.stringify(uris)}`);
    assert.ok(uris.includes(catalogUri), `references did not include the importing file: ${JSON.stringify(uris)}`);

    const renamed = await client.request("textDocument/rename", {
      textDocument: { uri: blogUri },
      position: { line: 1, character: 6 },
      newName: "Account",
    });
    assert.ok(renamed.result.changes[blogUri].length >= 1, "rename missed the declaration");
    assert.ok(renamed.result.changes[catalogUri].length >= 1, "rename missed the imported use");

    const moved = "schema Blog\n// note\nmodel User {\n  id: Int @primary\n}\n";
    client.notify("textDocument/didChange", {
      textDocument: { uri: blogUri, version: 2 },
      contentChanges: [{ text: moved }],
    });
    const published = await client.waitDiagnostics(blogUri, 2);
    assert.deepEqual(published.params.diagnostics, []);
    const movedDefinition = await client.request("textDocument/definition", {
      textDocument: { uri: catalogUri },
      position: { line, character },
    });
    assert.equal(movedDefinition.result.uri, blogUri);
    assert.equal(movedDefinition.result.range.start.line, 2, "the dependent analysis kept the old definition span");
  } finally {
    client.close();
  }
});

test("the generic LSP serves a state-machine language without new server code", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../examples/machine/order.machine", import.meta.url), "utf8");
  const machineUri = pathToFileURL("/virtual/order.machine").href;
  const client = new LspClient();
  try {
    await client.request("initialize", { processId: null, rootUri: null, capabilities: {} });
    client.notify("initialized", {});
    const published = await client.open(machineUri, source);
    assert.deepEqual(published.params.diagnostics, []);

    const symbols = await client.request("textDocument/documentSymbol", { textDocument: { uri: machineUri } });
    const names = symbols.result.map((symbol: Message) => symbol.name);
    for (const name of ["Order", "Cart", "Checkout", "Paid", "Cancelled", "edit", "pay", "cancel"]) {
      assert.ok(names.includes(name), `missing symbol ${name}`);
    }

    const line = source.split("\n").findIndex((entry) => entry.includes("on pay(amount) -> Checkout"));
    const character = source.split("\n")[line]!.indexOf("Checkout");
    const hover = await client.request("textDocument/hover", {
      textDocument: { uri: machineUri },
      position: { line, character },
    });
    assert.match(hover.result.contents.value, /state Checkout/);

    const payloadLine = source.split("\n").findIndex((entry) => entry.includes("event pay(amount: Int)"));
    const payloadCharacter = source.split("\n")[payloadLine]!.indexOf("amount");
    const payloadHover = await client.request("textDocument/hover", {
      textDocument: { uri: machineUri },
      position: { line: payloadLine, character: payloadCharacter },
    });
    assert.match(payloadHover.result.contents.value, /Int/);

    const bindingCharacter = source.split("\n")[line]!.indexOf("amount");
    const bindingHover = await client.request("textDocument/hover", {
      textDocument: { uri: machineUri },
      position: { line, character: bindingCharacter },
    });
    assert.match(bindingHover.result.contents.value, /Int/);

    const definition = await client.request("textDocument/definition", {
      textDocument: { uri: machineUri },
      position: { line, character },
    });
    const targetLine = source.split("\n").findIndex((entry) => entry.includes("state Checkout"));
    assert.equal(definition.result.range.start.line, targetLine);
  } finally {
    client.close();
  }
});
