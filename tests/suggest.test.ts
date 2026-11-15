import assert from "node:assert/strict";
import test from "node:test";
import { closest } from "../src/check/index.ts";

test("closest finds a likely typo and nothing for a stranger", () => {
  assert.equal(closest("totl", ["total", "count", "x"]), "total");
  assert.equal(closest("Count", ["count"]), "count");
  assert.equal(closest("zzzzzz", ["total", "count"]), undefined);
  assert.equal(closest("ab", ["cd"]), undefined);
  assert.equal(closest("total", ["total"]), undefined);
});
