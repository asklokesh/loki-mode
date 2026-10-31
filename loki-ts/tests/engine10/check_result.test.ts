// FC-16: a check that executed zero tests is NOT a pass. One shared classifier, every runner fixture, plus the verdict gate.
import { afterAll, describe, expect, test } from "bun:test";
import { failIds } from "../../src/engine10/failures.ts";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CARGO_RUNNER_REASON, CARGO_UNLISTED_REASON, goRunner, spawnCollect, changedSymbols, checkProvenance, classifyCheck, corroboratePass, failureExcerpt, goTestNames, GO_EXIT0_REASON, hasExecutedProof, hasExogenousProof, javaSummary, javaTestClass, fullSuiteCmd, readableFailIds, runnerCmd, symbolGap, testCount } from "../../src/util/check_result.ts";
import { firstError, runCheck, testCheckName, type VerifyCheck } from "../../src/engine10/stages/verify.ts";
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
    { const c = classifyCheck({ kind: "test", ok: true, out: GO_MULTI_V, runner: "go" }); expect(c.result).toBe("not_run"); expect(c.reason).toBe(GO_EXIT0_REASON); expect(c.reason).toStartWith("test count could not be confirmed"); }
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
  test("unittest exit 1 is red only with a trusted FAILED trailer", () => {
    const u = { path: "test_w.py", runner: "unittest" } as never;
    const trailer = "F\n======\nFAIL: test_a (t.T)\n----------------------------------------------------------------------\nRan 1 test in 0.001s\n\nFAILED (failures=1)\n";
    expect(classify(u, 1, trailer, "/tmp")).toBe("fail");
    expect(classify(u, 1, "Traceback (most recent call last):\nboom\n", "/tmp")).toBe("not_run"); // no trailer: untrusted
    expect(classify(u, 1, "Ran 1 test in 0.001s\n\nOK\n", "/tmp")).toBe("not_run"); // OK trailer contradicts exit 1
  });
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
  test("FC-VACUOUS-WALL-GREEN: a Wall green on base never makes a changed tree VERIFIED, and proves only a claim", () => {
    expect(verdictOf(o(), [pass0], false, false, true, true)).toBe("PARTIAL"); // implement done, non-empty diff, passing exogenous check
    expect(verdictOf(o({ implement: { exit: "killed", limit_s: 60 } }), [pass0], false, false, true, true, true)).toBe("PARTIAL");
    expect(verdictOf(o({ implement: { exit: "already_done" } }), [pass0], true, false, true, false)).toBe("ALREADY_SATISFIED");
    expect(verdictOf(o({ intake: { already_satisfied: true } }), [], true, false, true, false)).toBe("ALREADY_SATISFIED");
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
    const c = cls(OK_V, true); expect(c.result).toBe("not_run"); expect(c.reason).toBe(GO_EXIT0_REASON);
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

describe("TEN-GATES-01 check provenance", () => {
  const ctx = { addedFiles: ["tests/new.test.ts"], wallFiles: ["tests/wall.test.ts"], holdout: true };
  test("runner on an added file is agent_authored, same path pre-existing is exogenous", () => {
    expect(checkProvenance("bun:tests/new.test.ts", ctx)).toBe("agent_authored");
    expect(checkProvenance("jest:./tests/new.test.ts", ctx)).toBe("agent_authored");
    expect(checkProvenance("bun:tests/new.test.ts", { ...ctx, addedFiles: [] })).toBe("exogenous");
  });
  test("pytest and go names (the real emitted shape) resolve by path", () => {
    const c2 = { addedFiles: ["tests/test_new.py", "pkg/new_test.go"], wallFiles: ["tests/test_wall.py"], holdout: true };
    expect(checkProvenance("pytest:tests/test_new.py", c2)).toBe("agent_authored");
    expect(checkProvenance("go:pkg/new_test.go", c2)).toBe("agent_authored");
    expect(checkProvenance("pytest:tests/test_wall.py", c2)).toBe("independent");
    expect(checkProvenance("pytest:tests/test_old.py", c2)).toBe("exogenous");
    expect(hasExogenousProof([{ name: "pytest:tests/test_new.py", result: "pass", n: 4 }], c2)).toBe(false);
    expect(hasExogenousProof([{ name: "pytest:tests/test_wall.py", result: "pass", n: 4 }], c2)).toBe(true);
  });
  test("names derived by verify.ts testCheckName classify correctly for every runner", () => {
    const refs = [{ runner: "pytest", path: "tests/test_new.py" }, { runner: "go", path: "pkg/new_test.go" }, { runner: "bun", path: "tests/new.test.ts" }] as never[];
    const c3 = { addedFiles: refs.map((r: { path: string }) => r.path), wallFiles: [] as string[] };
    for (const r of refs) expect(checkProvenance(testCheckName(r), c3)).toBe("agent_authored");
    expect(checkProvenance(testCheckName(refs[0]!), { addedFiles: [], wallFiles: ["tests/test_new.py"] })).toBe("independent");
    expect(checkProvenance("lint:tests/new.test.ts", c3)).toBe("exogenous");
  });
  test("wall file and holdout are independent", () => {
    expect(checkProvenance("vitest:tests/wall.test.ts", ctx)).toBe("independent");
    expect(checkProvenance("vitest:tests/wall.test.ts", { ...ctx, addedFiles: ["tests/wall.test.ts"] })).toBe("independent");
    expect(checkProvenance("holdout", ctx)).toBe("independent");
  });
  test("LLM judges are llm_judge", () => {
    for (const n of ["council", "xreview", "code_review", "devils_advocate", "magic_debate", "council:round1"]) expect(checkProvenance(n, ctx)).toBe("llm_judge");
  });
  test("static, scan, boot, probe and unknown names are exogenous (fail-closed)", () => {
    for (const n of ["lint:eslint", "typecheck:tsc", "security_scan", "app_boot", "http_probe", "full_suite", "something_new"]) expect(checkProvenance(n, ctx)).toBe("exogenous");
  });
  test("hasExogenousProof", () => {
    const ok = (name: string, n = 3, result = "pass") => ({ name, result, n });
    expect(hasExogenousProof([ok("bun:tests/new.test.ts")], ctx)).toBe(false);
    expect(hasExogenousProof([ok("bun:tests/new.test.ts")], { ...ctx, addedFiles: [] })).toBe(true);
    expect(hasExogenousProof([ok("vitest:tests/wall.test.ts")], ctx)).toBe(true);
    expect(hasExogenousProof([ok("council", 5)], ctx)).toBe(false);
    expect(hasExogenousProof([ok("lint:x", 0)], ctx)).toBe(false);
    expect(hasExogenousProof([ok("lint:x", 2, "fail")], ctx)).toBe(false);
    expect(hasExogenousProof([ok("bun:tests/new.test.ts"), ok("council", 5), ok("app_boot", 1)], ctx)).toBe(true);
    expect(hasExogenousProof([], ctx)).toBe(false);
  });
});

describe("TEN-QUALITY-01 failureExcerpt", () => {
  const PY = "tests/test_a.py:4: AssertionError\n=== FAILURES ===\n    def test_add():\n>       assert add(2, 2) == 5\nE       assert 4 == 5\nE        +  where 4 = add(2, 2)\n/repo/tests/test_a.py:4: AssertionError\n1 failed in 0.01s\n";
  test("pytest: E lines and last frame, noise dropped", () => {
    const x = failureExcerpt(PY, "/repo");
    expect(x).toContain("E       assert 4 == 5");
    expect(x).toContain("tests/test_a.py:4: AssertionError");
    expect(x).not.toContain("/repo/");
    expect(x).not.toContain("1 failed in");
  });
  test("jest/vitest: Expected and Received", () => {
    const x = failureExcerpt("\u001b[31m  Expected: 5\u001b[0m\n  Received: 4\n  at foo (a.test.ts:3:1)\nTests: 1 failed\n");
    expect(x).toContain("Expected: 5");
    expect(x).toContain("Received: 4");
    expect(x).not.toContain("\u001b");
  });
  test("node:test: AssertionError block", () => {
    const x = failureExcerpt("not ok 1 - adds\n  error: 'Expected values to be strictly equal:'\n  AssertionError [ERR_ASSERTION]: 4 !== 5\n  actual: 4\n  expected: 5\n# fail 1\n");
    expect(x).toContain("AssertionError");
    expect(x).toContain("expected: 5");
  });
  test("go: --- FAIL and following lines", () => {
    const x = failureExcerpt("=== RUN   TestA\n--- FAIL: TestA (0.00s)\n    a_test.go:9: got 4, want 5\nFAIL\nFAIL\tp\t0.1s\n");
    expect(x).toContain("--- FAIL: TestA");
    expect(x).toContain("got 4, want 5");
  });
  test("tsc diagnostics", () => {
    const x = failureExcerpt("src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\nFound 1 error.\n");
    expect(x).toContain("error TS2322");
  });
  test("cap is bytes and secrets are redacted", () => {
    // Built at runtime so no committed text matches a gitleaks rule.
    const fakeKey = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
    const big = Array.from({ length: 400 }, (_, i) => `E   line ${i} ${fakeKey}`).join("\n");
    const x = failureExcerpt(big);
    expect(Buffer.byteLength(x)).toBeLessThanOrEqual(1500);
    expect(x).not.toContain(fakeKey);
    expect(x).toContain("[REDACTED:AWS_KEY]");
  });
  test("unknown shape falls back to the last lines; empty stays empty", () => {
    expect(failureExcerpt("a\nb\nboom\n")).toContain("boom");
    expect(failureExcerpt("")).toBe("");
  });
});

describe("FC-LEAN-VERIFIED-WITHOUT-CHANGED-SYMBOL changedSymbols and symbolGap", () => {
  const append = "@@ -3,0 +4,4 @@ export function add(a: number, b: number): number {\n+\n+export function multiply(a: number, b: number): number {\n+  return a * b;\n+}\n";
  const edit = "@@ -2 +2 @@ export function add(a: number, b: number): number {\n-  return a + b;\n+  return a - b;\n";
  const guard = "@@ -2,0 +3,3 @@ def total(items):\n+    if not items:\n+        return 0\n";
  test("an appended function names itself, not the enclosing hunk context", () => expect(changedSymbols(append)).toEqual(["multiply"]));
  test("a body edit names the enclosing declaration", () => expect(changedSymbols(edit)).toEqual(["add"]));
  test("a pure addition with no declaration falls back to the hunk context", () => expect(changedSymbols(guard)).toEqual(["total"]));
  test("class methods and Go receivers count; control flow does not", () => {
    expect(changedSymbols("@@ -1,0 +2,3 @@\n+  async run(x) {\n+    if (x) {\n+func (s *Store) Put(k string) error {\n")).toEqual(["run", "Put"]);
  });
  test("a test source naming the symbol closes the gap; an unrelated one does not", () => {
    expect(symbolGap(["multiply"], ['import { add } from "./calc"; test("add", () => add(1, 2));'])).toEqual(["multiply"]);
    expect(symbolGap(["multiply"], ["expect(multiply(3, 4)).toBe(12)"])).toEqual([]);
    expect(symbolGap(["add"], ["expect(multiply(3, 4)).toBe(12)", "const padded = 1"])).toEqual(["add"]);
  });
  test("a local variable is not a changed symbol (rev-c repro 1 and 3)", () => {
    const local = "@@ -3,0 +4,4 @@ export function add(a: number, b: number): number {\n+export function multiply(a: number, b: number): number {\n+  const result = a * b;\n+  return result;\n+}\n";
    expect(changedSymbols(local)).toEqual(["multiply"]);
    expect(symbolGap(changedSymbols(local), ["const result = add(1, 2); expect(result).toBe(3)"])).toEqual(["multiply"]);
    const loop = "@@ -1,0 +2,5 @@\n+export function sum(xs: number[]): number {\n+  let t = 0;\n+  for (let i = 0; i < xs.length; i++) t += xs[i]!;\n+  return t;\n+}\n";
    expect(changedSymbols(loop)).toEqual(["sum"]);
    expect(symbolGap(changedSymbols(loop), ["let t = 0; for (let i = 0; i < 3; i++) t += i;"])).toEqual(["sum"]);
  });
  test("a block comment spanning added lines hides the code inside it (rev-a B2)", () => {
    const blk = "@@ -1,0 +2,6 @@\n+/*\n+function add(a, b) { return a + b; }\n+*/\n+export function multiply(a: number, b: number): number {\n+  return a * b;\n+}\n";
    expect(changedSymbols(blk)).toEqual(["multiply"]);
    expect(symbolGap(changedSymbols(blk), ["expect(add(1, 2)).toBe(3)"])).toEqual(["multiply"]);
  });
  test("module-level and exported const, let, var still name a symbol", () => {
    expect(changedSymbols("@@ -1,0 +2,3 @@\n+export const TAX = 0.2;\n+let cache = 1;\n+var legacy = 2;\n")).toEqual(["TAX", "cache", "legacy"]);
  });
  test("a word in a comment is neither a symbol nor a test reference (rev-c repro 2)", () => {
    const cm = "@@ -3,0 +4,3 @@ export function add(a: number, b: number): number {\n+// let users multiply two numbers\n+/* class Widget */\n+  * function ghost() {\n";
    expect(changedSymbols(cm)).toEqual(["add"]);
    expect(symbolGap(["multiply"], ["// users multiply things\n/* multiply */\ntest('add', () => add(1, 2));"])).toEqual(["multiply"]);
    expect(symbolGap(["multiply"], ["# multiply in a python comment\nassert add(1, 2) == 3"])).toEqual(["multiply"]);
  });
  test("no declared symbol, or no passing test source, is a gap", () => {
    expect(symbolGap([], ["anything"])).toEqual(["(no declared symbol)"]);
    expect(symbolGap(["multiply"], [])).toEqual(["multiply"]);
  });
  test("verdictOf: a non-empty leanGap is PARTIAL even with a passing exogenous check", () => {
    const checks = [{ name: "bun:calc.test.ts", cmd: "bun test", result: "pass" as const, duration_s: 1, n: 1 }];
    expect(verdictOf({ implement: { exit: "ok" } } as never, checks as never, false, false, false, true, false, [], [])).toBe("VERIFIED");
    expect(verdictOf({ implement: { exit: "ok" } } as never, checks as never, false, false, false, true, false, [], ["multiply"])).toBe("PARTIAL");
  });
});

describe("FC-WALL-GO-FILE-RUNS-WHOLE-PACKAGE: goTestNames and the go argv", () => {
  const dir = mkdtempSync(join(tmpdir(), "gotn-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  test("top-level Test functions only, TestMain excluded, deduplicated", () => {
    const f = join(dir, "x_test.go");
    writeFileSync(f, 'package x\n\nfunc TestMain(m *testing.M) {}\nfunc TestA(t *testing.T) {}\nfunc TestB_c(t *testing.T) {}\nfunc BenchmarkA(b *testing.B) {}\nfunc testHelper(t *testing.T) {}\nfunc (s *S) TestMethod(t *testing.T) {}\n');
    expect(goTestNames(f)).toEqual(["TestA", "TestB_c"]);
    expect(goTestNames(join(dir, "missing_test.go"))).toEqual([]);
  });
  // rev-b B1: every valid declaration form is named, so `-run` never drops a red test.
  const FORMS = 'package x\n\nimport (\n\t"fmt"\n\ttt "testing"\n)\n\nfunc TestMulti(\n\tt *tt.T,\n) {\n\tt.Fatal("multi")\n}\n\nfunc TestAlias(t *tt.T) { t.Fatal("alias") }\n\nfunc TestÄ(t *tt.T) { t.Fatal("non-ascii") }\n\nfunc FuzzF(f *tt.F) { f.Fatal("fuzz") }\n\nfunc Example() {\n\tfmt.Println("a")\n\t// Output: b\n}\n';
  const DOT = 'package x\n\nimport . "testing"\n\nfunc TestDot(t *T) { t.Fatal("dot") }\n\nfunc TestUnnamed(*T) { panic("unnamed") }\n';
  test("multi-line, aliased, non-ASCII, unnamed, Fuzz and Example forms are all named", () => {
    const f = join(dir, "forms_test.go"); writeFileSync(f, FORMS);
    expect(goTestNames(f)).toEqual(["TestMulti", "TestAlias", "TestÄ", "FuzzF", "Example"]);
  });
  test.skipIf(!Bun.which("go"))("a red Go Wall file using those forms is fail under the scoped -run, never not_run", () => {
    const d = mkdtempSync(join(tmpdir(), "gotn-run-")); try {
      writeFileSync(join(d, "go.mod"), "module x\n\ngo 1.20\n"); writeFileSync(join(d, "loki_wall_x_test.go"), FORMS); writeFileSync(join(d, "loki_wall_dot_test.go"), DOT);
      expect(goTestNames(join(d, "loki_wall_dot_test.go"))).toEqual(["TestDot", "TestUnnamed"]);
      for (const [file, names] of [["loki_wall_x_test.go", ["TestMulti", "TestAlias", "TestÄ", "FuzzF", "Example"]], ["loki_wall_dot_test.go", ["TestDot", "TestUnnamed"]]] as const) {
      const [cmd, args] = runnerCmd({ runner: "go", path: file }, d);
      const r = spawnSync(cmd, args, { cwd: d, encoding: "utf8", env: { ...process.env, GOFLAGS: "-mod=mod" } });
      expect(r.status).not.toBe(0);
      const failed = new Set(r.stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as { Action?: string; Test?: string }).filter((e) => e.Action === "fail" && e.Test).map((e) => e.Test));
      for (const n of names) expect([n, failed.has(n)]).toEqual([n, true]);
      }
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 60000);
  test("runnerCmd scopes to the file's tests, and keeps the package run when the file has none", () => {
    writeFileSync(join(dir, "y_test.go"), "package x\n\nfunc TestY(t *testing.T) {}\n");
    writeFileSync(join(dir, "z_test.go"), "package x\n");
    expect(runnerCmd({ runner: "go", path: "y_test.go" }, dir)[1]).toEqual(["test", "-json", "-run", "^(TestY)$", "./."]);
    expect(runnerCmd({ runner: "go", path: "z_test.go" }, dir)[1]).toEqual(["test", "-json", "./."]);
  });
});

// HV1-03b. No mvn or gradle is installed on the build machine, so the maven and gradle outputs below are written from the tools' documented report formats (surefire "Results:" block, gradle -i "Class > method() PASSED"), not captured. The plain-javac path is run for real below.
const MVN_PASS = "[INFO] Running cal.LeapTest\n[INFO] Tests run: 3, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.05 s -- in cal.LeapTest\n[INFO] \n[INFO] Results:\n[INFO] \n[INFO] Tests run: 3, Failures: 0, Errors: 0, Skipped: 0\n[INFO] \n[INFO] ------------------------------------------------------------------------\n[INFO] BUILD SUCCESS\n[INFO] ------------------------------------------------------------------------\n[INFO] Total time:  2.1 s\n";
const MVN_FAIL = "[ERROR] Tests run: 3, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.05 s <<< FAILURE! -- in cal.LeapTest\n[ERROR] cal.LeapTest.century -- Time elapsed: 0.01 s <<< FAILURE!\norg.opentest4j.AssertionFailedError: expected: <false> but was: <true>\n[INFO] \n[INFO] Results:\n[INFO] \n[ERROR] Failures: \n[ERROR]   LeapTest.century:12 expected: <false> but was: <true>\n[INFO] \n[ERROR] Tests run: 3, Failures: 1, Errors: 0, Skipped: 0\n[INFO] \n[INFO] ------------------------------------------------------------------------\n[INFO] BUILD FAILURE\n[INFO] ------------------------------------------------------------------------\n[ERROR] Failed to execute goal org.apache.maven.plugins:maven-surefire-plugin:3.2.5:test (default-test) on project cal: There are test failures.\n";
const MVN_NONE = "[INFO] No tests to run.\n[INFO] ------------------------------------------------------------------------\n[INFO] BUILD SUCCESS\n[INFO] ------------------------------------------------------------------------\n";
const MVN_COMPILE = "[ERROR] /w/src/test/java/loki_wall_LeapTest.java:[3,8] cannot find symbol\n[INFO] BUILD FAILURE\n[ERROR] Failed to execute goal compiler:testCompile\n";
const GRADLE_PASS = "> Task :test\ncal.LeapTest > leap() PASSED\ncal.LeapTest > century() PASSED\ncal.LeapTest > skipped() SKIPPED\n\nBUILD SUCCESSFUL in 2s\n3 actionable tasks: 3 executed\n";
const GRADLE_FAIL = "> Task :test FAILED\ncal.LeapTest > leap() PASSED\ncal.LeapTest > century() FAILED\n    org.opentest4j.AssertionFailedError at LeapTest.java:12\n\n2 tests completed, 1 failed\n\nFAILURE: Build failed with an exception.\n\nBUILD FAILED in 2s\n";
const GRADLE_UPTODATE = "> Task :test UP-TO-DATE\n\nBUILD SUCCESSFUL in 500ms\n";

describe("Java run reports (HV1-03b)", () => {
  test("maven pass: executed count from the Results block, exit status alone proves nothing", () => {
    expect(javaSummary(MVN_PASS)).toEqual({ executed: 3, failed: 0, ids: [] });
    expect(testCount(MVN_PASS, "src/test/java/cal/LeapTest.java", true)).toBe(3);
    expect(classify({ runner: "maven", path: "src/test/java/cal/LeapTest.java" }, 0, MVN_PASS, "/nonexistent")).toBe("pass");
    expect(classify({ runner: "maven", path: "src/test/java/cal/LeapTest.java" }, 0, MVN_NONE, "/nonexistent")).toBe("not_run");
    expect(classify({ runner: "maven", path: "src/test/java/cal/LeapTest.java" }, 0, "", "/nonexistent")).toBe("not_run");
  });
  test("maven fail: red with the failing test id; a compile error is not_run", () => {
    expect(javaSummary(MVN_FAIL)).toEqual({ executed: 3, failed: 1, ids: ["cal.LeapTest.century"] });
    expect(failIds(MVN_FAIL)).toEqual(["cal.LeapTest.century"]);
    expect(classify({ runner: "maven", path: "src/test/java/cal/LeapTest.java" }, 1, MVN_FAIL, "/nonexistent")).toBe("fail");
    expect(classify({ runner: "maven", path: "src/test/java/cal/LeapTest.java" }, 1, MVN_COMPILE, "/nonexistent")).toBe("not_run");
  });
  test("a forged or contradictory report is unmeasured", () => {
    expect(javaSummary(MVN_PASS.replace("BUILD SUCCESS", "BUILD FAILURE"))).toBeNull();
    expect(javaSummary(MVN_FAIL.replace("BUILD FAILURE", "BUILD SUCCESS"))).toBeNull();
    expect(javaSummary("[INFO] Tests run: 9, Failures: 0, Errors: 0, Skipped: 0\n[INFO] BUILD SUCCESS\n")).toBeNull();
    expect(javaSummary("Tests run: 3\n")).toBeNull();
  });
  test("gradle -i: PASSED and FAILED lines are the count, skipped did not execute, an up-to-date task ran nothing", () => {
    expect(javaSummary(GRADLE_PASS)).toEqual({ executed: 2, failed: 0, ids: [] });
    expect(javaSummary(GRADLE_FAIL)).toEqual({ executed: 2, failed: 1, ids: ["cal.LeapTest.century()"] });
    expect(failIds(GRADLE_FAIL)).toEqual(["cal.LeapTest.century()"]);
    expect(javaSummary(GRADLE_UPTODATE)).toBeNull();
    expect(classify({ runner: "gradle", path: "src/test/java/cal/LeapTest.java" }, 0, GRADLE_UPTODATE, "/nonexistent")).toBe("not_run");
    expect(classify({ runner: "gradle", path: "src/test/java/cal/LeapTest.java" }, 0, GRADLE_PASS, "/nonexistent")).toBe("pass");
    expect(classify({ runner: "gradle", path: "src/test/java/cal/LeapTest.java" }, 1, GRADLE_FAIL, "/nonexistent")).toBe("fail");
  });
  test("build tool missing or not started is not_run, never pass or fail", () => {
    for (const runner of ["maven", "gradle", "javac"] as const) for (const status of [null, 127, 126]) expect(classify({ runner, path: "src/test/java/XTest.java" }, status, "", "/nonexistent")).toBe("not_run");
  });
  test("commands: maven and gradle select the one class, a repo wrapper wins, javac gets root and class", () => {
    const root = mkdtempSync(join(tmpdir(), "hv103b-")); dirs.push(root);
    expect(runnerCmd({ runner: "maven", path: "src/test/java/cal/LeapTest.java" }, root)).toEqual(["mvn", ["-B", "test", "-Dtest=LeapTest", "-Dsurefire.failIfNoSpecifiedTests=false", "-DfailIfNoTests=false"]]);
    expect(runnerCmd({ runner: "gradle", path: "src/test/java/cal/LeapTest.java" }, root)[1]).toEqual(["cleanTest", "test", "--tests", "cal.LeapTest", "-i", "--console=plain"]);
    writeFileSync(join(root, "gradlew"), "#!/bin/sh\n");
    expect(runnerCmd({ runner: "gradle", path: "src/test/java/cal/LeapTest.java" }, root)[0]).toBe("./gradlew");
    expect(runnerCmd({ runner: "javac", path: "src/test/java/cal/LeapTest.java" }, root).slice(0, 1)).toEqual(["bash"]);
    expect(javaTestClass("src/test/java/cal/LeapTest.java")).toEqual({ root: ".", cls: "cal.LeapTest", rel: "src/test/java/cal/LeapTest.java" });
    expect(javaTestClass("svc/src/test/java/LeapTest.java")).toEqual({ root: "svc", cls: "LeapTest", rel: "src/test/java/LeapTest.java" });
    expect(fullSuiteCmd("maven", root).cmd).toBe("mvn");
  });
});

describe("javac wrapper summary checks are each load-bearing (HV1-03b)", () => {
  const S = (lines: string[], tail: string): string => `${lines.join("\n")}\n${tail}\n`;
  test("zero tests run is unmeasured", () => {
    expect(javaSummary("LOKI_JAVA_TESTS: 0 run, 0 failed\n")).toBeNull();
    expect(testCount("LOKI_JAVA_TESTS: 0 run, 0 failed\n", undefined, true)).toBeNull();
    expect(classifyCheck({ kind: "test", ok: true, out: "LOKI_JAVA_TESTS: 0 run, 0 failed\n", path: "src/test/java/XTest.java" }).result).toBe("not_run");
  });
  test("failing ids must match the failed count", () => {
    expect(javaSummary(S(["PASS a", "FAIL b"], "LOKI_JAVA_TESTS: 2 run, 0 failed"))).toBeNull();
    expect(javaSummary(S(["PASS a", "FAIL b"], "LOKI_JAVA_TESTS: 2 run, 2 failed"))).toBeNull();
    expect(classifyCheck({ kind: "test", ok: true, out: S(["PASS a", "FAIL b"], "LOKI_JAVA_TESTS: 2 run, 0 failed"), path: "src/test/java/XTest.java" }).result).not.toBe("pass");
  });
  test("the PASS and FAIL line count must match the run count", () => {
    expect(javaSummary(S(["PASS a"], "LOKI_JAVA_TESTS: 5 run, 0 failed"))).toBeNull();
    expect(javaSummary(S(["PASS a", "PASS b"], "LOKI_JAVA_TESTS: 1 run, 0 failed"))).toBeNull();
    expect(classifyCheck({ kind: "test", ok: true, out: S(["PASS a"], "LOKI_JAVA_TESTS: 5 run, 0 failed"), path: "src/test/java/XTest.java" }).result).not.toBe("pass");
  });
  test("a clean summary is still measured", () => {
    expect(javaSummary(S(["PASS a", "FAIL b"], "LOKI_JAVA_TESTS: 2 run, 1 failed"))).toEqual({ executed: 2, failed: 1, ids: ["b"] });
    expect(classifyCheck({ kind: "test", ok: true, out: S(["PASS a", "PASS b"], "LOKI_JAVA_TESTS: 2 run, 0 failed"), path: "src/test/java/XTest.java" }).result).toBe("pass");
  });
});

describe.skipIf(!Bun.which("javac") || !Bun.which("java") || !Bun.which("bash"))("plain javac Wall run, for real (HV1-03b)", () => {
  const seed = (test: string): string => {
    const root = mkdtempSync(join(tmpdir(), "hv103b-javac-")); dirs.push(root);
    mkdirSync(join(root, "src/main/java/cal"), { recursive: true }); mkdirSync(join(root, "src/test/java"), { recursive: true });
    writeFileSync(join(root, "src/main/java/cal/Leap.java"), "package cal;\npublic class Leap { public static boolean is(int y) { return y % 4 == 0 && (y % 100 != 0 || y % 400 == 0); } }\n");
    writeFileSync(join(root, "src/test/java/loki_wall_LeapTest.java"), test);
    return root;
  };
  const T = (body: string): string => `import cal.Leap;\npublic class loki_wall_LeapTest {\n  static boolean failed;\n  static void check(String n, boolean ok) { System.out.println((ok ? "PASS " : "FAIL ") + n); if (!ok) failed = true; }\n  public static void main(String[] a) { ${body} if (failed) System.exit(1); }\n}\n`;
  const run = (root: string): { status: number | null; out: string } => { const [cmd, args] = runnerCmd({ runner: "javac", path: "src/test/java/loki_wall_LeapTest.java" }, root), r = spawnSync(cmd, args, { cwd: root, encoding: "utf8" }); return { status: r.status, out: `${r.stdout}\n${r.stderr}` }; };
  test("passing tests: exit 0 and a counted summary classify pass", () => {
    const r = run(seed(T('check("2000", Leap.is(2000)); check("1900", !Leap.is(1900));')));
    expect(r.status).toBe(0);
    expect(javaSummary(r.out)).toEqual({ executed: 2, failed: 0, ids: [] });
    expect(classify({ runner: "javac", path: "src/test/java/loki_wall_LeapTest.java" }, r.status, r.out, "/nonexistent")).toBe("pass");
  });
  test("a failing test is red with its id", () => {
    const r = run(seed(T('check("2000", Leap.is(2000)); check("1900 is leap", Leap.is(1900));')));
    expect(r.status).toBe(1);
    expect(javaSummary(r.out)).toEqual({ executed: 2, failed: 1, ids: ["1900 is leap"] });
    expect(failIds(r.out)).toEqual(["1900 is leap"]);
    expect(classify({ runner: "javac", path: "src/test/java/loki_wall_LeapTest.java" }, r.status, r.out, "/nonexistent")).toBe("fail");
  });
  test("a test that prints nothing exits 0 but is not a pass; a compile error is red on base (the feature is absent)", () => {
    const quiet = run(seed(T("")));
    expect(quiet.status).toBe(0);
    expect(classify({ runner: "javac", path: "src/test/java/loki_wall_LeapTest.java" }, quiet.status, quiet.out, "/nonexistent")).toBe("not_run");
    const broken = run(seed("public class loki_wall_LeapTest { nope }"));
    expect(classify({ runner: "javac", path: "src/test/java/loki_wall_LeapTest.java" }, broken.status, broken.out, "/nonexistent")).toBe("fail");
  });
  test("a test that prints FAIL but exits 0 is red, not a pass", () => {
    const body = 'public class loki_wall_LeapTest { public static void main(String[] a) { System.out.println("PASS one"); System.out.println("FAIL two"); } }';
    const r = run(seed(body));
    expect(r.status).toBe(1);
    expect(javaSummary(r.out)).toEqual({ executed: 2, failed: 1, ids: ["two"] });
    expect(classify({ runner: "javac", path: "src/test/java/loki_wall_LeapTest.java" }, r.status, r.out, "/nonexistent")).toBe("fail");
    expect(classify({ runner: "javac", path: "src/test/java/loki_wall_LeapTest.java" }, 0, r.out, "/nonexistent")).not.toBe("pass");
    expect(classifyCheck({ kind: "test", ok: true, out: r.out, path: "src/test/java/loki_wall_LeapTest.java" }).result).toBe("fail");
  });
  test("the full-suite command runs every *Test.java", () => {
    const root = seed(T('check("2000", Leap.is(2000));')), s = fullSuiteCmd("javac", root), r = spawnSync(s.cmd, s.args, { cwd: root, encoding: "utf8" });
    expect(testCount(`${r.stdout}\n${r.stderr}`, undefined, r.status === 0)).toBe(1);
  });
});

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// HV1-03a: Go and Cargo results the Wall and verify can read. A -json pass counts its executed tests once go itself still lists them;
// cargo's stderr (Finished, Running, error: test failed) after the stdout trailer no longer hides the counts.
describe("go -json pass count and cargo trailer with stderr noise", () => {
  const ev = (o: Record<string, unknown>): string => JSON.stringify({ Time: "2026-10-29T00:00:00Z", ...o });
  const PASS = [ev({ Action: "start", Package: "ex/a" }), ev({ Action: "run", Package: "ex/a", Test: "TestA" }), ev({ Action: "pass", Package: "ex/a", Test: "TestA", Elapsed: 0 }), ev({ Action: "pass", Package: "ex/a", Elapsed: 0.01 })].join("\n") + "\n";
  test("go -json: a complete pass counts, a skipped test does not", () => {
    expect(classifyCheck({ kind: "test", ok: true, out: PASS, runner: "go" })).toEqual({ result: "pass", n: 1 });
    const skipped = PASS.replace('"Action":"pass","Package":"ex/a","Test":"TestA"', '"Action":"skip","Package":"ex/a","Test":"TestA"');
    expect(classifyCheck({ kind: "test", ok: true, out: skipped, runner: "go" }).result).toBe("not_run");
  });
  test("go -json: a failed run names its failing test ids", () => {
    const failed = PASS.replace('"Action":"pass","Package":"ex/a","Test":"TestA"', '"Action":"fail","Package":"ex/a","Test":"TestA"').replace('"Action":"pass","Package":"ex/a","Elapsed"', '"Action":"fail","Package":"ex/a","Elapsed"');
    expect(readableFailIds("go", failed)).toEqual(["ex/a::TestA"]);
    expect(readableFailIds("go", "FAIL\tex/a [build failed]\n")).toEqual([]);
  });
  test("cargo: failing ids and counts survive stderr lines after the stdout trailer", () => {
    const out = "\nrunning 2 tests\ntest ok_one ... ok\ntest bad_one ... FAILED\n\nfailures:\n    bad_one\n\ntest result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\n\n   Compiling fx v0.1.0 (/r)\n    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.30s\n     Running tests/itg.rs (target/debug/deps/itg-abc123)\nerror: test failed, to rerun pass `--test itg`\n";
    expect(readableFailIds("cargo", out)).toEqual(["bad_one"]);
    const ok = out.replace("test bad_one ... FAILED", "test bad_one ... ok").replace("FAILED. 1 passed; 1 failed", "ok. 2 passed; 0 failed").replace(/error: test failed.*\n/, "");
    expect(classifyCheck({ kind: "test", ok: true, out: ok })).toEqual({ result: "pass", n: 2 });
  });
  test("a forged early-exit stream (no package terminal event) is never a pass", () => {
    const forged = [ev({ Action: "start", Package: "ex/a" }), ev({ Action: "run", Package: "ex/a", Test: "TestReal" }), ev({ Action: "pass", Package: "ex/a", Test: "TestReal", Elapsed: 0 })].join("\n") + "\n";
    expect(classifyCheck({ kind: "test", ok: true, out: forged, runner: "go" }).result).toBe("not_run");
  });
  // Real go: the three places a package can print \x16-marked test2json lines and then exit 0 with syscall.Exit (which Go's os.Exit(0) check does not catch).
  const HAS_GO = spawnSync("go", ["version"], { env: process.env }).status === 0;
  const FORGE = 'fmt.Print("\\x16=== RUN   TestReal\\n\\x16--- PASS: TestReal (0.00s)\\n\\x16PASS\\n\\x16ok  \\texample.com/fx\\t0.001s\\n"); syscall.Exit(0)';
  const IMPL = (extra: string): string => `package fx\n\nimport "fmt"\nimport "syscall"\n\nvar _ = fmt.Sprint\nvar _ = syscall.Getpid\n\nfunc Add(a, b int) int { return a + b }\n${extra}\n`;
  const TEST = (extra: string, body: string): string => `package fx\n\nimport "testing"\nimport "fmt"\nimport "syscall"\n\nvar _ = fmt.Sprint\nvar _ = syscall.Getpid\n\n${extra}\nfunc TestReal(t *testing.T) { ${body} }\n`;
  const SITES: Array<[string, string, string]> = [
    ["init in a test file", IMPL(""), TEST(`func init() { ${FORGE} }`, 't.Fatal("never runs")')],
    ["the test body", IMPL(""), TEST("", FORGE)],
    ["implementation code", IMPL(`func init() { ${FORGE} }`), TEST("", 't.Fatal("never runs")')],
  ];
  const goFixture = (impl: string, test: string): string => {
    const d = mkdtempSync(join(tmpdir(), "hv103a-"));
    writeFileSync(join(d, "go.mod"), "module example.com/fx\n\ngo 1.20\n"); writeFileSync(join(d, "a.go"), impl); writeFileSync(join(d, "a_test.go"), test);
    return d;
  };
  const vctx = (d: string): RunContext => ({ repoDir: d, emit: () => {} }) as unknown as RunContext;
  test.skipIf(!HAS_GO).each(SITES)("real go: a syscall.Exit(0) forge in %s reads as a pass in the stream but earns no pass through verify", async (_n, impl, test) => {
    const d = goFixture(impl, test); try {
      const raw = spawnSync("go", ["test", "-json", "./..."], { cwd: d, encoding: "utf8", env: process.env });
      expect(raw.status).toBe(0);
      if (_n !== "the test body") expect(classifyCheck({ kind: "test", ok: true, out: raw.stdout, runner: "go" }).result).toBe("pass"); // the stream alone is forgeable (a body forge repeats the run event, which the stream check already catches)
      const c = await runCheck(vctx(d), "t", "go", ["test", "-json", "./..."], new AbortController().signal, []);
      expect(c.result).toBe("not_run");
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 120_000);
  test.skipIf(!HAS_GO)("real go: a genuine pass is counted through verify and the deep/suite helper; a name the run never passed is refused", async () => {
    const d = goFixture(IMPL(""), TEST("", "if Add(1, 2) != 3 { t.Fatal(1) }")); try {
      const c = await runCheck(vctx(d), "t", "go", ["test", "-json", "./..."], new AbortController().signal, []);
      expect(c.result).toBe("pass"); expect(c.n).toBe(1);
      const raw = spawnSync("go", ["test", "-json", "./..."], { cwd: d, encoding: "utf8", env: process.env }).stdout;
      const cls = classifyCheck({ kind: "test", ok: true, out: raw, runner: "go" });
      const env = { ...process.env };
      expect((await corroboratePass(cls, raw, "go test -json ./...", undefined, { cwd: d, env })).result).toBe("pass");
      const ghost = raw.replace(/TestReal/g, "TestGhost");
      expect((await corroboratePass(classifyCheck({ kind: "test", ok: true, out: ghost, runner: "go" }), ghost, "go", ["test", "-json", "./..."], { cwd: d, env })).result).toBe("not_run");
      expect((await corroboratePass(cls, raw, "go test -json ./... ; true", undefined, { cwd: d, env })).result).toBe("not_run");
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 120_000);
  // The per-file command runnerCmd builds carries `-run ^(TestA|TestB)$` as an argv element; argv has no shell, so that value must not read as shell syntax.
  const goFile = (d: string): { cmd: string; args: string[] } => { const [cmd, args] = runnerCmd({ runner: "go", path: "a_test.go" }, d); return { cmd, args }; };
  test.skipIf(!HAS_GO)("real go: the generated per-file -run argv of a genuine passing test is counted as a pass through verify", async () => {
    const d = goFixture(IMPL(""), TEST("", "if Add(1, 2) != 3 { t.Fatal(1) }")); try {
      const { cmd, args } = goFile(d); expect(args).toContain("^(TestReal)$");
      const c = await runCheck(vctx(d), "t", cmd, args, new AbortController().signal, []);
      expect(c.result).toBe("pass"); expect(c.n).toBe(1);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 120_000);
  test.skipIf(!HAS_GO)("real go: a failing test through the same -run argv stays red, and a forged exit(0) through it stays not_run", async () => {
    const bad = goFixture(IMPL(""), TEST("", "if Add(1, 2) != 4 { t.Fatal(1) }")), forged = goFixture(IMPL(""), TEST("", FORGE)); try {
      const b = goFile(bad), rb = await runCheck(vctx(bad), "t", b.cmd, b.args, new AbortController().signal, []);
      expect(rb.result).toBe("fail");
      const f = goFile(forged), rf = await runCheck(vctx(forged), "t", f.cmd, f.args, new AbortController().signal, []);
      expect(rf.result).toBe("not_run");
    } finally { rmSync(bad, { recursive: true, force: true }); rmSync(forged, { recursive: true, force: true }); }
  }, 120_000);
  test.skipIf(!HAS_GO)("real go: only the exact generated -run shape is let through; any other metacharacter in argv still refuses", async () => {
    const d = goFixture(IMPL(""), TEST("", "if Add(1, 2) != 3 { t.Fatal(1) }")); try {
      const env = { ...process.env };
      const raw = spawnSync("go", ["test", "-json", "./..."], { cwd: d, encoding: "utf8", env }).stdout, cls = classifyCheck({ kind: "test", ok: true, out: raw, runner: "go" });
      for (const run of ["^(TestReal)$; true", "$(touch x)", "^(TestReal|.*)$"]) expect((await corroboratePass(cls, raw, "go", ["test", "-json", "-run", run, "./..."], { cwd: d, env })).result).toBe("not_run");
      expect((await corroboratePass(cls, raw, "go", ["test", "-json", "./...;true"], { cwd: d, env })).result).toBe("not_run");
      expect((await corroboratePass(cls, raw, "go test -json -run ^(TestReal)$ ./...", undefined, { cwd: d, env })).result).toBe("not_run"); // a shell line stays refused
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 120_000);
  test.skipIf(!HAS_GO)("real go: a package with no statements has no completion proof and stays not_run", async () => {
    const d = goFixture("package fx\n", 'package fx\n\nimport "testing"\n\nfunc TestReal(t *testing.T) {}\n'); try {
      const c = await runCheck(vctx(d), "t", "go", ["test", "-json", "./..."], new AbortController().signal, []);
      expect(c.result).toBe("not_run");
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 120_000);
});

// HV1-03d: a pass needs completion proof the code under test cannot cheaply produce. Real cargo and go fixtures.
describe("forged cargo and go passes earn no pass", () => {
  const HAS_GO = spawnSync("go", ["version"], { env: process.env }).status === 0;
  const HAS_CARGO = spawnSync("cargo", ["--version"], { env: process.env }).status === 0;
  const vctx = (d: string): RunContext => ({ repoDir: d, emit: () => {} }) as unknown as RunContext;
  const cargoFixture = (impl: string): string => {
    const d = mkdtempSync(join(tmpdir(), "hv103d-"));
    mkdirSync(join(d, "src")); writeFileSync(join(d, "Cargo.toml"), '[package]\nname = "fx"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFileSync(join(d, "src", "lib.rs"), `${impl}\n#[cfg(test)]\nmod t {\n    #[test]\n    fn real() { assert_eq!(super::add(1, 2), 3); }\n    #[test]\n    fn second() { assert_eq!(super::add(2, 2), 4); }\n}\n`);
    return d;
  };
  const CARGO_FORGE = 'pub fn add(_a: i32, _b: i32) -> i32 {\n    use std::io::Write;\n    std::io::stdout().write_all(b"\\ntest result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\\n\\n").unwrap();\n    std::process::exit(0);\n}';
  test.skipIf(!HAS_CARGO)("real cargo: a printed summary plus process::exit(0) is not a pass; a genuine run counts both tests", async () => {
    const f = cargoFixture(CARGO_FORGE), g = cargoFixture("pub fn add(a: i32, b: i32) -> i32 { a + b }"); try {
      const raw = spawnSync("cargo", ["test"], { cwd: f, encoding: "utf8", env: process.env });
      expect(raw.status).toBe(0); expect(raw.stdout).toContain("2 passed"); // the forge really exits 0 and prints a passing summary
      expect((await runCheck(vctx(f), "t", "cargo", ["test"], new AbortController().signal, [])).result).toBe("not_run");
      const c = await runCheck(vctx(g), "t", "cargo", ["test"], new AbortController().signal, []);
      expect(c.result).toBe("pass"); expect(c.n).toBe(2);
    } finally { rmSync(f, { recursive: true, force: true }); rmSync(g, { recursive: true, force: true }); }
  }, 240_000);
  test("cargo: a summary needs its own ok lines, and a headerless trailer is not libtest output", () => {
    const sum = "test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n";
    expect(classifyCheck({ kind: "test", ok: true, out: `\nrunning 2 tests\n${sum}` }).result).toBe("not_run");
    expect(classifyCheck({ kind: "test", ok: true, out: `\nrunning 2 tests\ntest a ... ok\n${sum}` }).result).toBe("not_run");
    expect(classifyCheck({ kind: "test", ok: true, out: `\nrunning 2 tests\ntest a ... ok\ntest b ... ok\n\n${sum}` })).toEqual({ result: "pass", n: 2 });
    expect(classifyCheck({ kind: "test", ok: true, out: `\nrunning 2 tests\n..\n\n${sum}` })).toEqual({ result: "pass", n: 2 });
    expect(classifyCheck({ kind: "test", ok: true, out: `\n${sum}` }).result).toBe("not_run");
  });
  // The forge reads -test.coverprofile= from os.Args, writes a plausible profile there, prints framed pass events and leaves with syscall.Exit(0).
  const GO_FORGE = `package fx

import (
	"fmt"
	"os"
	"strings"
	"syscall"
)

func init() {
	for _, x := range os.Args {
		if strings.HasPrefix(x, "-test.coverprofile=") {
			os.WriteFile(strings.TrimPrefix(x, "-test.coverprofile="), []byte("mode: set\\nexample.com/fx/a.go:11.24,12.74 2 1\\n"), 0o644)
		}
	}
	fmt.Print("\\x16=== RUN   TestReal\\n\\x16--- PASS: TestReal (0.00s)\\n\\x16PASS\\n\\x16ok  \\texample.com/fx\\t0.001s\\n")
	syscall.Exit(0)
}

func Add(a, b int) int { return a + b }
`;
  const goFixture = (impl: string): string => {
    const d = mkdtempSync(join(tmpdir(), "hv103d-"));
    writeFileSync(join(d, "go.mod"), "module example.com/fx\n\ngo 1.20\n"); writeFileSync(join(d, "a.go"), impl);
    writeFileSync(join(d, "a_test.go"), 'package fx\n\nimport "testing"\n\nfunc TestReal(t *testing.T) { if Add(1, 2) != 3 { t.Fatal(1) } }\n');
    return d;
  };
  test.skipIf(!HAS_GO)("real go: a forged coverage profile and framed events with syscall.Exit(0) is not a pass; a genuine run counts", async () => {
    const f = goFixture(GO_FORGE), g = goFixture("package fx\n\nfunc Add(a, b int) int { return a + b }\n"); try {
      const raw = spawnSync("go", ["test", "-json", "./..."], { cwd: f, encoding: "utf8", env: process.env });
      expect(raw.status).toBe(0);
      expect(classifyCheck({ kind: "test", ok: true, out: raw.stdout, runner: "go" }).result).toBe("pass"); // the stream alone is forgeable
      expect((await runCheck(vctx(f), "t", "go", ["test", "-json", "./..."], new AbortController().signal, [])).result).toBe("not_run");
      const c = await runCheck(vctx(g), "t", "go", ["test", "-json", "./..."], new AbortController().signal, []);
      expect(c.result).toBe("pass"); expect(c.n).toBe(1);
    } finally { rmSync(f, { recursive: true, force: true }); rmSync(g, { recursive: true, force: true }); }
  }, 240_000);
});

// HV1-03d round 2: whole-run refusal for a forged cargo summary, split --nocapture lines, and Go packages the cover table cannot prove.
describe("cargo and go completion proof edge cases", () => {
  const HAS_GO = spawnSync("go", ["version"], { env: process.env }).status === 0;
  const HAS_CARGO = spawnSync("cargo", ["--version"], { env: process.env }).status === 0;
  const vctx = (d: string): RunContext => ({ repoDir: d, emit: () => {} }) as unknown as RunContext;
  const cargoDir = (lib: string, extra: Record<string, string> = {}): string => {
    const d = mkdtempSync(join(tmpdir(), "hv103d2-"));
    mkdirSync(join(d, "src")); mkdirSync(join(d, "tests")); writeFileSync(join(d, "Cargo.toml"), '[package]\nname = "fx"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFileSync(join(d, "src", "lib.rs"), lib);
    for (const [k, v] of Object.entries(extra)) writeFileSync(join(d, k), v);
    return d;
  };
  const SUM = "test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s";
  test.skipIf(!HAS_CARGO)("real cargo: a forged lib summary stays not_run even when an honest integration binary follows it", async () => {
    const forge = `pub fn add(_a: i32, _b: i32) -> i32 {\n    use std::io::Write;\n    std::io::stdout().write_all(b"\\n${SUM}\\n\\n").unwrap();\n    std::process::exit(0);\n}\n#[cfg(test)]\nmod t {\n    #[test]\n    fn real() { assert_eq!(super::add(1, 2), 3); }\n    #[test]\n    fn second() { assert_eq!(super::add(2, 2), 4); }\n}\n`;
    const d = cargoDir(forge, { "tests/it.rs": "#[test]\nfn honest() { assert_eq!(1 + 1, 2); }\n" }); try {
      const raw = spawnSync("cargo", ["test"], { cwd: d, encoding: "utf8", env: process.env });
      expect(raw.status).toBe(0);
      expect(classifyCheck({ kind: "test", ok: true, out: raw.stdout }).result).toBe("not_run");
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 240_000);
  test.skipIf(!HAS_CARGO)("real cargo: --nocapture --test-threads=1 splits ok lines and still counts every test", () => {
    const body = [1, 2, 3, 4].map((k) => `    #[test]\n    fn t${k}() { println!("hello"); assert_eq!(1, 1); }\n`).join("");
    const d = cargoDir(`pub fn add(a: i32, b: i32) -> i32 { a + b }\n#[cfg(test)]\nmod t {\n${body}}\n`); try {
      const raw = spawnSync("cargo", ["test", "--", "--nocapture", "--test-threads=1"], { cwd: d, encoding: "utf8", env: process.env });
      expect(raw.stdout).toMatch(/test t::t1 \.\.\. hello/);
      expect(classifyCheck({ kind: "test", ok: true, out: raw.stdout })).toEqual({ result: "pass", n: 4 });
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 240_000);
  test("cargo: the unfixable limit is real, an invented ok line per claimed pass still counts", () => {
    expect(classifyCheck({ kind: "test", ok: true, out: `\nrunning 2 tests\ntest x ... ok\ntest y ... ok\n\n${SUM}\n` })).toEqual({ result: "pass", n: 2 });
  });
  // Shapes captured from a real `cargo test -- --nocapture --test-threads=1` (stdout and stderr joined); the trailing space after "..." is real.
  const PANIC_SPLIT = "\nrunning 2 tests\ntest boom - should panic ... \nthread 'boom' panicked at src/lib.rs:2:37:\nboom\nnote: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\nok\ntest plain ... ok\n\ntest result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n";
  const PRINT_NO_NL = "\nrunning 3 tests\ntest a ... ok\ntest b ... ok\ntest printer ... hellook\n\ntest result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n";
  test("cargo: a should_panic message splitting the test line from its ok still counts", () => {
    expect(classifyCheck({ kind: "test", ok: true, out: PANIC_SPLIT })).toEqual({ result: "pass", n: 2 });
  });
  test("cargo: a print! without a newline fused to the ok still counts", () => {
    expect(classifyCheck({ kind: "test", ok: true, out: PRINT_NO_NL })).toEqual({ result: "pass", n: 3 });
  });
  test("cargo: a pending test name followed by a line that does not end in ok does not count", () => {
    const out = "\nrunning 2 tests\ntest boom - should panic ... \nthread 'boom' panicked at src/lib.rs:2:37:\nboom\ntest plain ... ok\n\ntest result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n";
    expect(classifyCheck({ kind: "test", ok: true, out }).result).toBe("not_run");
  });
  test.skipIf(!HAS_CARGO)("real cargo: a should_panic test and a print! without newline under --nocapture still count", () => {
    const lib = '#[test]\nfn plain() { assert_eq!(1, 1); }\n#[test]\n#[should_panic]\nfn boom() { panic!("boom"); }\n#[test]\nfn printer() { print!("hello"); }\n';
    const d = cargoDir(lib); try {
      const raw = spawnSync("cargo", ["test", "--", "--nocapture", "--test-threads=1"], { cwd: d, encoding: "utf8", env: process.env });
      expect(raw.status).toBe(0);
      expect(classifyCheck({ kind: "test", ok: true, out: raw.stdout })).toEqual({ result: "pass", n: 3 });
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 240_000);
  const goDir = (impl: string, test: string, extra: Record<string, string> = {}): string => {
    const d = mkdtempSync(join(tmpdir(), "hv103d2-"));
    writeFileSync(join(d, "go.mod"), "module example.com/fx\n\ngo 1.20\n"); writeFileSync(join(d, "a.go"), impl); writeFileSync(join(d, "a_test.go"), test);
    for (const [k, v] of Object.entries(extra)) writeFileSync(join(d, k), v);
    return d;
  };
  const verdict = async (d: string) => (await runCheck(vctx(d), "t", "go", ["test", "-json", "./..."], new AbortController().signal, [])).result;
  const T_OK = 'package fx\n\nimport "testing"\n\nfunc TestReal(t *testing.T) {}\n';
  test.skipIf(!HAS_GO)("real go: a forged pass in a package with no statements is not a pass", async () => {
    const forge = 'package fx\n\nimport (\n\t"fmt"\n\t"os"\n\t"strings"\n\t"syscall"\n\t"testing"\n)\n\nfunc init() {\n\tfor _, x := range os.Args {\n\t\tif strings.HasPrefix(x, "-test.coverprofile=") {\n\t\t\tos.WriteFile(strings.TrimPrefix(x, "-test.coverprofile="), []byte("mode: set\\n"), 0o644)\n\t\t}\n\t}\n\tfmt.Print("\\x16=== RUN   TestReal\\n\\x16--- PASS: TestReal (0.00s)\\n\\x16PASS\\n\\x16ok  \\texample.com/fx\\t0.001s\\n")\n\tsyscall.Exit(0)\n}\n\nfunc TestReal(t *testing.T) {}\n';
    const d = goDir("package fx\n\ntype T struct{}\n\nconst K = 1\n", forge); try {
      const raw = spawnSync("go", ["test", "-json", "./..."], { cwd: d, encoding: "utf8", env: process.env });
      expect(classifyCheck({ kind: "test", ok: true, out: raw.stdout, runner: "go" }).result).toBe("pass"); // the stream alone is forgeable
      expect(await verdict(d)).toBe("not_run");
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 240_000);
  test.skipIf(!HAS_GO)("real go: a package with a //line directive is honestly not_run, never a silent pass", async () => {
    const d = goDir('package fx\n\n//line gen.go:10\nfunc Add(a, b int) int { return a + b }\n', T_OK); try {
      expect(await verdict(d)).toBe("not_run");
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 240_000);
  test.skipIf(!HAS_GO || spawnSync("go", ["env", "CGO_ENABLED"], { encoding: "utf8" }).stdout.trim() !== "1")("real go: a package with a cgo file is honestly not_run", async () => {
    const d = goDir("package fx\n\nfunc Add(a, b int) int { return a + b }\n", T_OK, { "c.go": "package fx\n\n// int one = 1;\nimport \"C\"\n" }); try {
      expect(spawnSync("go", ["test", "./..."], { cwd: d, encoding: "utf8" }).status).toBe(0); // the repo is genuine
      expect(await verdict(d)).toBe("not_run");
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 240_000);
});

// HV1-03e: a cargo pass must match the tests cargo itself lists for the same command (`-- --list`), which runs no test function.
describe("cargo pass matches the runner's own listing", () => {
  const HAS_CARGO = spawnSync("cargo", ["--version"], { env: process.env }).status === 0;
  const vctx = (d: string): RunContext => ({ repoDir: d, emit: () => {} }) as unknown as RunContext;
  const crate = (lib: string, extra: Record<string, string> = {}): string => {
    const d = mkdtempSync(join(tmpdir(), "hv103e-"));
    mkdirSync(join(d, "src")); mkdirSync(join(d, "tests")); writeFileSync(join(d, "Cargo.toml"), '[package]\nname = "fx"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFileSync(join(d, "src", "lib.rs"), lib);
    for (const [k, v] of Object.entries(extra)) writeFileSync(join(d, k), v);
    return d;
  };
  const TESTS = "#[cfg(test)]\nmod t {\n    #[test]\n    fn real() { assert_eq!(super::add(1, 2), 3); }\n    #[test]\n    fn second() { assert_eq!(super::add(2, 2), 4); }\n}\n";
  const forge = (lines: string, n: number): string => `pub fn add(_a: i32, _b: i32) -> i32 {\n    use std::io::Write;\n    std::io::stdout().write_all(b"${lines}\\ntest result: ok. ${n} passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\\n\\n").unwrap();\n    std::process::exit(0);\n}\n${TESTS}`;
  const verdict = (d: string, args = ["test"]) => runCheck(vctx(d), "t", "cargo", args, new AbortController().signal, []);
  test.skipIf(!HAS_CARGO)("real cargo: forged ok lines for invented names, or more passes than listed, are not a pass", async () => {
    const a = crate(forge("test a ... ok\\ntest b ... ok", 2)), b = crate(forge("test t::real ... ok\\ntest t::second ... ok\\ntest t::third ... ok", 3)); try {
      for (const d of [a, b]) {
        const raw = spawnSync("cargo", ["test"], { cwd: d, encoding: "utf8", env: process.env });
        expect(raw.status).toBe(0);
        expect(classifyCheck({ kind: "test", ok: true, out: raw.stdout }).result).toBe("pass"); // the output alone reads pass
        const c = await verdict(d);
        expect(c.result).toBe("not_run"); expect(c.reason).toBe(CARGO_UNLISTED_REASON);
      }
    } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
  }, 240_000);
  test.skipIf(!HAS_CARGO)("real cargo: a genuine crate with ignored, should_panic, doctest and integration tests still reads pass", async () => {
    const lib = '/// ```\n/// assert_eq!(fx::add(1, 2), 3);\n/// ```\n/// ```compile_fail\n/// let x: i32 = "a";\n/// ```\n/// ```ignore\n/// nope\n/// ```\npub fn add(a: i32, b: i32) -> i32 { a + b }\n#[cfg(test)]\nmod t {\n    #[test]\n    fn real() { assert_eq!(super::add(1, 2), 3); }\n    #[test]\n    #[ignore]\n    fn slow() {}\n    #[test]\n    #[should_panic]\n    fn boom() { panic!("b"); }\n}\n';
    const d = crate(lib, { "tests/it.rs": '#[test]\nfn honest() { assert_eq!(fx::add(2, 2), 4); }\n#[test]\n#[ignore = "why"]\nfn later() {}\n' }); try {
      expect(await verdict(d)).toMatchObject({ result: "pass", n: 5 });
      expect(await verdict(d, ["test", "--", "--nocapture", "--test-threads=1"])).toMatchObject({ result: "pass", n: 5 });
      expect(await verdict(d, ["test", "--test", "it"])).toMatchObject({ result: "pass", n: 1 });
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 240_000);
  test.skipIf(!HAS_CARGO)("real cargo: test output ending in a word ending in ok (look) plus a forged summary under --nocapture is not a pass", async () => {
    const d = crate(forge("look\\n", 1)), args = ["test", "--", "--nocapture", "--test-threads=1"]; try {
      const raw = spawnSync("cargo", args, { cwd: d, encoding: "utf8", env: process.env });
      expect(raw.status).toBe(0); expect(raw.stdout).toContain("look");
      expect(classifyCheck({ kind: "test", ok: true, out: raw.stdout }).result).toBe("pass"); // the output alone reads pass: "look" ends in ok
      const c = await verdict(d, args);
      expect(c.result).toBe("not_run"); expect(c.reason).toBe(CARGO_UNLISTED_REASON);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 240_000);
  test.skipIf(!HAS_CARGO)("real cargo: the residual forge is real, the exact listed names with a matching summary still read pass", async () => {
    const d = crate(forge("test t::real ... ok\\ntest t::second ... ok", 2)); try {
      expect((await verdict(d)).result).toBe("pass");
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 240_000);
  test("a cargo pass under libtest flags the listing cannot mirror is not_run without running anything", async () => {
    const pass = { result: "pass" as const, n: 1 }, o = { cwd: tmpdir(), env: process.env };
    for (const a of [["test", "--", "--include-ignored"], ["test", "--", "--ignored"], ["test", "--", "-Zunstable-options", "--format", "json"], ["test", "$(x)"]]) expect(await corroboratePass(pass, "", "cargo", a, o)).toEqual({ result: "not_run", reason: CARGO_UNLISTED_REASON });
    expect(await corroboratePass({ result: "fail", n: 1 }, "", "cargo", ["test"], o)).toEqual({ result: "fail", n: 1 });
  });
});

// HV1-03f: seal accuracy residuals in the cargo listing check.
describe("cargo listing check residuals", () => {
  const HAS_CARGO = spawnSync("cargo", ["--version"], { env: process.env }).status === 0;
  const vctx = (d: string): RunContext => ({ repoDir: d, emit: () => {} }) as unknown as RunContext;
  const crate = (lib: string, extra: Record<string, string> = {}): string => {
    const d = mkdtempSync(join(tmpdir(), "hv103f-"));
    mkdirSync(join(d, "src")); writeFileSync(join(d, "Cargo.toml"), '[package]\nname = "fx"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFileSync(join(d, "src", "lib.rs"), lib);
    for (const [k, v] of Object.entries(extra)) { mkdirSync(dirname(join(d, k)), { recursive: true }); writeFileSync(join(d, k), v); }
    return d;
  };
  const GOOD = "pub fn add(a: i32, b: i32) -> i32 { a + b }\n#[cfg(test)]\nmod t {\n    #[test]\n    fn real() { assert_eq!(super::add(1, 2), 3); }\n    #[test]\n    fn second() { assert_eq!(super::add(2, 2), 4); }\n}\n";
  const FORGE = 'pub fn add(_a: i32, _b: i32) -> i32 {\n    use std::io::Write;\n    std::io::stdout().write_all(b"test a ... ok\\ntest b ... ok\\ntest result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\\n").unwrap();\n    std::process::exit(0);\n}\n#[cfg(test)]\nmod t {\n    #[test]\n    fn real() { super::add(1, 2); }\n}\n';
  const run = (d: string, cmd: string, args: string[]) => runCheck(vctx(d), "t", cmd, args, new AbortController().signal, []);
  test.skipIf(!HAS_CARGO)("real cargo: env and toolchain prefixes on a forged pass are not a pass", async () => {
    const d = crate(FORGE); try {
      for (const [cmd, args] of [["env", ["RUST_BACKTRACE=1", "cargo", "test"]], ["env", ["cargo", "test"]], ["cargo", ["+stable", "test"]]] as [string, string[]][]) {
        const raw = spawnSync(cmd, args, { cwd: d, encoding: "utf8", env: process.env });
        if (raw.status !== 0) continue; // no +stable toolchain here: nothing forged to refuse
        expect(classifyCheck({ kind: "test", ok: true, out: raw.stdout }).result).toBe("pass");
        expect((await run(d, cmd, args)).result).toBe("not_run");
      }
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 240_000);
  test("a pass from an env, toolchain or cd cargo test line never survives corroboration", async () => {
    const pass = { result: "pass" as const, n: 2 }, o = { cwd: tmpdir(), env: process.env };
    for (const line of ["RUST_BACKTRACE=1 cargo test", "env cargo test", "cargo +stable test", "cd . && cargo test", "cd sub && RUST_LOG=x cargo test -q"]) expect(await corroboratePass(pass, "", line, undefined, o)).toEqual({ result: "not_run", reason: CARGO_UNLISTED_REASON });
    expect(await corroboratePass(pass, "", "env", ["A=1", "cargo", "test"], o)).toEqual({ result: "not_run", reason: CARGO_UNLISTED_REASON });
    for (const line of ["cargo clippy", "cargo build", "cargo fmt --check", "cargo --locked build"]) expect(await corroboratePass(pass, "", line, undefined, o)).toEqual(pass); // not a cargo test: untouched
  });
  test.skipIf(!HAS_CARGO)("real cargo: cargo test -q on a genuine crate still reads pass", async () => {
    const d = crate(GOOD); try {
      expect(await run(d, "cargo", ["test", "-q"])).toMatchObject({ result: "pass", n: 2 });
      expect(await run(d, "cargo", ["test", "--quiet", "--", "--test-threads=1"])).toMatchObject({ result: "pass", n: 2 });
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 240_000);
  test.skipIf(!HAS_CARGO)("real cargo: a repo target runner wrapping run and listing is not a pass", async () => {
    const d = crate(GOOD, { ".cargo/config.toml": "[target.'cfg(all())']\nrunner = \"env\"\n" }); try {
      const c = await run(d, "cargo", ["test"]);
      expect(c.result).toBe("not_run"); expect(c.reason).toBe(CARGO_RUNNER_REASON);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 240_000);
  test.skipIf(!HAS_CARGO)("real cargo: a runner in an ancestor config, a runner env var or --config is refused; a config without one is not", async () => {
    const outer = crate("", { "pkg/.keep": "", ".cargo/config": "[target.x86_64-unknown-linux-gnu]\nrunner = ['env']\n" }), d = crate(GOOD), e = crate(GOOD, { ".cargo/config.toml": "[build]\njobs = 2\n" }); try {
      const pass = { result: "pass" as const, n: 2 };
      expect((await corroboratePass(pass, "", "cargo", ["test"], { cwd: join(outer, "pkg"), env: process.env })).reason).toBe(CARGO_RUNNER_REASON);
      expect((await corroboratePass(pass, "", "cargo", ["test"], { cwd: d, env: { ...process.env, CARGO_TARGET_X86_64_APPLE_DARWIN_RUNNER: "env" } })).reason).toBe(CARGO_RUNNER_REASON);
      expect((await corroboratePass(pass, "", "cargo", ["test", "--config", "target.x.runner=env"], { cwd: d, env: process.env })).reason).toBe(CARGO_RUNNER_REASON);
      expect((await run(e, "cargo", ["test"])).result).toBe("pass");
    } finally { for (const x of [outer, d, e]) rmSync(x, { recursive: true, force: true }); }
  }, 240_000);
  test.skipIf(!HAS_CARGO)("real cargo: an aborted stage signal stops the listing and the pass is not counted", async () => {
    const d = crate(GOOD); try {
      const raw = spawnSync("cargo", ["test"], { cwd: d, encoding: "utf8", env: process.env }), ac = new AbortController(); ac.abort();
      expect((await corroboratePass({ result: "pass", n: 2 }, raw.stdout, "cargo", ["test"], { cwd: d, env: process.env, signal: ac.signal })).result).toBe("not_run");
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 240_000);
  // Round 2: the command shape and the runner config are classified generically, not by a list of known spellings.
  test.skipIf(!HAS_CARGO)("real cargo: a forged pass behind any wrapper, shell or alias is not a pass; a plain line is checked against the listing", async () => {
    const d = crate(FORGE); try {
      const shapes: [string, string[]][] = [["nice", ["cargo", "test"]], ["timeout", ["600", "cargo", "test"]], ["sh", ["-c", "cargo test"]], ["cargo", ["t"]], ["cargo", ["--color", "never", "test"]]];
      for (const [cmd, args] of shapes) {
        const raw = spawnSync(cmd, args, { cwd: d, encoding: "utf8", env: process.env });
        expect(raw.status).toBe(0); expect(classifyCheck({ kind: "test", ok: true, out: raw.stdout }).result).toBe("pass");
        expect([cmd, (await run(d, cmd, args)).result]).toEqual([cmd, "not_run"]);
      }
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 240_000);
  test("a cargo or go pass behind bash -lc, a subshell, rustup run, nice, timeout or sh -c is refused without running anything", async () => {
    const pass = { result: "pass" as const, n: 2 }, o = { cwd: tmpdir(), env: process.env };
    for (const [cmd, args] of [["bash", ["-lc", "cargo test"]], ["(cargo", ["test)"]], ["rustup", ["run", "stable", "cargo", "test"]]] as [string, string[]][]) expect([cmd, await corroboratePass(pass, "", cmd, args, o)]).toEqual([cmd, { result: "not_run", reason: CARGO_UNLISTED_REASON }]);
    for (const line of ["(cargo test)", "$(cargo test)", "cargo +nightly test", "cargo test && echo ok"]) expect([line, await corroboratePass(pass, "", line, undefined, o)]).toEqual([line, { result: "not_run", reason: CARGO_UNLISTED_REASON }]);
    for (const line of ["nice go test ./...", "timeout 600 go test ./...", "sh -c 'go test ./...'", "(go test ./...)", "bash -lc \"go test ./...\""]) expect([line, await corroboratePass(pass, "", line, undefined, o)]).toEqual([line, { result: "not_run", reason: GO_EXIT0_REASON }]);
    expect(await corroboratePass(pass, "", "sh", ["-c", "go test ./..."], o)).toEqual({ result: "not_run", reason: GO_EXIT0_REASON });
    expect(goRunner("nice", ["go", "test"])).toEqual({ runner: "go" });
    expect(goRunner("npm", ["test"])).toEqual({});
  });
  test.skipIf(!HAS_CARGO)("real cargo: plain lines with no runner still corroborate", async () => {
    const d = crate(GOOD), cfg = crate(GOOD, { ".cargo/config.toml": "[build]\njobs = 2\n[alias]\nxt = \"test\"\n" }); try {
      for (const args of [["test"], ["t"], ["--color", "never", "test"], ["--locked", "test", "--", "--test-threads=1"], ["test", "--quiet"]]) expect([args, (await run(d, "cargo", args)).result]).toEqual([args, "pass"]);
      expect((await run(cfg, "cargo", ["test"])).result).toBe("pass");
      const raw = spawnSync("cargo", ["test"], { cwd: d, encoding: "utf8", env: process.env }), home = crate(""); mkdirSync(join(home, "ch")); writeFileSync(join(home, "ch", "config.toml"), "[build]\njobs = 2\n");
      try { expect((await corroboratePass({ result: "pass", n: 2 }, raw.stdout, "cargo test", undefined, { cwd: d, env: { ...process.env, CARGO_HOME: join(home, "ch") } })).result).toBe("pass"); } finally { rmSync(home, { recursive: true, force: true }); }
    } finally { rmSync(d, { recursive: true, force: true }); rmSync(cfg, { recursive: true, force: true }); }
  }, 240_000);
  const RUNNER_FORMS: [string, string][] = [["dotted key", 'target.aarch64-apple-darwin.runner = "env"\n'], ["single-quoted key", "[target.aarch64-apple-darwin]\n'runner' = \"env\"\n"], ["inline table", '[target]\naarch64-apple-darwin = { runner = "env" }\n'], ["double-quoted key", '[target.aarch64-apple-darwin]\n"runner" = ["env"]\n']];
  for (const [name, body] of RUNNER_FORMS) test.skipIf(!HAS_CARGO)(`real cargo: a repo runner written as a ${name} is refused`, async () => {
    const d = crate(GOOD, { ".cargo/config.toml": body }); try {
      const c = await run(d, "cargo", ["test"]);
      expect(c.result).toBe("not_run"); expect(c.reason).toBe(CARGO_RUNNER_REASON);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 240_000);
  test.skipIf(!HAS_CARGO)("real cargo: a runner in a --config file, or in CARGO_HOME outside the repo's parents, is refused", async () => {
    const d = crate(GOOD, { "rc.toml": 'target.aarch64-apple-darwin.runner = "env"\n' }), home = crate("", { "ch/config.toml": '[target.x86_64-unknown-linux-gnu]\nrunner = "env"\n' }); try {
      const c = await run(d, "cargo", ["test", "--config", "rc.toml"]);
      expect(c.result).toBe("not_run"); expect(c.reason).toBe(CARGO_RUNNER_REASON);
      const raw = spawnSync("cargo", ["test"], { cwd: d, encoding: "utf8", env: process.env });
      expect((await corroboratePass({ result: "pass", n: 2 }, raw.stdout, "cargo test", undefined, { cwd: d, env: { ...process.env, CARGO_HOME: join(home, "ch") } })).reason).toBe(CARGO_RUNNER_REASON);
      expect((await corroboratePass({ result: "pass", n: 2 }, raw.stdout, "cargo test", undefined, { cwd: d, env: { ...process.env, CARGO_HOME: undefined, HOME: join(home, "h") } })).result).toBe("pass"); // HOME with no .cargo: nothing to read
      mkdirSync(join(home, "h", ".cargo"), { recursive: true }); writeFileSync(join(home, "h", ".cargo", "config"), '[target.x86_64-unknown-linux-gnu]\nrunner = "env"\n');
      const { CARGO_HOME: _unused, ...noHome } = process.env;
      expect((await corroboratePass({ result: "pass", n: 2 }, raw.stdout, "cargo test", undefined, { cwd: d, env: { ...noHome, HOME: join(home, "h") } })).reason).toBe(CARGO_RUNNER_REASON); // default ~/.cargo
    } finally { rmSync(d, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  }, 240_000);
  test("spawnCollect kills its child when the signal aborts", async () => {
    const ac = new AbortController(), t0 = Date.now(); setTimeout(() => ac.abort(), 100);
    const r = await spawnCollect("sleep", ["30"], { timeoutMs: 60_000, signal: ac.signal });
    expect(r.status).toBeNull(); expect(Date.now() - t0).toBeLessThan(5000);
  }, 15_000);
});

// A Wall file whose top level imports a module the task creates: red on base (import error), green only after implement.
describe("Wall file importing a module the task will create", () => {
  const WALL = "import unittest\nimport pricing\n\nclass T(unittest.TestCase):\n    def test_total(self):\n        self.assertEqual(pricing.total(2, 3), 6)\n";
  const run = (d: string, mod: string): { status: number | null; output: string } => {
    const r = spawnSync("python3", ["-m", mod === "unittest" ? "unittest" : "pytest", ...(mod === "unittest" ? [] : ["-q", "-p", "no:cacheprovider"]), "tests/loki_wall_pricing.py"], { cwd: d, encoding: "utf8", env: { ...process.env, PYTHONPATH: d } });
    return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
  };
  const repo = (): string => { const d = mkdtempSync(join(tmpdir(), "c1f-")); mkdirSync(join(d, "tests")); writeFileSync(join(d, "tests", "loki_wall_pricing.py"), WALL); return d; };
  const HAS_PYTEST = spawnSync("python3", ["-I", "-c", "import pytest"]).status === 0;
  for (const runner of ["unittest", "pytest"] as const) test.skipIf(runner === "pytest" && !HAS_PYTEST)(`${runner}: red on base, still red while the module is missing, pass once implemented`, () => {
    const d = repo(), f = { runner, path: "tests/loki_wall_pricing.py" }; try {
      const base = run(d, runner);
      expect(classify(f, base.status, base.output, d, "project")).toBe("fail");
      expect(classifyCheck({ kind: "test", ok: false, out: base.output, path: f.path }).result).not.toBe("pass"); // the slice reading never loosens: a still-missing module is no pass
      writeFileSync(join(d, "pricing.py"), "def total(a, b):\n    return a * b\n");
      const head = run(d, runner);
      expect(head.status).toBe(0);
      expect(classify(f, head.status, head.output, d, "project")).toBe("pass");
      writeFileSync(join(d, "pricing.py"), "def total(a, b):\n    return a + b + 100\n");
      const wrong = run(d, runner);
      expect(classify(f, wrong.status, wrong.output, d, "project")).toBe("fail");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("a missing module the repo code already imports, or a module that exists, stays not_run", () => {
    const d = repo(); try {
      const out = "ERROR: x (unittest.loader._FailedTest.x)\nImportError: Failed to import test module: x\nTraceback (most recent call last):\nModuleNotFoundError: No module named 'pricing'\n\nRan 1 test in 0.000s\n\nFAILED (errors=1)\n";
      const f = { runner: "unittest" as const, path: "tests/loki_wall_pricing.py" };
      expect(classify(f, 1, out, d, "project")).toBe("fail");
      writeFileSync(join(d, "app.py"), "import pricing\n");
      expect(classify(f, 1, out, d, "project")).toBe("not_run");
      rmSync(join(d, "app.py")); writeFileSync(join(d, "pricing.py"), "");
      expect(classify(f, 1, out, d, "project")).toBe("not_run");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  // pytest's collection report: the E line, then any Captured section, then the short summary.
  const PYT = (e: string, captured = ""): string => `==== ERRORS ====\n____ ERROR collecting tests/loki_wall_pricing.py ____\ntests/loki_wall_pricing.py:2: in <module>\n    import pricing\nE   ${e}\n${captured}==== short test summary info ====\nERROR tests/loki_wall_pricing.py - ${e}\n!!!! Interrupted: 1 error during collection !!!!\n==== 1 error in 0.03s ====\n`;
  const pf = { runner: "pytest" as const, path: "tests/loki_wall_pricing.py" };
  test("pytest: the E line naming the missing module is red; a name printed in captured output is not", () => {
    const d = repo(); try {
      expect(classify(pf, 2, PYT("ModuleNotFoundError: No module named 'pricing'"), d, "project")).toBe("fail");
      expect(classify(pf, 2, PYT("AttributeError: boom", "----- Captured stderr -----\nModuleNotFoundError: No module named 'zzz'\n"), d, "project")).toBe("not_run"); // column 0, after the real E line
      expect(classify(pf, 2, PYT("AttributeError: boom", "----- Captured stdout -----\n  ModuleNotFoundError: No module named 'zzz' (quoted)\n"), d, "project")).toBe("not_run"); // indented
      expect(classify(pf, 2, PYT("AttributeError: boom", "----- Captured stdout -----\nE   ModuleNotFoundError: No module named 'zzz'\n"), d, "project")).toBe("not_run"); // forged E line after the separator
      expect(classify(pf, 2, PYT("AttributeError: x\nE   ModuleNotFoundError: No module named 'zzz'"), d, "project")).toBe("not_run"); // a multi-line message: pytest prefixes every line with E, only the first is the exception type
      expect(classify({ runner: "unittest", path: pf.path }, 1, "Traceback (most recent call last):\nModuleNotFoundError: No module named 'zzz'\nTraceback (most recent call last):\nAttributeError: boom\n\n----------------------------------------------------------------------\nRan 1 test in 0.000s\n\nFAILED (errors=1)\nImportError: Failed to import test module: x\n", d, "project")).toBe("not_run"); // unittest: only the last line before the Ran footer names the error
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  const MISSING = "yaml_not_installed_q", UT = `ERROR: x (unittest.loader._FailedTest.x)\nImportError: Failed to import test module: x\nTraceback (most recent call last):\nModuleNotFoundError: No module named '${MISSING}'\n\nRan 1 test in 0.000s\n\nFAILED (errors=1)\n`;
  const uf = { runner: "unittest" as const, path: "tests/loki_wall_pricing.py" };
  const MANIFESTS: [string, string, string][] = [
    ["requirements-dev.txt", "requirements-dev.txt", "pytest>=7  # tests\nYaml-Not-Installed.Q==1.0\n"],
    ["requirements.txt with options", "requirements/base.txt", "-r other.txt\n--index-url https://x\nyaml_not_installed_q[extra]>=1\n"],
    ["pyproject project.dependencies", "pyproject.toml", "[project]\nname = \"x\"\ndependencies = [\n  \"requests\",\n  \"yaml-not-installed-q>=1\",\n]\n"],
    ["pyproject optional-dependencies", "pyproject.toml", "[project.optional-dependencies]\ndev = [\"pytest\", \"yaml_not_installed_q\"]\n"],
    ["pyproject dependency-groups", "pyproject.toml", "[dependency-groups]\ntest = [\"yaml-not-installed-q\"]\n"],
    ["pyproject poetry dependencies", "pyproject.toml", "[tool.poetry.dependencies]\npython = \"^3.9\"\nYaml-Not-Installed-Q = { version = \"^1\" }\n"],
    ["pyproject poetry group", "pyproject.toml", "[tool.poetry.group.dev.dependencies]\nyaml-not-installed-q = \"^1\"\n"],
    ["setup.cfg install_requires", "setup.cfg", "[options]\ninstall_requires =\n    requests\n    yaml-not-installed-q>=1\n"],
    ["setup.cfg extras_require", "setup.cfg", "[options.extras_require]\ntest =\n    pytest\n    yaml-not-installed-q\n"],
    ["setup.py install_requires", "setup.py", "from setuptools import setup\nsetup(name='x', install_requires=['requests', 'yaml-not-installed-q>=1'])\n"],
    ["Pipfile", "Pipfile", "[packages]\nrequests = \"*\"\n\n[dev-packages]\nyaml-not-installed-q = \"*\"\n"],
  ];
  for (const [label, file, body] of MANIFESTS) test(`a name declared in ${label} is an environment gap (not_run), undeclared is red`, () => {
    const d = repo(); try {
      expect(classify(uf, 1, UT, d, "project")).toBe("fail");
      mkdirSync(join(d, dirname(file)), { recursive: true }); writeFileSync(join(d, file), body);
      expect(classify(uf, 1, UT, d, "project")).toBe("not_run");
      expect(classify(uf, 1, UT.replaceAll(MISSING, "other_pkg"), d, "project")).toBe("fail"); // only the declared name is a gap
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("a name that an existing non-Wall test file imports is an environment gap", () => {
    const d = repo(); try {
      writeFileSync(join(d, "tests", "test_old.py"), `import ${MISSING}\n`);
      expect(classify(uf, 1, UT, d, "project")).toBe("not_run");
      rmSync(join(d, "tests", "test_old.py")); writeFileSync(join(d, "tests", "loki_wall_other.py"), `import ${MISSING}\n`);
      expect(classify(uf, 1, UT, d, "project")).toBe("fail"); // another Wall file does not count
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("a new submodule of a package the repo imports is red; importing that exact submodule is not", () => {
    const d = repo(), ut = UT.replaceAll(MISSING, "pkg.sub"); try {
      mkdirSync(join(d, "pkg")); writeFileSync(join(d, "pkg", "__init__.py"), ""); writeFileSync(join(d, "app.py"), "import pkg\nfrom pkg import other\nfrom pkg.other import sub2\n");
      expect(classify(uf, 1, ut, d, "project")).toBe("fail");
      for (const src of ["import pkg.sub\n", "import os, pkg.sub as s\n", "from pkg.sub import x\n", "from pkg import sub\n", "from pkg import (\n    a,\n    sub,\n)\n", "import pkg.sub.deep\n"]) {
        writeFileSync(join(d, "app.py"), src); expect([src, classify(uf, 1, ut, d, "project")]).toEqual([src, "not_run"]);
      }
      writeFileSync(join(d, "app.py"), "from pkg import subx\nimport pkg.subx\n"); expect(classify(uf, 1, ut, d, "project")).toBe("fail");
      writeFileSync(join(d, "app.py"), "import pkg.sub\n"); expect(classify(uf, 1, UT.replaceAll(MISSING, "pkg"), d, "project")).toBe("not_run"); // importing a deeper module names its parent
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("src/ layout and namespace packages keep their results; vendored and dot directories are not searched", () => {
    const d = repo(); try {
      mkdirSync(join(d, "src")); writeFileSync(join(d, "src", "pricing.py"), "");
      expect(classify(uf, 1, UT.replaceAll(MISSING, "pricing"), d, "project")).toBe("not_run");
      rmSync(join(d, "src", "pricing.py")); mkdirSync(join(d, "ns")); writeFileSync(join(d, "ns", "mod.py"), "");
      expect(classify(uf, 1, UT.replaceAll(MISSING, "ns.mod"), d, "project")).toBe("not_run");
      expect(classify(uf, 1, UT.replaceAll(MISSING, "ns"), d, "project")).toBe("fail");
      for (const skipped of ["node_modules/x", ".git/x", ".venv/lib", "venv/lib", "__pycache__", "dist", "build", ".hidden"]) {
        mkdirSync(join(d, skipped), { recursive: true }); writeFileSync(join(d, skipped, "pricing.py"), ""); writeFileSync(join(d, skipped, "app.py"), "import pricing\n");
      }
      expect(classify(uf, 1, UT.replaceAll(MISSING, "pricing"), d, "project")).toBe("fail");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe("Wall file that cannot build on base is red on base only for the build tool's own output", () => {
  const ev = (o: Record<string, unknown>): string => JSON.stringify(o);
  const GO_BUILD_FAIL = [
    ev({ ImportPath: "ex/a [ex/a.test]", Action: "build-output", Output: "./a_test.go:3:30: undefined: Missing\n" }),
    ev({ ImportPath: "ex/a [ex/a.test]", Action: "build-fail" }),
    ev({ Action: "start", Package: "ex/a" }),
    ev({ Action: "output", Package: "ex/a", Output: "FAIL\tex/a [build failed]\n" }),
    ev({ Action: "fail", Package: "ex/a", Elapsed: 0, FailedBuild: "ex/a [ex/a.test]" }),
  ].join("\n") + "\n";
  const CARGO_BUILD_FAIL = "   Compiling fx v0.1.0 (/x)\nerror[E0432]: unresolved import `fx::nope`\n\nerror: could not compile `fx` (test \"w\") due to 1 previous error\n";
  const JAVAC_BUILD_FAIL = "src/test/java/CronTest.java:5: error: cannot find symbol\n  Cron c = new Cron();\n";
  const go = { runner: "go" as const, path: "a_test.go" }, cargo = { runner: "cargo" as const, path: "tests/w.rs" }, javac = { runner: "javac" as const, path: "src/test/java/CronTest.java" };
  test.each([["go", go, GO_BUILD_FAIL], ["cargo", cargo, CARGO_BUILD_FAIL], ["javac", javac, JAVAC_BUILD_FAIL]] as const)("%s: build failure with no test started is fail on base", (_n, f, out) => {
    expect(classify(f, f.runner === "cargo" ? 101 : 1, out, "/nonexistent", "project")).toBe("fail");
  });
  test("canary: a go -json run that exits non-zero with no build-fail event and no test started (init panic) stays not_run", () => {
    const ev = (o: Record<string, unknown>): string => JSON.stringify(o);
    const f = { runner: "go" as const, path: "tests/wall_a_test.go" };
    const panic = [ev({ Action: "start", Package: "ex/pkg" }), ev({ Action: "output", Package: "ex/pkg", Output: "panic: init failed\n" }), ev({ Action: "fail", Package: "ex/pkg", Elapsed: 0 })].join("\n") + "\n";
    expect(classify(f, 1, panic, "/x")).toBe("not_run");
    expect(classify(f, 2, "panic: init failed\n\ngoroutine 1 [running]:\n", "/x")).toBe("not_run");
  });
  test("a zero exit, a missing tool or the system interpreter is never red", () => {
    expect(classify(go, 0, GO_BUILD_FAIL, "/nonexistent", "project")).toBe("not_run");
    expect(classify(go, 127, GO_BUILD_FAIL, "/nonexistent", "project")).toBe("not_run");
    expect(classify(cargo, 101, CARGO_BUILD_FAIL, "/nonexistent", "system")).toBe("not_run");
  });
  test("forgery: text a test printed is not a build failure", () => {
    expect(classify(go, 1, "FAIL\tex/a [build failed]\n", "/nonexistent", "project")).toBe("not_run");
    const ranThenPrinted = [ev({ Action: "start", Package: "ex/a" }), ev({ Action: "run", Package: "ex/a", Test: "TestA" }), ev({ Action: "output", Package: "ex/a", Test: "TestA", Output: "FAIL\tex/a [build failed]\n" }), ev({ Action: "pass", Package: "ex/a", Test: "TestA" }), ev({ Action: "pass", Package: "ex/a" })].join("\n") + "\n";
    expect(classify(go, 1, ranThenPrinted, "/nonexistent", "project")).toBe("not_run");
    expect(classify(cargo, 101, `running 1 test\ntest t ... ok\n${CARGO_BUILD_FAIL}`, "/nonexistent", "project")).toBe("not_run");
    expect(classify(javac, 1, `${JAVAC_BUILD_FAIL}LOKI_JAVA_TESTS: 0 run, 0 failed\n`, "/nonexistent", "project")).toBe("not_run");
  });
  test("MUTATION: red on base never yields VERIFIED by itself", () => {
    const o = { wall: { files: [{ path: "a_test.go" }], base_run: { pass: 0, fail: 1, not_run: 0 } }, implement: { exit: "ok" } } as never;
    expect(verdictOf(o, [{ name: "test:a_test.go", result: "fail" }] as never, false, false, false, true, true)).toBe("FAILED"); // still does not build on head: verify records fail
    expect(verdictOf(o, [{ name: "test:a_test.go", result: "not_run" }] as never, false, false, false, false, false)).toBe("PARTIAL"); // never ran on head
    expect(verdictOf(o, [], false, false, false, false, false)).toBe("PARTIAL");
    expect(classifyCheck({ kind: "test", ok: false, out: GO_BUILD_FAIL, runner: "go" }).result).not.toBe("pass");
  });
});
