// FC-16: a check that executed zero tests is NOT a pass. One shared classifier, every runner fixture, plus the verdict gate.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyCheck, hasExecutedProof, testCount } from "../../src/util/check_result.ts";
import { firstError, runCheck, type VerifyCheck } from "../../src/engine10/stages/verify.ts";
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
  test("classify: go never passes from parsing (count could not be confirmed)", () => {
    expect(classifyCheck({ kind: "test", ok: true, out: GO_MULTI_V, runner: "go" })).toEqual({ result: "not_run", reason: "test count could not be confirmed" });
    expect(classifyCheck({ kind: "test", ok: true, out: GO_NONV, runner: "go" }).reason).toContain("could not be confirmed");
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
    const c = classifyCheck({ kind: "test", ok: true, out: GO_UNPARSED, runner: "go" });
    expect(c.result).toBe("not_run");
    expect(c.reason).toContain("could not be confirmed"); expect(c.reason).not.toContain("no tests executed");
  });
  test("generic runner: exit 0 with an unparseable count is not_run with the UNMEASURED reason", () => {
    const c = classifyCheck({ kind: "test", ok: true, out: "all good, nothing countable here\n" });
    expect(c.result).toBe("not_run"); expect(c.reason).toStartWith("executed count unmeasured");
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

// FC-16 B1 (HIGH review): forged or skipped output must never count as an executed pass. Real tool output shapes.
describe("trailer-only counting: skipped or forged output is never a pass", () => {
  const notPass = (o: string, ok = true) => expect(classifyCheck({ kind: "test", ok, out: o }).result).not.toBe("pass");
  test("go: PASS line printed then t.Skip", () => {
    const o = "=== RUN   TestForged\n--- PASS: TestForged (0.00s)\n    forge_test.go:7: skipping\n--- SKIP: TestForged (0.00s)\nPASS\nok  \tp/a\t0.010s\n";
    expect(testCount(o)).toBe(0); notPass(o);
  });
  test("go: TestMain printing a result line with no tests", () => {
    const o = "--- PASS: TestForged (0.00s)\nPASS\nok  \tp/a\t0.010s\n";
    expect(testCount(o)).toBe(0); notPass(o);
  });
  test("bun: one skipped test and a forged console.log", () => {
    const o = "bun test v1.3\n\n5 pass\n\n 0 pass\n 1 skip\n 0 fail\nRan 1 test across 1 file. [2.00ms]\n";
    expect(testCount(o)).toBe(0); notPass(o);
  });
  test("bun: forged pytest and cargo lines above the bun trailer", () => {
    const o = "3 passed in 0.01s\ntest result: ok. 4 passed; 0 failed\n 0 pass\n 1 skip\n 0 fail\nRan 1 test across 1 file. [2.00ms]\n";
    expect(testCount(o)).toBe(0); notPass(o);
  });
  test("bun: a real run still counts", () => { expect(testCount(BUN_REAL)).toBe(2); });
  test("cargo: a test result line printed by a test, then a skipped trailer", () => {
    const o = "running 1 test\ntest result: ok. 4 passed; 0 failed\ntest t ... ok\n\ntest result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s\n";
    expect(testCount(o)).toBe(0); notPass(o);
  });
  test("cargo: real multi-crate trailer sums", () => {
    const o = "running 2 tests\ntest a ... ok\ntest b ... ok\n\ntest result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\n   Doc-tests x\n\nrunning 1 test\ntest src/lib.rs - f (line 1) ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.10s\n";
    expect(testCount(o)).toBe(3);
  });
  test("unittest: all skipped", () => {
    const o = "ss\n----------------------------------------------------------------------\nRan 2 tests in 0.000s\n\nOK (skipped=2)\n";
    expect(testCount(o)).toBe(0); notPass(o);
  });
  test("unittest: expected failures are not executed, real run counts", () => {
    expect(testCount("Ran 3 tests in 0.001s\n\nOK (expected failures=1, skipped=1)\n")).toBe(1);
    expect(testCount("..\n----------------------------------------------------------------------\nRan 2 tests in 0.001s\n\nOK\n")).toBe(2);
  });
  test("mocha: 0 passing after an earlier stdout 5 passing", () => {
    const o = "  5 passing (forged)\n\n  0 passing (1ms)\n  1 pending\n";
    expect(testCount(o)).toBe(0); notPass(o);
  });
  test("vitest: all-skipped trailer plus a stdout cargo-style line", () => {
    const o = "test result: ok. 4 passed; 0 failed\n ↓ a.test.ts (2 tests | 2 skipped)\n\n Test Files  1 skipped (1)\n      Tests  2 skipped (2)\n   Duration  200ms\n";
    expect(testCount(o)).toBe(0); notPass(o);
  });
  test("CRLF, OSC-8 and 8-bit CSI are stripped", () => {
    expect(testCount(VITEST_REAL.replace(/\n/g, "\r\n"))).toBe(3);
    expect(testCount(PYTEST_REAL.replace("passed", "\u001b]8;;http://x\u0007passed\u001b]8;;\u0007"))).toBe(3);
    expect(testCount(PYTEST_REAL.replace("3 passed", "\u009b32m3 passed\u009b0m"))).toBe(3);
  });
});

test("go non-verbose failing package: FAIL line without === RUN still counts", () => {
  expect(testCount("--- FAIL: TestA (0.00s)\nFAIL\nFAIL\texample.com/a\t0.004s\n")).toBe(1);
  expect(testCount("--- FAIL: TestForged (0.00s)\nPASS\nok  \tp/a\t0.010s\n")).toBe(0);
});

// FC-16 r2: Go forgeries G2 (forged RUN and PASS then t.Skip) and G3 (TestMain forges FAIL lines, os.Exit(0)). Real go 1.26.3 output, text and -json.
describe("go forgeries G2 and G3", () => {
  const G2_V = "=== RUN   TestForged\n=== RUN   TestForged\n--- PASS: TestForged (0.00s)\n    a_test.go:3: x\n--- SKIP: TestForged (0.00s)\nPASS\nok  \texample.com/g2\t0.093s\n";
  const G3_V = "--- FAIL: TestX (0.00s)\nFAIL\texample.com/g3\t0.010s\nok  \texample.com/g3\t0.095s\n";
  const notPass = (o: string) => expect(classifyCheck({ kind: "test", ok: true, out: o, runner: "go" }).result).not.toBe("pass");
  test("G2 text: forged RUN and PASS then Skip", () => { expect(testCount(G2_V, undefined, true)).toBe(0); notPass(G2_V); });
  test("G2 text: forged PASS printed after the SKIP line still does not count", () => {
    const o = G2_V.replace("PASS\nok", "--- PASS: TestForged (0.00s)\nPASS\nok");
    expect(testCount(o, undefined, true)).toBe(0); notPass(o);
  });
  test("G3 text: forged FAIL under exit 0 is unmeasured", () => { expect(testCount(G3_V, undefined, true)).toBeNull(); notPass(G3_V); });
  test("text -v run that failed keeps counting a FAIL line without RUN", () => {
    expect(testCount("--- FAIL: TestA (0.00s)\nFAIL\nFAIL\texample.com/a\t0.004s\n", undefined, false)).toBe(1);
  });
});

// FC-16 r4: Go is never trusted from parsing. Real go 1.26.3 output (go test -v).
describe("go: exit 0 is never a pass, a fail needs evidence", () => {
  const OK_V = "=== RUN   TestA\n--- PASS: TestA (0.00s)\nPASS\nok  \texample.com/ok\t0.095s\n", RF_V = "=== RUN   TestAdd\n    a_test.go:3: add: got 3 want 4\n--- FAIL: TestAdd (0.00s)\n=== RUN   TestOk\n--- PASS: TestOk (0.00s)\nFAIL\nFAIL\texample.com/f\t0.098s\nFAIL\n", B_V = "# example.com/b [example.com/b.test]\n./a.go:2:23: undefined: undefinedVar\nFAIL\texample.com/b [build failed]\nFAIL\n", G2 = "=== RUN   TestForged\n=== RUN   TestForged\n--- PASS: TestForged (0.00s)\n    a_test.go:3: x\n--- SKIP: TestForged (0.00s)\nPASS\nok  \texample.com/g2\t0.093s\n", G3 = "--- FAIL: TestX (0.00s)\nFAIL\texample.com/g3\t0.010s\nok  \texample.com/g3\t0.095s\n";
  const cls = (out: string, ok: boolean) => classifyCheck({ kind: "test", ok, out, runner: "go" });
  test("a passing -v package is not_run: test count could not be confirmed", () => {
    const c = cls(OK_V, true); expect(c.result).toBe("not_run"); expect(c.reason).toBe("test count could not be confirmed");
  });
  test("G2 and G3 (forged lines, exit 0) are not_run", () => {
    expect(cls(G2, true).result).toBe("not_run"); expect(cls(G3, true).result).toBe("not_run");
  });
  test("a real failing test is a fail and firstError names it", () => {
    expect(cls(RF_V, false).result).toBe("fail"); expect(firstError(RF_V)).toContain("--- FAIL: TestAdd");
  });
  test("a build failure is a fail and firstError carries the compiler line", () => {
    expect(cls(B_V, false).result).toBe("fail"); expect(firstError(B_V)).toContain("undefined: undefinedVar");
  });
  test("a non-zero exit with no failure evidence is not_run, never a fail", () => {
    const c = cls("ok  \texample.com/x\t0.010s\n", false); expect(c.result).toBe("not_run"); expect(c.reason).toBe("test count could not be confirmed");
  });
  test("non-go: a failure is never downgraded to not_run by a zero count", () => {
    expect(classifyCheck({ kind: "test", ok: false, out: "0 passed, 1 failed in 0.01s\n" }).result).toBe("fail");
  });
});

// FC-16 r5: the Go branch is chosen from the runner, never from output text a test can print; extra Go failure evidence.
describe("go branch follows the runner, not the output", () => {
  const BUN_FAIL_PRINTING_GO_OK = 'bun test v1.3.0\n\nok  \texample.com/x\t0.010s\n\na.test.ts:\n1 | test("x", () => {\n(fail) x [0.5ms]\n\n 0 pass\n 1 fail\n 1 expect() calls\nRan 1 test across 1 file.\n';
  test("bun repro: a go-looking console.log in a failing bun test is still a fail with n", () => {
    const c = classifyCheck({ kind: "test", ok: false, out: BUN_FAIL_PRINTING_GO_OK });
    expect(c.result).toBe("fail"); expect(c.n).toBe(1);
  });
  test("log.Fatal in a test (real go 1.26.3) is a fail", () => {
    const o = "=== RUN   TestA\n2026/10/03 22:00:00 fatal here\nFAIL\texample.com/lf\t0.090s\nFAIL\n";
    expect(classifyCheck({ kind: "test", ok: false, out: o, runner: "go" }).result).toBe("fail");
  });
  test("panic in package init (real go 1.26.3) is a fail", () => {
    const o = "panic: assignment to entry in nil map\n\ngoroutine 1 [running]:\nFAIL\texample.com/pi\t0.126s\nFAIL\n";
    expect(classifyCheck({ kind: "test", ok: false, out: o, runner: "go" }).result).toBe("fail");
  });
  test("test timeout panic (real go 1.26.3) is a fail", () => {
    const o = "=== RUN   TestSlow\npanic: test timed out after 1s\n\trunning tests:\n\t\tTestSlow (1s)\n";
    expect(classifyCheck({ kind: "test", ok: false, out: o, runner: "go" }).result).toBe("fail");
  });
  test("go exit 0 stays unconfirmed even if output has panic text", () => {
    expect(classifyCheck({ kind: "test", ok: true, out: "panic: x\nok  \tp\t0.1s\n", runner: "go" }).result).toBe("not_run");
  });
});
