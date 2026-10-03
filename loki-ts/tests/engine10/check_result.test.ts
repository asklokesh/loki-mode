// FC-16: a check that executed zero tests is NOT a pass. One shared classifier, every runner fixture, plus the verdict gate.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyCheck, hasExecutedProof, testCount } from "../../src/util/check_result.ts";
import { runCheck, type VerifyCheck } from "../../src/engine10/stages/verify.ts";
import { classify } from "../../src/engine10/stages/wall.ts";
import { verdictOf } from "../../src/engine10/stages/seal.ts";
import type { RunContext } from "../../src/engine10/types.ts";

const VITEST_NO_FILES = "\n No test files found, exiting with code 0\n";
const VITEST_FILES_ZERO = " Test Files  0 passed (0)\n      Duration  120ms\n";
const VITEST_REAL = " ✓ a.test.ts (3 tests) 4ms\n\n Test Files  1 passed (1)\n      Tests  3 passed (3)\n   Duration  300ms\n";
const PYTEST_NONE = "\nno tests ran in 0.01s\n";
const PYTEST_REAL = "...\n3 passed in 0.02s\n";
const JEST_NONE = "No tests found, exiting with code 0\n";
const GO_UNPARSED = "ok  \texample.com/pkg\t0.003s\n";
// Real captured output (go1.26, tiny module p with packages a (3 tests, 1 skipped), b (1), c (no test files)).
const GO_V = "=== RUN   TestA\n--- PASS: TestA (0.00s)\n=== RUN   TestB\n=== RUN   TestB/sub\n--- PASS: TestB (0.00s)\n    --- PASS: TestB/sub (0.00s)\n=== RUN   TestS\n    a_test.go:5: x\n--- SKIP: TestS (0.00s)\nPASS\nok  \tp/a\t0.070s\n";
const GO_NONV = "ok  \tp/a\t0.103s\n";
const GO_MULTI_V = GO_V + "=== RUN   TestC\n--- PASS: TestC (0.00s)\nPASS\nok  \tp/b\t0.096s\n?   \tp/c\t[no test files]\n";
const GO_ONLY_NOTEST = "?   \tp/c\t[no test files]\n";
const GO_FAIL_MULTI = "=== RUN   TestC\n    b_test.go:3: x\n--- FAIL: TestC (0.00s)\nFAIL\nFAIL\tp/b\t0.151s\n?   \tp/c\t[no test files]\nFAIL\n";
const GO_V_EMPTY_PKG = "testing: warning: no tests to run\nPASS\nok  \tp/e\t0.002s\n";
const CARGO_NONE = "running 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n";
const BUN_REAL = "bun test v1\n\n 2 pass\n 0 fail\n 2 expect() calls\nRan 2 tests across 1 file. [3.00ms]\n";
const MOCHA_REAL = "  3 passing (5ms)\n";
const MOCHA_NONE = "  0 passing (1ms)\n";

describe("testCount parses each supported runner", () => {
  test("zero", () => {
    for (const o of [VITEST_NO_FILES, VITEST_FILES_ZERO, PYTEST_NONE, JEST_NONE, CARGO_NONE, MOCHA_NONE]) expect(testCount(o)).toBe(0);
  });
  test("real counts", () => {
    expect(testCount(VITEST_REAL)).toBe(3);
    expect(testCount(PYTEST_REAL)).toBe(3);
    expect(testCount(GO_V)).toBe(2);
    expect(testCount(GO_MULTI_V)).toBe(3);
    expect(testCount(GO_FAIL_MULTI)).toBe(1);
    expect(testCount("python -m unittest\n..\n----------------------------------------------------------------------\nRan 2 tests in 0.001s\n\nOK\n")).toBe(2);
    expect(testCount("Running 3 tests using 1 worker\n\n  1 failed\n    [chromium] a.spec.ts:3\n  2 passed (2s)\n")).toBe(3);
    expect(testCount("\u001b[2m Test Files \u001b[22m \u001b[1m\u001b[32m1 passed\u001b[39m\u001b[22m (1)\n      \u001b[2mTests \u001b[22m \u001b[1m\u001b[32m3 passed\u001b[39m\u001b[22m (3)\n")).toBe(3);
    expect(testCount(MOCHA_REAL)).toBe(3);
    expect(testCount(BUN_REAL)).toBe(2);
  });
  test("unparsed is null, never zero or a pass", () => {
    expect(testCount(GO_UNPARSED)).toBeNull();
    expect(testCount(GO_NONV)).toBeNull();
    expect(testCount("whatever\n")).toBeNull();
  });
});

describe("go zero and forged cases", () => {
  test("no test files only, or a verbose package with no tests, is 0", () => {
    expect(testCount(GO_ONLY_NOTEST)).toBe(0);
    expect(testCount(GO_V_EMPTY_PKG)).toBe(0);
  });
  test("forged summary above the runner trailer is ignored", () => {
    const forged = "Tests: 5 passed, 5 total\n" + "x\n".repeat(20) + VITEST_NO_FILES;
    expect(testCount(forged)).toBe(0);
    expect(testCount("Tests: 5 passed, 5 total\n" + "x\n".repeat(20) + "done\n")).toBeNull();
    expect(testCount("Tests: 5 passed, 5 total\n")).toBeNull();
  });
  test("real jest trailer with its Test Suites sibling still counts", () => {
    expect(testCount("Test Suites: 1 passed, 1 total\nTests:       4 passed, 4 total\nSnapshots:   0 total\nTime:        1 s\nRan all test suites.\n")).toBe(4);
  });
  test("classify: go -v pass counts, unmeasured wording", () => {
    expect(classifyCheck({ kind: "test", ok: true, out: GO_MULTI_V })).toEqual({ result: "pass", n: 3 });
    expect(classifyCheck({ kind: "test", ok: true, out: GO_NONV }).reason).toContain("unmeasured");
  });
});

describe("classifyCheck", () => {
  test("exit 0 with zero executed tests is not_run with the no-tests reason", () => {
    for (const out of [VITEST_NO_FILES, VITEST_FILES_ZERO, PYTEST_NONE, JEST_NONE, CARGO_NONE]) {
      const c = classifyCheck({ kind: "test", ok: true, out });
      expect(c.result).toBe("not_run");
      expect(c.reason).toContain("no tests executed");
    }
  });
  test("exit 0 with an unparsed count is not_run, never pass", () => {
    const c = classifyCheck({ kind: "test", ok: true, out: GO_UNPARSED });
    expect(c.result).toBe("not_run");
    expect(c.reason).toContain("unmeasured"); expect(c.reason).not.toContain("no tests executed");
  });
  test("real pass keeps n", () => {
    expect(classifyCheck({ kind: "test", ok: true, out: VITEST_REAL })).toEqual({ result: "pass", n: 3 });
    expect(classifyCheck({ kind: "test", ok: true, out: PYTEST_REAL })).toEqual({ result: "pass", n: 3 });
  });
  test("a failing run stays fail, a static check is decided by exit", () => {
    expect(classifyCheck({ kind: "test", ok: false, out: "1 failed, 2 passed in 0.1s\n" }).result).toBe("fail");
    expect(classifyCheck({ kind: "static", ok: true, out: "" }).result).toBe("pass");
    expect(classifyCheck({ kind: "static", ok: false, out: "" }).result).toBe("fail");
  });
});

describe("runCheck routes through the shared classifier", () => {
  const ctxFor = (dir: string): RunContext => ({ repoDir: dir, emit: () => {} }) as unknown as RunContext;
  const sig = new AbortController().signal;
  async function check(out: string, kind?: "static"): Promise<VerifyCheck> {
    const dir = mkdtempSync(join(tmpdir(), "fc16-"));
    try { return await runCheck(ctxFor(dir), "t", "bash", ["-c", 'printf %s "$1"', "_", out], sig, [], kind ? { kind } : {}); } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  test("vitest No test files found, exit 0 -> not_run, no pass n:0", async () => {
    const c = await check(VITEST_NO_FILES);
    expect(c.result).toBe("not_run"); expect(c.n).toBeUndefined(); expect(c.reason).toContain("no tests executed");
  });
  test("vitest Test Files 0 -> not_run", async () => { expect((await check(VITEST_FILES_ZERO)).result).toBe("not_run"); });
  test("pytest no tests ran -> not_run", async () => { expect((await check(PYTEST_NONE)).result).toBe("not_run"); });
  test("real pass -> pass with n>0", async () => { const c = await check(PYTEST_REAL); expect(c.result).toBe("pass"); expect(c.n).toBe(3); });
  test("static check passes without a count", async () => { expect((await check("", "static")).result).toBe("pass"); });
});

describe("wall base classify", () => {
  const f = { path: "w.test.ts", runner: "vitest" } as never;
  test("exit 0 with zero tests is not_run", () => { expect(classify(f, 0, VITEST_NO_FILES, "/tmp")).toBe("not_run"); });
  test("exit 0 with tests is pass", () => { expect(classify(f, 0, VITEST_REAL, "/tmp")).toBe("pass"); });
});

describe("verdict gate", () => {
  const pass0 = { name: "vitest:a", cmd: "x", result: "pass" as const, duration_s: 1 };
  const o = (extra: Record<string, unknown> = {}) => ({ implement: { exit: "done" }, intake: {}, ...extra }) as never;
  test("hasExecutedProof needs pass with n>0", () => {
    expect(hasExecutedProof([{ result: "pass", n: 0 }])).toBe(false);
    expect(hasExecutedProof([{ result: "pass" }])).toBe(false);
    expect(hasExecutedProof([{ result: "not_run", n: 3 }])).toBe(false);
    expect(hasExecutedProof([{ result: "pass", n: 1 }])).toBe(true);
  });
  test("VERIFIED needs proof, else PARTIAL", () => {
    expect(verdictOf(o(), [pass0], false, false, false, false)).toBe("PARTIAL");
    expect(verdictOf(o(), [pass0], false, false, false, true)).toBe("VERIFIED");
  });
  test("ALREADY_SATISFIED with zero executed checks (FC-16) is PARTIAL", () => {
    const a = o({ implement: { exit: "already_done" } });
    expect(verdictOf(a, [], true, false, false, false)).toBe("PARTIAL");
    expect(verdictOf(a, [pass0], true, false, false, true)).toBe("ALREADY_SATISFIED");
  });
});
