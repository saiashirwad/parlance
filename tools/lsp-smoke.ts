#!/usr/bin/env node
/**
 * Drives the real `parlance lsp` process over stdio. Proves that an edit
 * updates diagnostics, hover, and definition without restarting the server.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

type Message = Record<string, any>;

const root = new URL("..", import.meta.url).pathname;
const uri = pathToFileURL("/virtual/smoke.calc").href;

class Client {
  readonly child: ChildProcessWithoutNullStreams;
  #pending = Buffer.alloc(0);
  #waiting = new Map<number, (value: Message) => void>();
  #notifications: Message[] = [];
  #next = 1;

  constructor() {
    this.child = spawn(process.execPath, ["src/lsp/cli.ts", "--config", "./parlance.config.ts"], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.#receive(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => process.stderr.write(`[lsp] ${chunk}`));
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

  async diagnostics(version: number): Promise<Message> {
    for (let attempt = 0; attempt < 400; attempt++) {
      const found = this.#notifications.find((message) =>
        message.method === "textDocument/publishDiagnostics"
        && message.params?.uri === uri
        && message.params?.version === version
      );
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`no diagnostics for version ${version}`);
  }

  close(): void {
    this.notify("shutdown");
    this.notify("exit");
    this.child.kill();
  }
}

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};

const source = "let x = 1 + 2;\nshow x * 3;\n";
const broken = "let x = 1 + true;\nshow x * 3;\n";
const client = new Client();
const started = performance.now();
try {
  const initialize = await client.request("initialize", {
    processId: null,
    rootUri: null,
    capabilities: {},
  });
  assert(initialize.result.capabilities.hoverProvider === true, "hover is not advertised");
  client.notify("initialized", {});
  client.notify("textDocument/didOpen", {
    textDocument: { uri, languageId: "calc", version: 1, text: source },
  });
  const clean = await client.diagnostics(1);
  assert(clean.params.diagnostics.length === 0, `open diagnostics: ${JSON.stringify(clean.params.diagnostics)}`);

  const hover = await client.request("textDocument/hover", {
    textDocument: { uri },
    position: { line: 1, character: 5 },
  });
  assert(/number/.test(hover.result?.contents?.value ?? ""), "hover does not show number");

  const definition = await client.request("textDocument/definition", {
    textDocument: { uri },
    position: { line: 1, character: 5 },
  });
  assert(definition.result?.range?.start?.line === 0, "definition did not jump to line 0");

  client.notify("textDocument/didChange", {
    textDocument: { uri, version: 2 },
    contentChanges: [{ text: broken }],
  });
  const errors = await client.diagnostics(2);
  assert(errors.params.diagnostics.length === 1, `broken diagnostics: ${JSON.stringify(errors.params.diagnostics)}`);
  assert(
    /Expected number/.test(errors.params.diagnostics[0].message),
    `unexpected error: ${errors.params.diagnostics[0].message}`,
  );

  client.notify("textDocument/didChange", {
    textDocument: { uri, version: 3 },
    contentChanges: [{ text: source }],
  });
  const fixed = await client.diagnostics(3);
  assert(fixed.params.diagnostics.length === 0, "diagnostics did not clear after the fix");
  const again = await client.request("textDocument/hover", {
    textDocument: { uri },
    position: { line: 1, character: 5 },
  });
  assert(/number/.test(again.result?.contents?.value ?? ""), "hover did not survive the edit");

  const tokens = await client.request("textDocument/semanticTokens/full", { textDocument: { uri } });
  assert(tokens.result.data.length > 0, "semantic tokens are empty");

  const elapsed = Math.round(performance.now() - started);
  process.stdout.write(`ok lsp edit scenario (open, break, fix, hover, definition, tokens) ${elapsed}ms\n`);
} finally {
  client.close();
}
