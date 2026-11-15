import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { calc } from "../examples/calc/calc.ts";
import { schema } from "../examples/schema/schema.ts";
import { ModuleGraph } from "../src/modules.ts";
import { analyzeSnippet, embedRegistry, embedTags, findSnippets, hostSpan, snippetDiagnostics, toHost, toSnippet } from "../src/ts/embed.ts";

const root = new URL("..", import.meta.url).pathname;
const tags = embedTags([schema, calc]);
const tsc = join(root, "node_modules/typescript/bin/tsc");
const app = readFileSync(join(root, "examples/embed/app.ts"), "utf8");

test("the scanner finds keyed snippets and skips strings, comments, regexes, and member calls", () => {
  const source = [
    '// schema("A")`model X {}`',
    'const s = "schema(\\"B\\")`y`";',
    'const r = /`schema("C")`/g; const d = 4 / 2 / 1;',
    'const ok = schema("Blog")`model \\u0055ser {\\n} \\`x\\``;',
    'const db = { schema: (k: string) => (s: TemplateStringsArray) => s }; db.schema("D")`nope`;',
    'const held = calc("Price")`let x = ${ {a: `inner ${1}`}.a } + 1;`;',
    "const crlf = calc('Lines')`let a = 1;\r\nlet b = 2;`;",
  ].join("\n").replaceAll("`", "\u0060");
  const found = findSnippets(source, "file:///host.ts", tags);
  assert.deepEqual(found.map((entry) => [entry.tag, entry.key]), [["schema", "Blog"], ["calc", "Price"], ["calc", "Lines"]]);
  const [blog, price, lines] = found as [typeof found[0], typeof found[0], typeof found[0]];
  assert.equal(blog.text, "model User {\n} \u0060x\u0060");
  assert.equal(blog.uri, "file:///host.ts#embed=schema:Blog");
  // An escape maps back to its whole escape sequence.
  const at = blog.text.indexOf("U");
  const span = hostSpan(blog, { start: at, end: at + 4 });
  assert.equal(source.slice(span.start, span.end), "\\u0055ser");
  assert.equal(toSnippet(blog, source.indexOf("model \\u0055")), 0);
  assert.equal(toSnippet(blog, blog.span.start), undefined);
  // Each hole becomes one space and is reported.
  assert.equal(price.text, "let x =   + 1;");
  assert.equal(price.holes.length, 1);
  assert.equal(source.slice(price.holes[0]!.start, price.holes[0]!.end).startsWith("${".replace("§", "$")), true);
  assert.equal(lines.text, "let a = 1;\nlet b = 2;");
  for (const snippet of found) {
    for (let offset = 0; offset < snippet.text.length; offset++) {
      if (snippet.text[offset] === " ") continue;
      assert.equal(toSnippet(snippet, toHost(snippet, offset)), offset);
    }
  }
});

test("snippet diagnostics land at host offsets", () => {
  const source = app.replace("email == email", "emial == email");
  const snippet = findSnippets(source, "file:///app.ts", tags).find((entry) => entry.key === "Blog")!;
  const diagnostics = snippetDiagnostics(snippet, analyzeSnippet(new ModuleGraph({ languages: [schema, calc] }), snippet));
  assert.equal(diagnostics.length, 1);
  assert.equal(source.slice(diagnostics[0]!.span.start, diagnostics[0]!.span.end), "emial");
});

test("the registry types each snippet under its key and reports duplicate keys", () => {
  const directory = mkdtempSync(join(root, ".embed-"));
  try {
    writeFileSync(join(directory, "parlance.embeds"), "");
    writeFileSync(join(directory, "a.ts"), app);
    writeFileSync(join(directory, "b.ts"), 'import { calc } from "./parlance.embeds";\nexport const p = calc("Pricing")\u0060let y = 1;\u0060;\n');
    const registry = embedRegistry(join(directory, "parlance.embeds"), new ModuleGraph({ languages: [schema, calc] }), tags);
    assert.match(registry.text, /readonly "Blog": typeof __schema0;/);
    assert.match(registry.text, /export declare function calc<K extends keyof CalcEmbeds>/);
    assert.match(registry.text, /export function open\(database\?: string\): Database;/);
    assert.deepEqual(registry.diagnostics.map(({ diagnostic }) => diagnostic.message), [
      'Duplicate calc snippet key "Pricing"; keys are unique per .embeds stub',
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Runs tsc over a copy of the example app with one change. Mapper errors stop tsc before type checking. */
const check = (change: (source: string) => string) => {
  const directory = mkdtempSync(join(root, ".embed-"));
  try {
    copyFileSync(join(root, "examples/embed/parlance.embeds"), join(directory, "parlance.embeds"));
    const source = change(app);
    writeFileSync(join(directory, "app.ts"), source);
    writeFileSync(join(directory, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ESNext", module: "NodeNext", strict: true, noEmit: true, types: ["node"] },
      contentMappers: [{ package: "@parlance/ts-host", extensions: [".embeds"], options: { config: "../parlance.config.ts" } }],
      files: ["app.ts"],
    }));
    const run = spawnSync(process.execPath, [tsc, "-p", directory, "--runExternalCode"], { cwd: root, encoding: "utf8" });
    return { source, status: run.status, output: run.stdout + run.stderr };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const lineOf = (source: string, needle: string) => {
  const lines = source.split("\n");
  const line = lines.findIndex((text) => text.includes(needle));
  return { line: line + 1, column: lines[line]!.indexOf(needle) + 1 };
};

test("tsc reports a guest error in a snippet at its host position", () => {
  const { source, status, output } = check((text) => text.replace("email == email", "emial == email"));
  assert.notEqual(status, 0, output);
  const { line, column } = lineOf(source, "emial");
  assert.ok(output.includes(`parlance.embeds(1,1): error parlance1: app.ts(${line},${column}): Unknown field "emial"`), output);
});

test("tsc reports a TypeScript error from a snippet's typed result", () => {
  const clean = check((text) => text);
  assert.equal(clean.status, 0, clean.output);
  const { source, status, output } = check((text) => text.replace("const total: number", "const total: string"));
  assert.notEqual(status, 0, output);
  const { line } = lineOf(source, "const total: string");
  assert.ok(output.includes(`app.ts(${line},7): error TS2322: Type 'number' is not assignable to type 'string'`), output);
});

test("the Node loader runs snippets and reports guest errors at host positions", () => {
  const ok = spawnSync(process.execPath, ["--import", "./examples/register.ts", "examples/embed/app.ts"], { cwd: root, encoding: "utf8" });
  assert.equal(ok.stdout.trim(), "sai@example.com Admin 125 true", ok.stderr);
  const directory = mkdtempSync(join(root, ".embed-"));
  try {
    copyFileSync(join(root, "examples/embed/parlance.embeds"), join(directory, "parlance.embeds"));
    writeFileSync(join(directory, "app.ts"), app.replace("email == email", "emial == email"));
    const bad = spawnSync(process.execPath, ["--import", "./examples/register.ts", join(directory, "app.ts")], { cwd: root, encoding: "utf8" });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /app\.ts\(16,17\): Unknown field "emial"/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});