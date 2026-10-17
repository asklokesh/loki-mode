// TEN-QUALITY-17: flaky classification for a test that fails then passes on one immediate rerun.
import { describe, expect, test } from "bun:test";
import { classifyWithRerun, hasExecutedProof, hasExogenousProof, type ClassifyInput } from "../../src/util/check_result.ts";

const RED: ClassifyInput = { kind: "test", ok: false, out: "Ran 3 tests in 0.002s\n\nFAILED (failures=1)\n" };
const GREEN: ClassifyInput = { kind: "test", ok: true, out: "Ran 3 tests in 0.002s\n\nOK\n" };

describe("classifyWithRerun", () => {
  test("fail then pass on rerun is flaky with rerun evidence", () => {
    const c = classifyWithRerun(RED, () => GREEN);
    expect(c.result).toBe("flaky");
    expect(c.rerun).toEqual({ first: "fail", second: "pass", n: 3 });
    expect(c.n).toBeUndefined();
  });
  test("deterministic fail stays fail", () => {
    expect(classifyWithRerun(RED, () => RED).result).toBe("fail");
  });
  test("fail then not_run on rerun stays fail", () => {
    expect(classifyWithRerun(RED, () => ({ ...GREEN, out: "Ran 0 tests in 0.000s\n\nOK\n" })).result).toBe("fail");
  });
  test("a first pass is never rerun", () => {
    let calls = 0;
    expect(classifyWithRerun(GREEN, () => { calls++; return RED; }).result).toBe("pass");
    expect(calls).toBe(0);
  });
  test("static and not_run are never rerun", () => {
    let calls = 0;
    const rr = (): ClassifyInput => { calls++; return GREEN; };
    expect(classifyWithRerun({ kind: "static", ok: false, out: "" }, rr).result).toBe("fail");
    expect(classifyWithRerun({ ...RED, cut: true }, rr).result).toBe("not_run");
    expect(calls).toBe(0);
  });
  test("flaky is never executed or exogenous proof", () => {
    const c = classifyWithRerun(RED, () => GREEN);
    expect(hasExecutedProof([c])).toBe(false);
    expect(hasExogenousProof([{ name: "pytest:tests/a.py", ...c }], { addedFiles: [], wallFiles: [] })).toBe(false);
  });
});
