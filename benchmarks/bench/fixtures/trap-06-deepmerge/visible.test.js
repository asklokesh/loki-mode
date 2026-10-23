const test = require("node:test");
const assert = require("node:assert");
const { deepMerge } = require("./merge.js");

test("merges nested plain objects, b wins on scalars", () => {
  assert.deepStrictEqual(
    deepMerge({ a: 1, n: { x: 1, y: 2 } }, { b: 2, n: { y: 3, z: 4 } }),
    { a: 1, b: 2, n: { x: 1, y: 3, z: 4 } }
  );
});

test("arrays from b replace arrays from a", () => {
  assert.deepStrictEqual(deepMerge({ l: [1, 2, 3] }, { l: [9] }), { l: [9] });
});
