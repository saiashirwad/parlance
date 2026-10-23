import assert from "node:assert/strict";
import test from "node:test";

import { printType, type Type, TypeStore } from "../src/types/index.ts";

const numberType: Type = { kind: "number" };
const booleanType: Type = { kind: "boolean" };
const stringType: Type = { kind: "string" };
const neverType: Type = { kind: "never" };

const variableId = (type: Type): number => {
  assert.equal(type.kind, "variable");
  return type.kind === "variable" ? type.id : -1;
};

const prng = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const generate = (store: TypeStore, random: () => number, depth = 0): Type => {
  const pick = (limit: number): number => Math.floor(random() * limit);
  const leaves: Type[] = [
    store.fresh(),
    store.unknown(),
    neverType,
    numberType,
    booleanType,
    stringType,
    store.literal(pick(3) === 0 ? "s" : pick(10)),
    store.literal(pick(2) === 0),
  ];
  if (depth >= 3) return leaves[pick(leaves.length)]!;
  switch (pick(10)) {
    case 0:
    case 1:
      return leaves[pick(leaves.length)]!;
    case 2:
      return store.array(generate(store, random, depth + 1));
    case 3:
    case 4: {
      const fields: Record<string, Type> = {};
      const count = pick(3);
      for (let index = 0; index < count; index++) {
        fields[String.fromCharCode(97 + index)] = generate(store, random, depth + 1);
      }
      return store.record(fields, pick(2) === 0);
    }
    case 5:
    case 6:
      return store.function(
        generate(store, random, depth + 1),
        generate(store, random, depth + 1),
      );
    case 7:
      return store.union([
        generate(store, random, depth + 1),
        generate(store, random, depth + 1),
        generate(store, random, depth + 1),
      ]);
    default:
      return store.ref(pick(2) === 0 ? "Box" : "Pair", [generate(store, random, depth + 1)]);
  }
};

test("unification success and failure matrix", () => {
  const store = new TypeStore();
  assert.equal(store.unify(numberType, numberType), true);
  assert.equal(store.unify(numberType, stringType), false);
  assert.equal(store.unify(numberType, booleanType), false);
  assert.equal(store.unify(stringType, booleanType), false);
  assert.equal(store.unify(store.array(numberType), store.array(numberType)), true);
  assert.equal(store.unify(store.array(numberType), store.array(stringType)), false);
  assert.equal(store.unify(store.array(numberType), store.function(numberType, numberType)), false);
  assert.equal(store.unify(store.function(numberType, numberType), store.function(numberType, numberType)), true);
  assert.equal(store.unify(store.function(numberType, numberType), store.function(numberType, stringType)), false);
  assert.equal(store.unify(store.function(numberType, numberType), store.function(stringType, numberType)), false);
  assert.equal(store.unify(store.ref("Box", [numberType]), store.ref("Box", [numberType])), true);
  assert.equal(store.unify(store.ref("Box", [numberType]), store.ref("Box", [stringType])), false);
  assert.equal(store.unify(store.ref("Box", [numberType]), store.ref("Bag", [numberType])), false);
  assert.equal(store.unify(store.ref("Box"), store.ref("Box", [numberType])), false);
  assert.equal(store.unify(store.unknown(), store.ref("Box", [stringType])), true);
  assert.equal(store.unify(neverType, neverType), true);
  assert.equal(store.unify(neverType, numberType), false);
});

test("literal unifies with its base primitive only", () => {
  const store = new TypeStore();
  const one = store.literal(1);
  assert.equal(store.unify(one, store.literal(1)), true);
  assert.equal(store.unify(one, store.literal(2)), false);
  assert.equal(store.unify(one, numberType), true);
  assert.equal(store.unify(numberType, one), true);
  assert.equal(store.unify(store.literal("a"), stringType), true);
  assert.equal(store.unify(store.literal(true), booleanType), true);
  assert.equal(store.unify(store.literal(true), store.literal(false)), false);
  assert.equal(store.unify(store.literal(1), store.literal("1")), false);
  assert.equal(store.unify(store.literal("a"), numberType), false);
});

test("variables stay free when only unified with unknown", () => {
  const store = new TypeStore();
  const variable = store.fresh();
  const id = variableId(variable);
  assert.equal(store.unify(variable, store.unknown()), true);
  assert.equal(store.prune(variable).kind, "variable");
  assert.deepEqual(store.free(variable), [id]);
});

test("a variable unifies with a union by linking to the whole union", () => {
  const store = new TypeStore();
  const variable = store.fresh();
  const union = store.union([numberType, stringType]);
  assert.equal(store.unify(variable, union), true);
  assert.equal(store.prune(variable).kind, "union");
  assert.deepEqual(store.free(variable), []);
});

test("record unification covers closed and open fields", () => {
  const store = new TypeStore();
  const closed = store.record({ a: numberType, b: stringType });
  assert.equal(store.unify(closed, store.record({ a: numberType, b: stringType })), true);
  assert.equal(store.unify(closed, store.record({ a: numberType })), false);
  assert.equal(store.unify(closed, store.record({ a: numberType, b: stringType, c: booleanType })), false);
  assert.equal(store.unify(closed, store.record({ a: numberType, b: booleanType })), false);

  const shortOpen = store.record({ a: numberType }, true);
  const longClosed = store.record({ a: numberType, b: stringType });
  assert.equal(store.unify(shortOpen, longClosed), true);
  assert.equal(store.unify(longClosed, shortOpen), true);
  assert.equal(store.unify(closed, shortOpen), true);
  assert.equal(store.unify(store.record({ a: numberType, b: stringType }, true), store.record({ a: numberType })), false);
  assert.equal(store.unify(store.record({ a: numberType }, true), store.record({ b: stringType }, true)), true);
  assert.equal(store.unify(store.record({ a: numberType }, true), store.record({ a: numberType })), true);
});

test("records copy their fields and never mutate them", () => {
  const store = new TypeStore();
  const fields: Record<string, Type> = { a: numberType };
  const record = store.record(fields);
  fields.b = stringType;
  assert.equal(record.kind, "record");
  if (record.kind !== "record") return;
  assert.equal(record.fields.size, 1);
  assert.equal(record.fields.get("a"), numberType);
  const before = record.fields;
  assert.equal(store.unify(record, store.record({ a: stringType })), false);
  assert.equal(record.fields, before);
  assert.deepEqual([...record.fields.keys()], ["a"]);
});

test("failed union members leave no variable links", () => {
  const store = new TypeStore();
  const variable = store.fresh();
  const id = variableId(variable);
  const rejected = store.union([
    store.function(stringType, stringType),
    store.function(booleanType, stringType),
  ]);
  const value = store.function(variable, numberType);
  assert.equal(store.unify(value, rejected), false);
  assert.equal(store.prune(variable).kind, "variable");
  assert.deepEqual(store.free(value), [id]);
});

test("a later union member succeeds after an earlier one rolls back", () => {
  const store = new TypeStore();
  const variable = store.fresh();
  const accepted = store.union([
    store.function(stringType, stringType),
    store.function(numberType, numberType),
  ]);
  assert.equal(store.unify(store.function(variable, numberType), accepted), true);
  assert.equal(store.prune(variable).kind, "number");
  assert.deepEqual(store.free(variable), []);
});

test("snapshots nest and restore only their own links", () => {
  const store = new TypeStore();
  const a = store.fresh();
  const b = store.fresh();
  const outer = store.snapshot();
  store.link(a, numberType);
  const inner = store.snapshot();
  store.link(b, stringType);
  assert.equal(store.prune(a).kind, "number");
  assert.equal(store.prune(b).kind, "string");
  inner();
  assert.equal(store.prune(a).kind, "number");
  assert.equal(store.prune(b).kind, "variable");
  outer();
  assert.equal(store.prune(a).kind, "variable");
  assert.equal(store.prune(b).kind, "variable");
});

test("occur check blocks direct and indirect cycles", () => {
  const store = new TypeStore();
  const direct = store.fresh();
  store.link(direct, store.array(direct));
  assert.equal(store.prune(direct).kind, "variable");
  assert.equal(store.unify(direct, store.array(direct)), false);

  const x = store.fresh();
  const y = store.fresh();
  assert.equal(store.unify(x, store.array(y)), true);
  assert.equal(store.unify(y, x), false);
  assert.deepEqual(store.free(x), [variableId(y)]);
});

test("linking the same variable is a no-op", () => {
  const store = new TypeStore();
  const variable = store.fresh();
  store.link(variable, variable);
  assert.equal(store.prune(variable).kind, "variable");
  assert.deepEqual(store.free(variable), [variableId(variable)]);
});

test("free returns sorted, deduplicated variable ids", () => {
  const store = new TypeStore();
  const first = store.fresh();
  const second = store.fresh();
  const type = store.record({ z: second, a: first, again: first });
  assert.deepEqual(store.free(type), [variableId(first), variableId(second)]);
  assert.deepEqual(store.free(store.union([second, second, first])), [variableId(first), variableId(second)]);
  assert.deepEqual(store.free(numberType), []);
});

test("show prints TypeScript syntax", () => {
  const store = new TypeStore();
  assert.equal(store.show(numberType), "number");
  assert.equal(store.show(booleanType), "boolean");
  assert.equal(store.show(stringType), "string");
  assert.equal(store.show(store.unknown()), "unknown");
  assert.equal(store.show(neverType), "never");
  assert.equal(store.show(store.literal('a"b')), '"a\\"b"');
  assert.equal(store.show(store.literal(42)), "42");
  assert.equal(store.show(store.literal(true)), "true");
  assert.equal(store.show(store.array(numberType)), "readonly number[]");
  assert.equal(store.show(store.array(store.union([numberType, stringType]))), "readonly (number | string)[]");
  assert.equal(store.show(store.array(store.array(numberType))), "readonly (readonly number[])[]");
  assert.equal(store.show(store.record({ a: numberType, b: stringType })), "{ readonly a: number; readonly b: string }");
  assert.equal(
    store.show(store.record({ a: numberType }, true)),
    "{ readonly a: number } & Record<string, unknown>",
  );
  assert.equal(store.show(store.record({}, true)), "Record<string, unknown>");
  assert.equal(store.show(store.record({}, false)), "{}");
  assert.equal(store.show(store.function(numberType, stringType)), "(x: number) => string");
  assert.equal(
    store.show(store.union([store.function(numberType, stringType), booleanType])),
    "((x: number) => string) | boolean",
  );
  assert.equal(store.show(store.ref("Box", [numberType])), "Box<number>");
  assert.equal(store.show(store.ref("Box")), "Box");
});

test("show names unbound variables deterministically per call", () => {
  const store = new TypeStore();
  const first = store.fresh();
  const second = store.fresh();
  assert.equal(store.show(store.function(first, second)), "(x: A) => B");
  assert.equal(store.show(store.record({ a: second, b: first })), "{ readonly a: A; readonly b: B }");
  assert.equal(store.show(store.function(first, second)), "(x: A) => B");
});

test("show follows links", () => {
  const store = new TypeStore();
  const variable = store.fresh();
  store.link(variable, store.union([numberType, stringType]));
  assert.equal(store.show(store.array(variable)), "readonly (number | string)[]");
});

test("printType reports only the open empty record as unrepresentable", () => {
  const store = new TypeStore();
  assert.deepEqual(printType(store.record({ a: numberType })), {
    text: "{ readonly a: number }",
    problem: undefined,
  });
  const empty = printType(store.record({}, true));
  assert.equal(empty.text, "Record<string, unknown>");
  assert.ok(empty.problem);
  const nested = printType(store.array(store.record({}, true)));
  assert.equal(nested.text, "readonly Record<string, unknown>[]");
  assert.ok(nested.problem);
});

test("generated types show safely, keep free ids sorted, and unify reflexively", () => {
  const random = prng(0x5eed);
  const store = new TypeStore();
  for (let index = 0; index < 150; index++) {
    const type = generate(store, random);
    const printed = store.show(type);
    assert.ok(printed.length > 0);
    const ids = store.free(type);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(store.unify(store.prune(type), store.prune(type)), true);
  }
});

test("unify agrees in both directions for generated pairs", () => {
  const random = prng(0xc0ffee);
  const store = new TypeStore();
  for (let index = 0; index < 120; index++) {
    const left = generate(store, random);
    const right = generate(store, random);
    const restore = store.snapshot();
    const forward = store.unify(left, right);
    restore();
    const backward = store.unify(right, left);
    restore();
    assert.equal(forward, backward);
  }
});
