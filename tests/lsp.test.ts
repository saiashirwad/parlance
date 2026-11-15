import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("the LSP drives advanced facts and cross-module definitions", async () => {
  const advancedUri = pathToFileURL("/virtual/editor.advanced").href;
  const source = [
    "type Option(a) = None | Some(a)",
    "let value = fn(option: Option(number)) => match option { None => 0, Some(number) => number } in",
    "value(Some(3))",
    "",
  ].join("\n");
  const client = new LspClient();
  try {
    await client.request("initialize", { processId: null, rootUri: null, capabilities: {} });
    client.notify("initialized", {});
    const published = await client.open(advancedUri, source);
    assert.deepEqual(published.params.diagnostics, []);

    const hover = await client.request("textDocument/hover", {
      textDocument: { uri: advancedUri },
      position: { line: 2, character: 1 },
    });
    assert.match(hover.result.contents.value, /Option\(number\)/);

    const definition = await client.request("textDocument/definition", {
      textDocument: { uri: advancedUri },
      position: { line: 2, character: source.split("\n")[2]!.indexOf("Some") + 1 },
    });
    assert.equal(definition.result.range.start.line, 0);

    const tokens = await client.request("textDocument/semanticTokens/full", { textDocument: { uri: advancedUri } });
    assert.ok(tokens.result.data.length > 0);

    const completion = await client.request("textDocument/completion", {
      textDocument: { uri: advancedUri },
      position: { line: 0, character: 0 },
    });
    const labels = completion.result.map((item: Message) => item.label);
    for (const label of ["type", "forall", "number", "boolean", "string"]) {
      assert.ok(labels.includes(label), `missing completion ${label}: ${JSON.stringify(labels)}`);
    }
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

test("the LSP completes schema attributes and scalar types", async () => {
  const schemaUri = pathToFileURL("/virtual/completion.schema").href;
  const source = "schema Shop\nmodel Item {\n  id: Int @primary\n  name: String\n}\n";
  const client = new LspClient();
  try {
    await client.request("initialize", { processId: null, rootUri: null, capabilities: {} });
    client.notify("initialized", {});
    const published = await client.open(schemaUri, source);
    assert.deepEqual(published.params.diagnostics, []);

    const completion = await client.request("textDocument/completion", {
      textDocument: { uri: schemaUri },
      position: { line: 0, character: 0 },
    });
    const labels = completion.result.map((item: Message) => item.label);
    for (const label of ["@primary", "@auto", "@unique", "@default", "Int", "String", "Bool", "DateTime", "Item", "id"]) {
      assert.ok(labels.includes(label), `missing completion ${label}: ${JSON.stringify(labels)}`);
    }
    const primary = completion.result.find((item: Message) => item.label === "@primary");
    assert.equal(primary.insertText, "primary", "attribute insertion should not duplicate the @");

    const attributeLine = source.split("\n")[2]!;
    const attribute = await client.request("textDocument/completion", {
      textDocument: { uri: schemaUri },
      position: { line: 2, character: attributeLine.indexOf("@") + 1 },
    });
    const attributeLabels = attribute.result.map((item: Message) => item.label);
    assert.deepEqual(attributeLabels.sort(), ["@auto", "@default", "@primary", "@unique"]);
  } finally {
    client.close();
  }
});

test("the LSP resolves local type names in fields and query results", async () => {
  const schemaUri = pathToFileURL("/virtual/local-types.schema").href;
  const source = [
    "schema Shop",
    "enum Kind { Sale Rent }",
    "model Item {",
    "  id: Int @primary",
    "  kind: Kind",
    "}",
    "query items(): Item[] =",
    "  Item |> all;",
    "",
  ].join("\n");
  const client = new LspClient();
  try {
    await client.request("initialize", { processId: null, rootUri: null, capabilities: {} });
    client.notify("initialized", {});
    const published = await client.open(schemaUri, source);
    assert.deepEqual(published.params.diagnostics, []);

    const fieldType = await client.request("textDocument/definition", {
      textDocument: { uri: schemaUri },
      position: { line: 4, character: source.split("\n")[4]!.indexOf("Kind") + 1 },
    });
    assert.equal(fieldType.result.range.start.line, 1, "field type did not resolve to the enum");

    const resultType = await client.request("textDocument/definition", {
      textDocument: { uri: schemaUri },
      position: { line: 6, character: source.split("\n")[6]!.indexOf("Item") + 1 },
    });
    assert.equal(resultType.result.range.start.line, 2, "query result type did not resolve to the model");

    const references = await client.request("textDocument/references", {
      textDocument: { uri: schemaUri },
      position: { line: 2, character: source.split("\n")[2]!.indexOf("Item") + 1 },
      context: { includeDeclaration: true },
    });
    const lines = references.result.map((entry: Message) => entry.range.start.line).sort((a: number, b: number) => a - b);
    assert.deepEqual(lines, [2, 6, 7], "model references missed the query result or source");
  } finally {
    client.close();
  }
});

test("closing an unsaved dependency refreshes importers from disk", async () => {
  const directory = mkdtempSync(join(tmpdir(), "parlance-lsp-close-"));
  const blogPath = join(directory, "blog.schema");
  const catalogPath = join(directory, "catalog.schema");
  const blog = "schema Blog\nmodel User {\n  id: Int @primary\n}\n";
  const catalog = "schema Catalog\nimport \"./blog.schema\";\nmodel Catalog {\n  id: Int @primary\n  owner: User\n}\n";
  writeFileSync(blogPath, blog);
  writeFileSync(catalogPath, catalog);
  const blogUri = pathToFileURL(blogPath).href;
  const catalogUri = pathToFileURL(catalogPath).href;
  const client = new LspClient();
  try {
    await client.request("initialize", { processId: null, rootUri: null, capabilities: {} });
    client.notify("initialized", {});
    await client.open(blogUri, blog);
    await client.open(catalogUri, catalog);
    const line = catalog.split("\n").findIndex((entry) => entry.includes("owner: User"));
    const character = catalog.split("\n")[line]!.indexOf("User") + 1;
    const before = await client.request("textDocument/definition", {
      textDocument: { uri: catalogUri },
      position: { line, character },
    });
    assert.equal(before.result.range.start.line, 1);

    const unsaved = "schema Blog\n// note\nmodel User {\n  id: Int @primary\n}\n";
    client.notify("textDocument/didChange", {
      textDocument: { uri: blogUri, version: 2 },
      contentChanges: [{ text: unsaved }],
    });
    await client.waitDiagnostics(blogUri, 2);
    const during = await client.request("textDocument/definition", {
      textDocument: { uri: catalogUri },
      position: { line, character },
    });
    assert.equal(during.result.range.start.line, 2, "the open importer did not see the unsaved edit");

    client.notify("textDocument/didClose", { textDocument: { uri: blogUri } });
    let after = await client.request("textDocument/definition", {
      textDocument: { uri: catalogUri },
      position: { line, character },
    });
    for (let attempt = 0; attempt < 100 && after.result?.range?.start?.line !== 1; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      after = await client.request("textDocument/definition", {
        textDocument: { uri: catalogUri },
        position: { line, character },
      });
    }
    assert.equal(after.result.range.start.line, 1, "the importer kept the closed buffer's offsets");
  } finally {
    client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the generic LSP serves .parl grammar files", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/grammar/grammar.parl", import.meta.url), "utf8");
  const grammarUri = pathToFileURL("/virtual/grammar.parl").href;
  const client = new LspClient();
  try {
    await client.request("initialize", { processId: null, rootUri: null, capabilities: {} });
    client.notify("initialized", {});
    const published = await client.open(grammarUri, source);
    assert.deepEqual(published.params.diagnostics, []);

    const symbols = await client.request("textDocument/documentSymbol", { textDocument: { uri: grammarUri } });
    const names = symbols.result.map((symbol: Message) => symbol.name);
    for (const name of ["Grammar", "File", "Rule", "Primary"]) assert.ok(names.includes(name), `missing symbol ${name}`);

    const tokens = await client.request("textDocument/semanticTokens/full", { textDocument: { uri: grammarUri } });
    assert.ok(tokens.result.data.length > 0);

    const lines = source.split("\n");
    const line = lines.findIndex((entry) => entry.startsWith("root File"));
    const character = lines[line]!.indexOf("File");
    const hover = await client.request("textDocument/hover", {
      textDocument: { uri: grammarUri },
      position: { line, character },
    });
    assert.match(hover.result.contents.value, /rule File/);
    const definition = await client.request("textDocument/definition", {
      textDocument: { uri: grammarUri },
      position: { line, character },
    });
    assert.equal(definition.result.range.start.line, lines.findIndex((entry) => entry.startsWith("rule File =")));
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

test("completion offers only names in scope, declared-before names first", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../examples/machine/order.machine", import.meta.url), "utf8");
  const lines = source.split("\n");
  const machineUri = pathToFileURL("/virtual/scope.machine").href;
  const advancedUri = pathToFileURL("/virtual/scope.advanced").href;
  const advanced = "let one = 1 in\nlet f = fn(option: number) => option in\nf(one)\n";
  const client = new LspClient();
  try {
    await client.request("initialize", { processId: null, rootUri: null, capabilities: {} });
    client.notify("initialized", {});
    await client.open(machineUri, source);
    await client.open(advancedUri, advanced);
    const complete = async (target: string, line: number, character: number): Promise<Message[]> =>
      (await client.request("textDocument/completion", {
        textDocument: { uri: target },
        position: { line, character },
      })).result;
    const edit = lines.findIndex((entry) => entry.includes("on edit -> Cart"));
    const labels = (items: Message[]) => items.map((item) => item.label);
    const sibling = await complete(machineUri, edit, lines[edit]!.indexOf("Cart"));
    assert.ok(labels(sibling).includes("Checkout"));
    assert.ok(labels(sibling).includes("state"));
    // A checker using only cx.scope and cx.bind gets the same filtering.
    const body = await complete(advancedUri, 1, advanced.split("\n")[1]!.lastIndexOf("option"));
    assert.ok(labels(body).includes("option"));
    assert.ok(labels(body).includes("one"));
    const outside = await complete(advancedUri, 2, 3);
    assert.ok(!labels(outside).includes("option"));
    const sorted = (items: Message[], label: string) => items.find((item) => item.label === label)?.sortText;
    assert.equal(sorted(outside, "f")?.[0], "0");
  } finally {
    client.close();
  }
});

test("inlay hints show binding types unless annotated or opted out", async () => {
  const client = new LspClient();
  try {
    await client.request("initialize", { processId: null, rootUri: null, capabilities: {} });
    client.notify("initialized", {});
    await client.open(uri, source);
    const hints = await client.request("textDocument/inlayHint", {
      textDocument: { uri },
      range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
    });
    assert.deepEqual(
      hints.result.map((hint: Message) => [hint.position, hint.label]),
      [[{ line: 0, character: 5 }, ": number"]],
    );
    const outside = await client.request("textDocument/inlayHint", {
      textDocument: { uri },
      range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } },
    });
    assert.deepEqual(outside.result, []);

    // An advanced `fn(option: number)` parameter is already annotated, so it gets no hint.
    const advancedUri = pathToFileURL("/virtual/hints.advanced").href;
    await client.open(advancedUri, "let f = fn(option: number) => option in\nf(1)\n");
    const annotated = await client.request("textDocument/inlayHint", {
      textDocument: { uri: advancedUri },
      range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
    });
    assert.ok(!annotated.result.some((hint: Message) => hint.position.character === "let f = fn(option".length));
  } finally {
    client.close();
  }
});
