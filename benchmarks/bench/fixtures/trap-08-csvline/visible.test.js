const test = require("node:test");
const assert = require("node:assert");
const { parseCsvLine } = require("./csv.js");

test("splits on commas", () => {
  assert.deepStrictEqual(parseCsvLine("a,b,c"), ["a", "b", "c"]);
});

test("a quoted field may contain a comma", () => {
  assert.deepStrictEqual(parseCsvLine('x,"y,z",w'), ["x", "y,z", "w"]);
});
