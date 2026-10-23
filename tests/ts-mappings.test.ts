import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { analyze, type AnyLanguage } from "../src/language.ts";
import type { Mapping, TsDoc } from "../src/ts/template.ts";
import { calc } from "../examples/calc/calc.ts";
import { schema } from "../examples/schema/schema.ts";
import { machine } from "../examples/machine/machine.ts";

const load = (relative: string): string => readFileSync(new URL(relative, import.meta.url), "utf8");

const checkDoc = (name: string, source: string, doc: TsDoc): number => {
  let previousEnd = 0;
  for (const [virtualStart, virtualLength, originalStart, originalLength, kind] of doc.mappings as readonly Mapping[]) {
    const where = `${name}: mapping ${JSON.stringify([virtualStart, virtualLength, originalStart, originalLength, kind])}`;
    assert.ok(virtualStart >= 0 && virtualLength >= 0, `${where} has a negative virtual range`);
    assert.ok(originalStart >= 0 && originalLength >= 0, `${where} has a negative original range`);
    assert.ok(virtualStart + virtualLength <= doc.text.length, `${where} exceeds the generated text`);
    assert.ok(originalStart + originalLength <= source.length, `${where} exceeds the guest source`);
    assert.ok(virtualStart >= previousEnd, `${where} overlaps the previous mapping`);
    if (kind === 0) {
      assert.equal(virtualLength, originalLength, `${where} is verbatim but its lengths differ`);
      assert.equal(
        doc.text.slice(virtualStart, virtualStart + virtualLength),
        source.slice(originalStart, originalStart + originalLength),
        `${where} is verbatim but the text differs from the guest source`,
      );
    } else {
      assert.equal(kind, 1, `${where} has an unknown kind`);
    }
    previousEnd = virtualStart + virtualLength;
  }
  return doc.mappings.length;
};

const surface = (name: string, language: AnyLanguage, source: string): number => {
  const analysis = analyze(language, source, `memory://${name}`);
  assert.equal(analysis.valid, true, `${name}: ${analysis.diagnostics.map((entry) => entry.message).join("; ")}`);
  assert.notEqual(analysis.ir, null, `${name} produced no IR`);
  assert.ok(language.typescript, `${name} has no TypeScript surface`);
  const doc = language.typescript(analysis.ir);
  assert.ok(doc.text.length > 0, `${name} produced empty TypeScript`);
  const count = checkDoc(name, source, doc);
  assert.ok(count > 0, `${name} produced no mappings`);
  return count;
};

test("example language surfaces have valid, verbatim-accurate mappings", () => {
  const counts = [
    surface("calc", calc, load("../examples/calc/demo.calc")),
    surface("schema", schema, load("../examples/schema/blog.schema")),
    surface("machine", machine, load("../examples/machine/order.machine")),
  ];
  assert.ok(counts.every((count) => count > 0));
});

const seeded = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const expression = (random: () => number, names: readonly string[], depth = 0): string => {
  if (depth >= 2 || random() < 0.4) {
    return random() < 0.5 && names.length > 0
      ? names[Math.floor(random() * names.length)]!
      : String(Math.floor(random() * 100));
  }
  const operator = ["+", "-", "*", "/"][Math.floor(random() * 4)]!;
  return `(${expression(random, names, depth + 1)} ${operator} ${expression(random, names, depth + 1)})`;
};

test("property: random calc programs keep every mapping inside its source", () => {
  const random = seeded(0x5eed);
  let mappings = 0;
  for (let index = 0; index < 60; index++) {
    const lines: string[] = [];
    const names: string[] = [];
    for (let line = 0; line < 4; line++) {
      const name = `v${index}_${line}`;
      lines.push(`let ${name} = ${expression(random, names)};`);
      names.push(name);
    }
    lines.push(`show ${expression(random, names)};`);
    const source = `${lines.join("\n")}\n`;
    mappings += surface(`calc property ${index}`, calc, source);
  }
  assert.ok(mappings > 100, `expected many mappings, saw ${mappings}`);
});

test("property: a broken source never produces mappings outside it", () => {
  const source = load("../examples/schema/blog.schema");
  const broken = source.replace("model User {", "model User {\n  broken: Nope");
  const analysis = analyze(schema, broken, "memory://broken.schema");
  assert.equal(analysis.valid, false);
  if (analysis.ir === null || !schema.typescript) return;
  checkDoc("broken schema", broken, schema.typescript(analysis.ir));
});
