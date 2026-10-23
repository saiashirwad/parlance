import test from "node:test";
import assert from "node:assert/strict";

import { span, type Span } from "../src/source.ts";
import {
  atom,
  doc,
  empty,
  feature,
  join,
  line,
  mapped,
  ts,
  verbatim,
  type Mapping,
  type TsDoc,
  type TsNode,
} from "../src/ts/template.ts";
import { typeText, type TsType } from "../src/ts/type.ts";

test("nested templates produce an exact interface snapshot", () => {
  const member = (name: string, at: Span, type: TsType): TsDoc =>
    ts`  readonly ${mapped(name, at)}: ${typeText(type)};`;
  const members = [
    member("x", span(30, 31), { kind: "ref", name: "number" }),
    member("y", span(40, 41), { kind: "ref", name: "number" }),
  ];
  const result = ts`export interface ${verbatim("Point", span(10, 15))} {
${join(members, "\n")}
}
`;
  assert.equal(result.text, "export interface Point {\n  readonly x: number;\n  readonly y: number;\n}\n");
  assert.deepEqual(result.mappings, [
    [17, 5, 10, 5, 0],
    [36, 1, 30, 1, 1, feature.atom],
    [58, 1, 40, 1, 1, feature.atom],
  ]);
});

test("doc is an alias for ts", () => {
  assert.equal(doc, ts);
});

test("mappings carry virtual and original coordinates", () => {
  const result = ts`export interface ${verbatim("Point", span(100, 105))} { ${atom("x", span(200, 201))} }`;
  assert.equal(result.text, "export interface Point { x }");
  assert.deepEqual(result.mappings, [
    [17, 5, 100, 5, 0],
    [25, 1, 200, 1, 1, feature.atom],
  ]);
});

test("mapped defaults to an atom and explicit features win", () => {
  assert.deepEqual(ts`${mapped("x", span(5, 6))}`.mappings, [[0, 1, 5, 1, 1, feature.atom]]);
  assert.deepEqual(ts`${atom("x", span(5, 6), 1 | 8 | 64)}`.mappings, [[0, 1, 5, 1, 1, 73]]);
  assert.deepEqual(ts`${atom("x", span(5, 6), 0)}`.mappings, [[0, 1, 5, 1, 1, 0]]);
  assert.deepEqual(ts`${verbatim("x", span(5, 6))}`.mappings, [[0, 1, 5, 1, 0]]);
});

test("verbatim rejects a length mismatch", () => {
  assert.throws(() => verbatim("abc", span(0, 2)), RangeError);
  assert.throws(() => verbatim("\u{1f600}", span(0, 1)), /UTF-16/);
  assert.throws(() => ts`${verbatim("abc", span(0, 2))}`, RangeError);
});

test("arrays flatten in order and empty nodes disappear", () => {
  const a = atom("a", span(10, 11));
  const b = verbatim("b", span(20, 21));
  const result = ts`${["x", [a, null, false, undefined], b]}y`;
  assert.equal(result.text, "xaby");
  assert.deepEqual(result.mappings, [
    [1, 1, 10, 1, 1, feature.atom],
    [2, 1, 20, 1, 0],
  ]);
});

test("numbers and true are text; false is empty", () => {
  const result = ts`a${true}b${false}c${0}d${1.5}`;
  assert.equal(result.text, "atruebc0d1.5");
  assert.deepEqual(result.mappings, []);
});

test("join, line, and empty", () => {
  assert.equal(join(["a", "b"]).text, "ab");
  assert.equal(join(["a", "b"], ", ").text, "a, b");
  assert.equal(join([]).text, "");
  assert.equal(line("a").text, "a\n");
  assert.equal(line(["a", "b"]).text, "ab\n");
  assert.deepEqual(empty, { text: "", mappings: [] });
  assert.equal(ts`${empty}`.text, "");
  assert.deepEqual(join([atom("a", span(0, 1)), atom("b", span(1, 2))], "\n").mappings, [
    [0, 1, 0, 1, 1, feature.atom],
    [2, 1, 1, 1, 1, feature.atom],
  ]);
});

test("a mapping after a nested doc is shifted", () => {
  const inner = ts`c${atom("d", span(50, 51))}`;
  const result = ts`a${atom("b", span(10, 11))}${inner}e`;
  assert.equal(result.text, "abcde");
  assert.deepEqual(result.mappings, [
    [1, 1, 10, 1, 1, feature.atom],
    [3, 1, 50, 1, 1, feature.atom],
  ]);
});

test("mappings after a newline land on the right virtual offset", () => {
  const result = ts`first line
second ${atom("x", span(0, 1))}
third ${verbatim("y", span(2, 3))}`;
  const firstNewline = result.text.indexOf("\n");
  const secondNewline = result.text.indexOf("\n", firstNewline + 1);
  assert.equal(result.text.slice(firstNewline + 1, secondNewline), "second x");
  assert.equal(result.mappings[0]![0], firstNewline + 1 + "second ".length);
  assert.equal(result.mappings[1]![0], result.text.indexOf("y"));
  assert.equal(result.mappings[1]![0], secondNewline + 1 + "third ".length);
});

test("lengths are UTF-16", () => {
  assert.equal("\u{1f600}".length, 2);
  const result = ts`${atom("\u{1f600}", span(10, 12))}!${verbatim("\u{1f600}", span(20, 22))}`;
  assert.equal(result.text, "\u{1f600}!\u{1f600}");
  assert.equal(result.text.length, 5);
  assert.deepEqual(result.mappings, [
    [0, 2, 10, 2, 1, feature.atom],
    [3, 2, 20, 2, 0],
  ]);
});

test("typeText parenthesization matrix", () => {
  const text = (value: string): TsType => ({ kind: "text", text: value });
  const number = text("number");
  const string = text("string");
  const union: TsType = { kind: "union", members: [number, string] };
  const fn: TsType = { kind: "function", params: [{ name: "value", type: number }], result: string };

  assert.equal(typeText(number), "number");
  assert.equal(typeText(union), "number | string");
  assert.equal(typeText({ kind: "array", element: number }), "readonly number[]");
  assert.equal(typeText({ kind: "array", element: number, readonly: false }), "number[]");
  assert.equal(typeText({ kind: "array", element: union }), "readonly (number | string)[]");
  assert.equal(typeText({ kind: "array", element: union, readonly: false }), "(number | string)[]");
  assert.equal(typeText(fn), "(value: number) => string");
  assert.equal(typeText({ kind: "union", members: [fn, text("null")] }), "((value: number) => string) | null");
  assert.equal(typeText({ kind: "array", element: fn }), "readonly ((value: number) => string)[]");
  assert.equal(
    typeText({ kind: "function", params: [{ name: "value", type: union }, { name: "count", type: number, optional: true }], result: number }),
    "(value: number | string, count?: number) => number",
  );
  assert.equal(typeText({ kind: "function", params: [], result: union }), "() => number | string");
  assert.equal(
    typeText({ kind: "array", element: { kind: "array", element: number } }),
    "readonly (readonly number[])[]",
  );
  assert.equal(
    typeText({ kind: "array", element: { kind: "array", element: number, readonly: false } }),
    "readonly number[][]",
  );
});

test("typeText records, tuples, refs, and literals", () => {
  const text = (value: string): TsType => ({ kind: "text", text: value });
  const number = text("number");
  const string = text("string");
  const fn: TsType = { kind: "function", params: [{ name: "value", type: number }], result: string };

  assert.equal(
    typeText({
      kind: "record",
      fields: [
        { name: "a", type: number, readonly: true },
        { name: "b", type: string, optional: true },
      ],
    }),
    "{ readonly a: number; b?: string }",
  );
  assert.equal(typeText({ kind: "record", fields: [] }), "{}");
  assert.equal(
    typeText({ kind: "record", fields: [{ name: "f", type: fn }, { name: "c", type: string, optional: true, readonly: true }] }),
    "{ f: (value: number) => string; readonly c?: string }",
  );
  assert.equal(typeText({ kind: "tuple", elements: [number, fn] }), "[number, (value: number) => string]");
  assert.equal(typeText({ kind: "tuple", elements: [] }), "[]");
  assert.equal(typeText({ kind: "ref", name: "Map", args: [string, number] }), "Map<string, number>");
  assert.equal(typeText({ kind: "ref", name: "Foo" }), "Foo");
  assert.equal(typeText({ kind: "ref", name: "Foo", args: [] }), "Foo");
  assert.equal(typeText({ kind: "literal", value: 1 }), "1");
  assert.equal(typeText({ kind: "literal", value: false }), "false");
  assert.equal(typeText({ kind: "literal", value: 'a"b\\c\n' }), JSON.stringify('a"b\\c\n'));
});

const random = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const integer = (next: () => number, minimum: number, maximum: number): number =>
  minimum + Math.floor(next() * (maximum - minimum + 1));

const choose = <T>(next: () => number, values: readonly T[]): T =>
  values[integer(next, 0, values.length - 1)]!;

const safeText = ["number", "string", "boolean", "unknown", "never", "void", "Date", "A", "B"] as const;

const genType = (next: () => number, depth: number): TsType => {
  const kinds =
    depth === 0
      ? (["text", "ref", "literal", "empty-record", "empty-tuple"] as const)
      : (["text", "ref", "array", "union", "record", "function", "literal", "tuple"] as const);
  switch (choose(next, kinds)) {
    case "text":
      return { kind: "text", text: choose(next, safeText) };
    case "ref": {
      const arity = depth === 0 ? 0 : integer(next, 0, 2);
      const args = Array.from({ length: arity }, () => genType(next, depth - 1));
      const name = choose(next, ["Foo", "Map", "Result"] as const);
      return args.length === 0 ? { kind: "ref", name } : { kind: "ref", name, args };
    }
    case "array": {
      const element = genType(next, depth - 1);
      return next() < 0.5 ? { kind: "array", element } : { kind: "array", element, readonly: false };
    }
    case "union":
      return {
        kind: "union",
        members: Array.from({ length: integer(next, 2, 4) }, () => genType(next, depth - 1)),
      };
    case "record":
      return {
        kind: "record",
        fields: Array.from({ length: integer(next, 0, 3) }, (_, index) => {
          const type = genType(next, depth - 1);
          const optional = next() < 0.4 ? { optional: true } : {};
          const readonly = next() < 0.4 ? { readonly: true } : {};
          return { name: `f${index}`, type, ...optional, ...readonly };
        }),
      };
    case "function":
      return {
        kind: "function",
        params: Array.from({ length: integer(next, 0, 3) }, (_, index) => {
          const type = genType(next, depth - 1);
          return { name: `p${index}`, type, ...(next() < 0.4 ? { optional: true } : {}) };
        }),
        result: genType(next, depth - 1),
      };
    case "literal": {
      const values = ["a", 'quote"back\\slash', "\u{1f600}", 0, -1, 3.5, true, false] as const;
      return { kind: "literal", value: choose(next, values) };
    }
    case "tuple":
      return {
        kind: "tuple",
        elements: Array.from({ length: integer(next, 0, 3) }, () => genType(next, depth - 1)),
      };
    case "empty-record":
      return { kind: "record", fields: [] };
    case "empty-tuple":
      return { kind: "tuple", elements: [] };
  }
};

const closers: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}" };

const balanced = (source: string): boolean => {
  const stack: string[] = [];
  let quote: string | null = null;
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    if (quote !== null) {
      if (character === "\\") index++;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(" || character === "[" || character === "{") stack.push(character);
    else if (character === ")" || character === "]" || character === "}") {
      const open = stack.pop();
      if (open === undefined || closers[open] !== character) return false;
    }
  }
  return quote === null && stack.length === 0;
};

test("property: typeText is deterministic and structurally balanced", () => {
  const next = random(0x5eed);
  for (let iteration = 0; iteration < 250; iteration++) {
    const type = genType(next, 4);
    const text = typeText(type);
    assert.equal(typeof text, "string");
    assert.equal(typeText(type), text);
    assert.ok(balanced(text), `unbalanced: ${text}`);
    assert.ok(!text.includes("readonly readonly"), `duplicate readonly: ${text}`);
  }
});

type Segment =
  | { readonly kind: "string"; readonly text: string }
  | { readonly kind: "atom"; readonly text: string; readonly span: Span; readonly features: number | undefined }
  | { readonly kind: "nested"; readonly segments: readonly Segment[] };

const rawTexts = ["", " ", "\n", "const ", ";", "/* x */", "\u{1f600}", "\u03bb", "=>"] as const;
const atomTexts = ["", "a", "bc", "x1", "\u{1f600}", "=", " ", "\n"] as const;
const featureChoices = [undefined, 0, 1, 8, 64, 73, 7] as const;

const genSegments = (next: () => number, depth: number): Segment[] =>
  Array.from({ length: integer(next, 0, 5) }, () => {
    const choice = depth === 0 ? integer(next, 0, 1) : integer(next, 0, 2);
    if (choice === 0) return { kind: "string", text: choose(next, rawTexts) };
    if (choice === 1) {
      const text = choose(next, atomTexts);
      const originalStart = integer(next, 0, 500);
      const originalLength =
        next() < 0.1 ? text.length + integer(next, 1, 3) : text.length;
      return {
        kind: "atom",
        text,
        span: span(originalStart, originalStart + originalLength),
        features: choose(next, featureChoices),
      };
    }
    return { kind: "nested", segments: genSegments(next, depth - 1) };
  });

const nodeOf = (segment: Segment): TsNode => {
  switch (segment.kind) {
    case "string":
      return segment.text;
    case "atom":
      return segment.features === undefined
        ? atom(segment.text, segment.span)
        : atom(segment.text, segment.span, segment.features);
    case "nested":
      return ts`${segment.segments.map(nodeOf)}`;
  }
};

const flatten = (segments: readonly Segment[]): TsDoc => {
  const parts: string[] = [];
  const mappings: Mapping[] = [];
  let length = 0;
  const walk = (nodes: readonly Segment[]): void => {
    for (const node of nodes) {
      if (node.kind === "string") {
        parts.push(node.text);
        length += node.text.length;
      } else if (node.kind === "atom") {
        mappings.push([
          length,
          node.text.length,
          node.span.start,
          node.span.end - node.span.start,
          1,
          node.features ?? feature.atom,
        ]);
        parts.push(node.text);
        length += node.text.length;
      } else {
        walk(node.segments);
      }
    }
  };
  walk(segments);
  return { text: parts.join(""), mappings };
};

test("property: template mappings match an independent flattening", () => {
  const next = random(0xc0ffee);
  for (let iteration = 0; iteration < 300; iteration++) {
    const segments = genSegments(next, 3);
    const actual = ts`${segments.map(nodeOf)}`;
    const wanted = flatten(segments);
    assert.equal(actual.text, wanted.text);
    assert.deepEqual(actual.mappings, wanted.mappings);

    let previousEnd = 0;
    for (const [start, length, originalStart, originalLength] of actual.mappings) {
      assert.ok(start >= previousEnd, "mappings must be ordered");
      assert.ok(start >= 0 && start + length <= actual.text.length, "mapping must be in bounds");
      assert.ok(originalStart >= 0 && originalLength >= 0, "original mapping must be in bounds");
      previousEnd = start + length;
    }
  }
});
