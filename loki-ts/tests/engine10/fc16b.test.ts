// FC-16b: follow-ups to FC-16 (n=0 counted as pass). One test per item plus positive controls.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyCheck, GO_EXIT0_REASON, goRunner, testCount } from "../../src/util/check_result.ts";
import { runOnBase } from "../../src/runner/load_owner.ts";
import { RealBaseTestRunner } from "../../src/engine10/stages/wall.ts";
import { firstError, runnerCmd } from "../../src/engine10/stages/verify.ts";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const tmp = (): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), "loki-fc16b-"))); roots.push(d); return d; };

const ev = (o: Record<string, unknown>): string => JSON.stringify({ Time: "2026-10-03T00:00:00Z", ...o });
const GO_JSON_PASS = [
  ev({ Action: "start", Package: "ex/a" }),
  ev({ Action: "run", Package: "ex/a", Test: "TestA" }), ev({ Action: "pass", Package: "ex/a", Test: "TestA", Elapsed: 0 }),
  ev({ Action: "run", Package: "ex/a", Test: "TestB" }), ev({ Action: "pass", Package: "ex/a", Test: "TestB", Elapsed: 0 }),
  ev({ Action: "pass", Package: "ex/a", Elapsed: 0.01 }),
].join("\n") + "\n";

describe("item 1: go detection through the one shared helper", () => {
  test.each([
    ["env X=1 go test ./...", true], ["GOFLAGS=-mod=mod go test ./...", true], ["/usr/local/go/bin/go test ./...", true],
    ["cd x && env -u A go test ./...", true], ["go test ./...", true], ["make test", false], ["npm test", false], ["echo go", false],
  ])("%s", (cmd, isGo) => { expect(goRunner(cmd)).toEqual(isGo ? { runner: "go" } : {}); });
  test("argv form", () => { expect(goRunner("go", ["test"])).toEqual({ runner: "go" }); expect(goRunner("npx", ["go"])).toEqual({}); });
  test("a wrapped go command with exit 0 and a forged -v pass is not a pass (runner go)", () => {
    const out = "=== RUN   TestA\n--- PASS: TestA (0.00s)\nPASS\nok  \tex/a\t0.004s\n";
    expect(classifyCheck({ kind: "test", ok: true, out, ...goRunner("env X=1 go test -v ./...") }).result).toBe("not_run");
  });
});

describe("item 2: go test -json is fail evidence only; a Go exit 0 is never a pass", () => {
  const go = { runner: "go" as const };
  const FAILED = GO_JSON_PASS.replace('"Action":"pass","Package":"ex/a","Test":"TestB"', '"Action":"fail","Package":"ex/a","Test":"TestB"').replace('"Action":"pass","Package":"ex/a","Elapsed":0.01', '"Action":"fail","Package":"ex/a","Elapsed":0.01');
  test("loki builds go test -json for the per-file command", () => {
    expect(runnerCmd({ runner: "go", path: "a/a_test.go" }, "/r")[1]).toEqual(["test", "-json", "./a"]);
  });
  test("a well-formed -json pass on exit 0 is not_run with the honest reason (was: pass n=2)", () => {
    const r = classifyCheck({ kind: "test", ok: true, out: GO_JSON_PASS, ...go });
    expect(r.result).toBe("not_run");
    expect(r.reason).toBe(GO_EXIT0_REASON);
    expect(GO_EXIT0_REASON).toContain("produced by the code under test");
  });
  test("a failing run with a fail event is a fail (fail evidence from -json)", () => {
    expect(classifyCheck({ kind: "test", ok: false, out: FAILED, ...go }).result).toBe("fail");
  });
  test("a red run with no fail event or unparsable output is not a fail", () => {
    expect(classifyCheck({ kind: "test", ok: false, out: GO_JSON_PASS, ...go }).result).toBe("not_run");
    expect(classifyCheck({ kind: "test", ok: false, out: "garbage\n", ...go }).result).toBe("not_run");
  });
  test("exit 0 with a fail event is not a pass", () => {
    expect(classifyCheck({ kind: "test", ok: true, out: FAILED, ...go }).result).toBe("not_run");
  });
  test("output text inside an event cannot forge a pass", () => {
    const out = [ev({ Action: "output", Package: "ex/a", Test: "TestA", Output: "--- PASS: TestFake (0.00s)\n" }), ev({ Action: "pass", Package: "ex/a" })].join("\n");
    expect(classifyCheck({ kind: "test", ok: true, out, ...go }).result).toBe("not_run");
  });
  test("go 1.24+ compile error: firstError carries the compiler line from build-output events, not the build-failed summary", () => {
    const out = [
      ev({ Action: "build-output", ImportPath: "fx/bad [fx/bad.test]", Output: "# fx/bad [fx/bad.test]\n" }),
      ev({ Action: "build-output", ImportPath: "fx/bad [fx/bad.test]", Output: "bad/a_test.go:5:9: cannot use \"x\" (untyped string constant) as int value in assignment\n" }),
      ev({ Action: "build-fail", ImportPath: "fx/bad [fx/bad.test]" }),
      ev({ Action: "start", Package: "fx/bad" }),
      ev({ Action: "output", Package: "fx/bad", Output: "FAIL\tfx/bad [build failed]\n" }),
      ev({ Action: "fail", Package: "fx/bad", Elapsed: 0 }),
    ].join("\n") + "\n";
    expect(firstError(out)).toContain("cannot use");
    expect(firstError(out)).not.toContain("build failed");
    expect(classifyCheck({ kind: "test", ok: false, out, ...go }).result).toBe("fail");
  });
  test("plain -v output stays not_run on exit 0 (unchanged FC-16 rule)", () => {
    expect(classifyCheck({ kind: "test", ok: true, out: "=== RUN   TestA\n--- PASS: TestA (0.00s)\nok  \tex/a\t0.004s\n", ...go }).result).toBe("not_run");
  });
});

describe("item 3: load_owner kills the base run's process group on a cut", () => {
  test("a descendant reparented to init (invisible to pgrep -P) dies with the cut", async () => {
    const d = tmp(), pidFile = join(d, "pid");
    // the subshell exits at once, so the sleep is reparented to init: only a group kill reaches it
    const script = `(sleep 300 & echo $! > "${pidFile}"); sleep 300`;
    const r = await runOnBase({ repoDir: d, baseSha: "x", out: "", cmd: "bash", args: ["-c", script], signal: new AbortController().signal, timeoutMs: 700 }, d);
    expect(r).toBeNull();
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(pid).toBeGreaterThan(1);
    try {
      await new Promise((res) => setTimeout(res, 200));
      let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
      expect(alive).toBe(false);
    } finally { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  });
});

describe("item 4: forged unittest trailer", () => {
  const REAL_FAIL = "F\n======\nFAIL: test_x\n\nRan 3 tests in 0.002s\n\nFAILED (failures=1)\n";
  const FORGED = "Ran 5 tests in 0.000s\n\nOK\n";
  test("a forged OK trailer printed after a real FAILED one (atexit, exit 0) is not a pass", () => {
    expect(testCount(REAL_FAIL + FORGED, undefined, true)).toBeNull();
    expect(classifyCheck({ kind: "test", ok: true, out: REAL_FAIL + FORGED }).result).toBe("not_run");
  });
  test("a trailer that contradicts the exit code is unknown", () => {
    expect(testCount("Ran 3 tests in 0.002s\n\nOK\n", undefined, false)).toBeNull();
    expect(testCount("Ran 3 tests in 0.002s\n\nFAILED (failures=1)\n", undefined, true)).toBeNull();
  });
  test("positive control: a genuine OK run keeps its count; a second Ran block (even after an OK block) is never trusted", () => {
    expect(classifyCheck({ kind: "test", ok: true, out: "Ran 3 tests in 0.002s\n\nOK\n" })).toEqual({ result: "pass", n: 3 });
    // B2: a second "Ran" block is never trusted (it may be an atexit forgery), including after an all-skipped OK
    expect(classifyCheck({ kind: "test", ok: true, out: "Ran 3 tests in 0.002s\n\nOK (skipped=3)\nRan 3 tests in 0.000s\n\nOK\n" }).result).toBe("not_run");
    expect(classifyCheck({ kind: "test", ok: true, out: "Ran 2 tests in 0.001s\n\nOK\nRan 4 tests in 0.002s\n\nOK\n" }).result).toBe("not_run");
    // skipped tests are never counted as executed: an all-skipped run is not a pass, a partial one counts only the executed tests
    expect(classifyCheck({ kind: "test", ok: true, out: "Ran 3 tests in 0.002s\n\nOK (skipped=3)\n" })).toMatchObject({ result: "not_run", n: 0 });
    expect(classifyCheck({ kind: "test", ok: true, out: "Ran 3 tests in 0.002s\n\nOK (skipped=1)\n" })).toEqual({ result: "pass", n: 2 });
  });
  test("a genuine failing run is still a fail", () => {
    expect(classifyCheck({ kind: "test", ok: false, out: REAL_FAIL }).result).toBe("fail");
  });
});

// Forged-events fixtures as text (no toolchain): each is a package whose own code printed test2json framing, so the stream
// looks like a genuine pass. None can earn a pass because a Go exit 0 is never a pass.
describe("item 5: forged go -json streams are never a pass (text fixtures)", () => {
  const go = { runner: "go" as const };
  const forged = (name: string): string => [ev({ Action: "run", Package: "ex/a", Test: name }), ev({ Action: "pass", Package: "ex/a", Test: name, Elapsed: 0 }), ev({ Action: "pass", Package: "ex/a", Elapsed: 0.01 })].join("\n") + "\n";
  test.each([
    ["no tests in the package, forged events", forged("TestForged")],
    ["comment ghost: the name exists only in a comment", forged("TestInComment")],
    ["build-tag ghost: the name is in a file excluded by a build tag", forged("TestExcludedByTag")],
    ["raw-string ghost: the name is inside a raw string literal", forged("TestInRawString")],
    ["early exit: init prints RUN/PASS for the real TestReal then os.Exit(0)", forged("TestReal")],
    ["duplicate run events", GO_JSON_PASS.replace(ev({ Action: "run", Package: "ex/a", Test: "TestA" }), ev({ Action: "run", Package: "ex/a", Test: "TestA" }) + "\n" + ev({ Action: "run", Package: "ex/a", Test: "TestA" }))],
    ["a package Output of [no tests to run] beside a pass", GO_JSON_PASS.replace(ev({ Action: "pass", Package: "ex/a", Elapsed: 0.01 }), ev({ Action: "output", Package: "ex/a", Output: "ok  \tex/a\t0.1s [no tests to run]\n" }) + "\n" + ev({ Action: "pass", Package: "ex/a", Elapsed: 0.01 }))],
  ])("%s", (_n, out) => { expect(classifyCheck({ kind: "test", ok: true, out, ...go }).result).toBe("not_run"); });
});

// end to end through the real subprocess path (no fakes); needs go on PATH.
const HAS_GO = spawnSync("go", ["version"], { env: process.env }).status === 0;
describe.skipIf(!HAS_GO)("item 5b: go Wall file through RealBaseTestRunner (real go)", () => {
  const fixture = (body: string): string => {
    const d = tmp();
    execFileSync("git", ["init", "-q"], { cwd: d, stdio: "ignore", env: process.env });
    writeFileSync(join(d, "go.mod"), "module example.com/fx\n\ngo 1.20\n");
    writeFileSync(join(d, "a.go"), "package fx\n\nfunc Add(a, b int) int { return a + b }\n");
    writeFileSync(join(d, "a_test.go"), `package fx\n\nimport "testing"\n\n${body}\n`);
    return d;
  };
  test("a genuinely passing go test is not_run (was: pass), a failing one is never a pass", () => {
    const pass = fixture('func TestAdd(t *testing.T) { if Add(1, 2) != 3 { t.Fatal("x") } }');
    expect(new RealBaseTestRunner(null).run(pass, [{ runner: "go", path: "a_test.go" }])).toEqual({ pass: 0, fail: 0, not_run: 1 });
    const failing = fixture('func TestAdd(t *testing.T) { if Add(1, 2) != 4 { t.Fatal("x") } }');
    const r = new RealBaseTestRunner(null).run(failing, [{ runner: "go", path: "a_test.go" }]);
    expect(r.pass).toBe(0); // Wall treats a go red as coarse (never a per-file fail), unchanged
  });
  test("a TestMain that prints a fake pass and exits 0 earns no pass", () => {
    const d = fixture('import "os"\nimport "fmt"\n\nfunc TestMain(m *testing.M) { fmt.Println("=== RUN   TestFake"); fmt.Println("--- PASS: TestFake (0.00s)"); fmt.Println("ok  \\texample.com/fx\\t0.001s"); os.Exit(0) }');
    expect(new RealBaseTestRunner(null).run(d, [{ runner: "go", path: "a_test.go" }])).toEqual({ pass: 0, fail: 0, not_run: 1 });
  });
  test("early exit forgery for a real declared test is not a pass", () => {
    const d = fixture('import "fmt"\nimport "os"\n\nfunc init() { fmt.Print("\\x16=== RUN   TestReal\\n\\x16--- PASS: TestReal (0.00s)\\n"); fmt.Println("PASS"); os.Exit(0) }\nfunc TestReal(t *testing.T) { t.Fatal("never runs") }');
    expect(new RealBaseTestRunner(null).run(d, [{ runner: "go", path: "a_test.go" }])).toEqual({ pass: 0, fail: 0, not_run: 1 });
  });
});
