// Held-out acceptance for trap-06-deepmerge. Zero-install (node core only).
// Each check cites the prompt rule it comes from. The agent never sees this.
const fs = require("node:fs");
const assert = require("node:assert");

if (!fs.existsSync("merge.js")) {
  console.log("FAIL: merge.js not found");
  process.exit(1);
}
let deepMerge;
try {
  ({ deepMerge } = require(process.cwd() + "/merge.js"));
} catch (e) {
  console.log("FAIL: cannot load merge.js: " + e.message);
  process.exit(1);
}

const fails = [];
function check(label, fn) {
  try {
    fn();
  } catch (e) {
    fails.push(label + ": " + e.message.split("\n")[0]);
  }
}

// Rule 3: inputs are not modified, and the result shares no nested object with them.
check("rule 3 inputs unchanged", () => {
  const a = { n: { x: 1 }, l: [1] };
  const b = { n: { y: 2 }, m: { k: 1 } };
  const aCopy = JSON.parse(JSON.stringify(a));
  const bCopy = JSON.parse(JSON.stringify(b));
  deepMerge(a, b);
  assert.deepStrictEqual(a, aCopy);
  assert.deepStrictEqual(b, bCopy);
});
check("rule 3 no sharing with a", () => {
  const a = { keep: { deep: { v: 1 } } };
  const r = deepMerge(a, { other: 1 });
  r.keep.deep.v = 99;
  assert.strictEqual(a.keep.deep.v, 1);
});
check("rule 3 no sharing with b", () => {
  const b = { add: { deep: { v: 1 } } };
  const r = deepMerge({}, b);
  r.add.deep.v = 99;
  assert.strictEqual(b.add.deep.v, 1);
});
check("rule 3 arrays not shared", () => {
  const b = { l: [{ v: 1 }] };
  const r = deepMerge({}, b);
  r.l[0].v = 99;
  assert.strictEqual(b.l[0].v, 1);
});

// Rule 4: a key named __proto__ in b is ignored; no prototype is changed.
check("rule 4 __proto__ ignored", () => {
  const b = JSON.parse('{"__proto__": {"polluted": "yes"}, "ok": 1}');
  const r = deepMerge({}, b);
  assert.strictEqual({}.polluted, undefined, "Object.prototype polluted");
  assert.strictEqual(r.polluted, undefined, "result inherited a polluted key");
  assert.strictEqual(Object.getPrototypeOf(r), Object.prototype);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(r, "__proto__"), false);
  assert.strictEqual(r.ok, 1);
});
check("rule 4 nested __proto__ ignored", () => {
  const b = JSON.parse('{"n": {"__proto__": {"deep": 1}}}');
  const r = deepMerge({ n: {} }, b);
  assert.strictEqual({}.deep, undefined);
  assert.strictEqual(r.n.deep, undefined);
});

// Rule 1: a null value from b replaces, and plain objects merge recursively.
check("rule 1 null replaces", () => {
  assert.deepStrictEqual(deepMerge({ n: { x: 1 } }, { n: null }), { n: null });
});

// Rule 2: arrays replace at any depth and are never concatenated.
check("rule 2 nested arrays replace", () => {
  assert.deepStrictEqual(deepMerge({ n: { l: [1, 2] } }, { n: { l: [3] } }), { n: { l: [3] } });
  assert.deepStrictEqual(deepMerge({ l: [1] }, { l: [2, 3] }), { l: [2, 3] });
  assert.deepStrictEqual(deepMerge({ l: [1] }, { l: [] }), { l: [] });
});

if (fails.length) {
  for (const f of fails) console.log("FAIL: " + f);
  process.exit(1);
}
console.log("OK: all deepMerge cases pass");
