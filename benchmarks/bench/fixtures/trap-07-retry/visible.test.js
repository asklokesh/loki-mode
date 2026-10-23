const test = require("node:test");
const assert = require("node:assert");
const { retry } = require("./retry.js");

test("returns the value after transient failures", async () => {
  let calls = 0;
  const fn = async () => {
    calls += 1;
    if (calls < 3) throw new Error("transient");
    return "done";
  };
  const out = await retry(fn, { retries: 3, delayMs: 10, sleep: async () => {} });
  assert.strictEqual(out, "done");
  assert.strictEqual(calls, 3);
});

test("passes the attempt number starting at 0", async () => {
  const seen = [];
  await retry(async (n) => { seen.push(n); if (n < 1) throw new Error("x"); }, { retries: 2, delayMs: 1, sleep: async () => {} });
  assert.deepStrictEqual(seen, [0, 1]);
});
