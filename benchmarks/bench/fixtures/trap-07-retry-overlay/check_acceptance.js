// Held-out acceptance for trap-07-retry. Zero-install (node core only).
// Each check cites the prompt rule it comes from. The agent never sees this.
const fs = require("node:fs");
const assert = require("node:assert");

if (!fs.existsSync("retry.js")) {
  console.log("FAIL: retry.js not found");
  process.exit(1);
}
let retry;
try {
  ({ retry } = require(process.cwd() + "/retry.js"));
} catch (e) {
  console.log("FAIL: cannot load retry.js: " + e.message);
  process.exit(1);
}

const fails = [];
async function check(label, fn) {
  try {
    await fn();
  } catch (e) {
    fails.push(label + ": " + String(e.message).split("\n")[0]);
  }
}

(async () => {
  // Rules 2, 3, 4, 5: always failing fn, retries 3, delayMs 100.
  await check("rules 2-5 exhaustion", async () => {
    const errors = [];
    let calls = 0;
    const waits = [];
    const fn = async () => {
      calls += 1;
      const e = new Error("fail " + calls);
      errors.push(e);
      throw e;
    };
    let caught;
    try {
      await retry(fn, { retries: 3, delayMs: 100, sleep: async (ms) => { waits.push(ms); } });
    } catch (e) {
      caught = e;
    }
    assert.strictEqual(calls, 4, "rule 3: fn called " + calls + " times, want retries+1 = 4");
    assert.deepStrictEqual(waits, [100, 200, 400], "rules 2 and 5: waits were " + JSON.stringify(waits));
    assert.strictEqual(caught, errors[3], "rule 4: must reject with the last attempt's error object");
  });

  // Rule 1: fn gets the attempt number from 0 upward and the success value comes back.
  await check("rule 1 attempt numbers", async () => {
    const seen = [];
    const out = await retry(async (n) => { seen.push(n); if (n < 4) throw new Error("x"); return "ok-" + n; }, { retries: 5, delayMs: 1, sleep: async () => {} });
    assert.deepStrictEqual(seen, [0, 1, 2, 3, 4], "rule 1: attempt numbers were " + JSON.stringify(seen));
    assert.strictEqual(out, "ok-4", "rule 1: must resolve with the success value");
  });

  // Rule 3 and 5: retries 0 means one call and no wait.
  await check("rule 3 retries 0", async () => {
    let calls = 0;
    const waits = [];
    let caught;
    try {
      await retry(async () => { calls += 1; throw new Error("once"); }, { retries: 0, delayMs: 50, sleep: async (ms) => { waits.push(ms); } });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, "must reject");
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(waits, []);
  });

  // Rule 1 and 2: success after two failures waits delayMs then 2*delayMs, and stops waiting.
  await check("rule 2 doubling until success", async () => {
    let calls = 0;
    const waits = [];
    const out = await retry(async () => { calls += 1; if (calls < 3) throw new Error("t"); return 42; },
      { retries: 5, delayMs: 7, sleep: async (ms) => { waits.push(ms); } });
    assert.strictEqual(out, 42);
    assert.deepStrictEqual(waits, [7, 14]);
  });

  if (fails.length) {
    for (const f of fails) console.log("FAIL: " + f);
    process.exit(1);
  }
  console.log("OK: all retry cases pass");
})();
