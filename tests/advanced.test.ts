import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { site } from "../src/diagnostic.ts";
import { analyze } from "../src/language.ts";
import { ModuleGraph } from "../src/modules.ts";
import { advanced } from "../examples/advanced/advanced.ts";
import type { AdvancedModule } from "../examples/advanced/check.ts";
import { show } from "../examples/advanced/type.ts";

const root = new URL("..", import.meta.url).pathname;
const stdlib = readFileSync(join(root, "examples/advanced/stdlib.advanced"), "utf8");

const analyzeSource = (source: string, name = "test.advanced", dependencies: Record<string, string> = {}) => {
  const graph = new ModuleGraph({
    languages: [advanced],
    read: (uri) => {
      const file = uri.slice(uri.lastIndexOf("/") + 1);
      if (file === "stdlib.advanced") return stdlib;
      return dependencies[file] ?? null;
    },
  });
  return graph.analyze(`file:///virtual/${name}`, { source });
};

const diagnostics = (source: string): string =>
  analyze(advanced, source, "memory://advanced/test.advanced").diagnostics
    .map((entry) => `${entry.severity}: ${entry.message}`)
    .join("\n");

const diagnostic = (source: string, pattern: RegExp) => {
  const found = analyze(advanced, source, "memory://advanced/test.advanced").diagnostics.find((entry) =>
    pattern.test(entry.message)
  );
  assert.ok(found, `missing diagnostic ${pattern}`);
  return found;
};

const spanOf = (source: string, needle: string, occurrence = 0) => {
  let start = -1;
  for (let index = 0; index <= occurrence; index++) start = source.indexOf(needle, start + 1);
  assert.notEqual(start, -1, `missing ${JSON.stringify(needle)}`);
  return { start, end: start + needle.length };
};

const moduleOf = (source: string): AdvancedModule => {
  const analysis = analyze(advanced, source, "memory://advanced/test.advanced");
  assert.deepEqual(analysis.diagnostics, []);
  return analysis.ir as AdvancedModule;
};

test("advanced infers let-polymorphism and function types", () => {
  const source = [
    "let id = fn(x) => x in",
    "let twice = fn(f) => fn(x) => f(f(x)) in",
    "{ number = id(1), text = id(\"x\"), stepped = twice(fn(n) => n + 1)(3) }",
  ].join("\n");
  const module = moduleOf(source);
  assert.equal(show(module.resultType), "{ number: number, stepped: number, text: string }");
});

test("advanced keeps aliases of lambda parameters monomorphic", () => {
  const source = "fn(f) => let g = f in let x = g(1) in g(true)";
  assert.match(diagnostics(source), /Cannot unify boolean with number/);
});

test("advanced supports higher-rank annotations and rejects skolem escapes", () => {
  const source = [
    "let id = fn(x) => x in",
    "let both = fn(f: forall a. a -> a) => { value = f(20), flag = f(true) } in",
    "both(id)",
  ].join("\n");
  const module = moduleOf(source);
  assert.match(show(module.resultType), /\{ flag: boolean, value: number \}/);

  const escape = "fn(r) => (r.x : forall a. a)";
  const found = diagnostic(escape, /Skolem escape/);
  assert.deepEqual(found.span, spanOf(escape, "r.x"));
});

test("advanced checks algebraic data types, arity, and exhaustive matches", () => {
  const valid = [
    "type Option(a) = None | Some(a)",
    "let value = fn(option: Option(number)) => match option {",
    "  None => 0,",
    "  Some(number) => number",
    "} in",
    "value(Some(3))",
  ].join("\n");
  assert.equal(diagnostics(valid), "");

  const missing = "type Option(a) = None | Some(a) let f = fn(o: Option(number)) => match o { Some(v) => v } in f(None)";
  assert.match(diagnostics(missing), /Non-exhaustive match; missing: None/);

  const duplicate = "type Option(a) = None | Some(a) let f = fn(o: Option(number)) => match o { Some(v) => v, Some(w) => w, None => 0 } in f(None)";
  assert.match(diagnostics(duplicate), /Unreachable duplicate case: Some/);

  const unknown = "type Option(a) = None | Some(a) let f = fn(o: Option(number)) => match o { Nope => 0 } in f(None)";
  assert.match(diagnostics(unknown), /Unknown constructor "Nope"/);

  const arity = "type Pair(a) = Pair(a, a) let f = fn(p: Pair(number)) => match p { Pair(x) => x } in f(Pair(1, 2))";
  assert.match(diagnostics(arity), /expects 2 fields, found 1/);

  const nested = "type Option(a) = None | Some(a) let f = fn(o: Option(Option(number))) => match o { Some(Some(v)) => v, Some(None) => 0, None => 0 } in f(None)";
  assert.match(diagnostics(nested), /Nested constructor patterns are not supported/);

  const duplicateType = "type T = A type T = B { value = A }";
  assert.match(diagnostics(duplicateType), /Duplicate type "T"/);

  assert.match(diagnostics("type T = A"), /A module needs a body expression/);
  assert.match(diagnostics("type T = A\n1\n2"), /A module has only one body expression/);
  assert.match(diagnostics("1\ntype T = A"), /The body expression must be last/);
});

test("advanced infers open records and record extension", () => {
  const get = "let getValue = fn(record) => record.value in getValue({ value = 42, unit = \"kg\" })";
  assert.equal(show(moduleOf(get).resultType), "number");

  const update = "let flagged = fn(record) => { flag = true | record } in flagged({ value = 1 })";
  const type = show(moduleOf(update).resultType);
  assert.match(type, /flag: boolean/);
  assert.match(type, /value: number/);

  const duplicate = "let f = fn(x) => { value = 1, value = 2 } in f(0)";
  assert.match(diagnostics(duplicate), /Duplicate field "value"/);
});

test("advanced analyses the upstream modules and imports", () => {
  const graph = new ModuleGraph({ languages: [advanced] });
  const main = graph.analyze(join(root, "examples/advanced/main.advanced"));
  assert.deepEqual(main.diagnostics, []);
  assert.equal(show((main.ir as AdvancedModule).resultType), "number");

  const trees = graph.analyze(join(root, "examples/advanced/trees.advanced"));
  assert.deepEqual(trees.diagnostics, []);
  const module = trees.ir as AdvancedModule;
  const fromList = module.exports.find((entry) => entry.name === "fromList");
  assert.ok(fromList && fromList.kind === "field");
  assert.match(show(fromList.fieldType), /List\(a\) -> Tree\(a\)/);

  const foldList = trees.facts.definitions.find((definition) => definition.name === "foldList");
  assert.ok(foldList);
  assert.ok(foldList.uri?.endsWith("/examples/advanced/stdlib.advanced"));
  const used = trees.facts.references.filter((reference) => reference.id === foldList.id);
  assert.ok(used.length > 0, "the imported foldList has no reference facts");
});

test("advanced routes dependency errors to the import and checks imported calls", () => {
  const bad = analyzeSource(
    "import \"./stdlib.advanced\";\nlength(1) + 2\n",
    "bad.advanced",
  );
  assert.equal(bad.valid, false);
  assert.equal(bad.diagnostics.length, 1);
  assert.match(bad.diagnostics[0]!.message, /Cannot unify number with List\(a\)/);
  assert.deepEqual(bad.diagnostics[0]!.span, spanOf("import \"./stdlib.advanced\";\nlength(1) + 2\n", "1"));

  const dependency = "type Bad = Nope(Unknown)\n{ value = 1 }\n";
  const importer = "import \"./broken.advanced\";\n{ value = 2 }\n";
  const graph = new ModuleGraph({
    languages: [advanced],
    read: (uri) => {
      const file = uri.slice(uri.lastIndexOf("/") + 1);
      if (file === "broken.advanced") return dependency;
      return null;
    },
  });
  const analysis = graph.analyze("file:///virtual/importer.advanced", { source: importer });
  assert.equal(analysis.valid, false);
  const routed = analysis.diagnostics.find((entry) => /Unknown type "Unknown"/.test(entry.message));
  assert.ok(routed, `missing routed diagnostic: ${JSON.stringify(analysis.diagnostics)}`);
  assert.equal(site(routed, "file:///virtual/importer.advanced").uri, "file:///virtual/importer.advanced");
  assert.equal(routed.origin?.uri, "file:///virtual/broken.advanced");
});

test("advanced projects brands, generic exports, and imported types", () => {
  const graph = new ModuleGraph({ languages: [advanced] });
  const stdlibAnalysis = graph.analyze(join(root, "examples/advanced/stdlib.advanced"));
  assert.deepEqual(stdlibAnalysis.diagnostics, []);
  const stdlibDoc = advanced.typescript!(stdlibAnalysis.ir as AdvancedModule).text;
  assert.match(stdlibDoc, /export type Option<A> = \{ readonly \[\$Option\]:/);
  assert.match(stdlibDoc, /export type Result<A, E>/);
  assert.match(stdlibDoc, /export declare const foldList: <A, B>/);
  assert.match(stdlibDoc, /export \{ \$const as const \};/);

  const treesAnalysis = graph.analyze(join(root, "examples/advanced/trees.advanced"));
  assert.deepEqual(treesAnalysis.diagnostics, []);
  const treesDoc = advanced.typescript!(treesAnalysis.ir as AdvancedModule).text;
  assert.match(treesDoc, /import type \{ List \} from "\.\/stdlib\.advanced";/);
  assert.match(treesDoc, /export type Tree<A>/);
  assert.match(treesDoc, /export declare const fromList: <A>\(x: A\) => \(x: List<A>\) => Tree<A>;/);
  assert.match(treesDoc, /export declare const getValue: <A, R extends object>/);
  assert.match(treesDoc, /export declare const both: \(x: <A>\(x: A\) => A\)/);

  const mainAnalysis = graph.analyze(join(root, "examples/advanced/main.advanced"));
  const mainDoc = advanced.typescript!(mainAnalysis.ir as AdvancedModule).text;
  assert.match(mainDoc, /declare const main: number;\nexport default main;/);
});

test("advanced reports exports TypeScript cannot represent", () => {
  const flagged = "import \"./stdlib.advanced\"; let flagged = fn(record) => { flag = true | record } in { flagged = flagged }";
  const flaggedAnalysis = analyzeSource(flagged, "flagged.advanced");
  assert.match(
    flaggedAnalysis.diagnostics.map((entry) => entry.message).join("\n"),
    /TypeScript cannot represent flagged: a record row that must lack flag/,
  );

  const empty = "import \"./stdlib.advanced\"; let empty = Nil in { empty = empty }";
  const emptyAnalysis = analyzeSource(empty, "empty.advanced");
  assert.match(
    emptyAnalysis.diagnostics.map((entry) => entry.message).join("\n"),
    /TypeScript cannot represent empty: a polymorphic value that is not a function/,
  );

  const result = "import \"./stdlib.advanced\"; let empty = Nil in empty";
  const resultAnalysis = analyzeSource(result, "result.advanced");
  assert.match(
    resultAnalysis.diagnostics.map((entry) => entry.message).join("\n"),
    /TypeScript cannot represent the module result: a polymorphic value that is not a function/,
  );
});

test("advanced records definitions, references, and inferred spans", () => {
  const source = [
    "type Option(a) = None | Some(a)",
    "let map = fn(option: Option(number)) =>",
    "  match option { None => 0, Some(value) => value } in",
    "map(Some(3))",
  ].join("\n");
  const analysis = analyze(advanced, source, "memory://advanced/facts.advanced");
  assert.deepEqual(analysis.diagnostics, []);
  const names = analysis.facts.definitions.map((definition) => definition.name);
  for (const name of ["Option", "None", "Some", "map", "option", "value"]) assert.ok(names.includes(name), name);
  assert.ok(analysis.facts.references.length > 0);
  assert.ok(analysis.facts.types.length > 0);
  const hover = analysis.facts.types.find((entry) => source.slice(entry.span.start, entry.span.end) === "map");
  assert.ok(hover);
  assert.match(advanced.show!(hover.type), /Option\(number\)/);
});

test("advanced runs the upstream program through the Node loader", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "./examples/register.ts", "examples/typescript/advanced.ts"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "The answer is:\n49\n49 10 20 2 20 true 7\n");
});

test("shared-prefix alternatives parse in linear time", () => {
  const source = "let a = 1 in ".repeat(25) + "a\n";
  const start = performance.now();
  const result = advanced.grammar.parse(source);
  const elapsed = performance.now() - start;
  assert.equal(result.diagnostics.length, 0);
  assert.ok(elapsed < 50, `25 nested lets took ${elapsed.toFixed(1)}ms`);
});
