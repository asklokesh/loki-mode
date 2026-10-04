// FC-16b: follow-ups to FC-16 (n=0 counted as pass). One test per item plus positive controls.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyCheck, goRunner, testCount } from "../../src/util/check_result.ts";
import { runOnBase } from "../../src/runner/load_owner.ts";
import { RealBaseTestRunner } from "../../src/engine10/stages/wall.ts";
import { runnerCmd } from "../../src/engine10/stages/verify.ts";

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

describe("item 2: go test -json", () => {
  const fx = tmp();
  mkdirSync(join(fx, "a")); writeFileSync(join(fx, "go.mod"), "module ex\n\ngo 1.20\n");
  writeFileSync(join(fx, "a", "a_test.go"), 'package a\nimport "testing"\nfunc TestA(t *testing.T) {}\nfunc TestB(t *testing.T) {}\n');
  const go = { runner: "go" as const, goRoot: fx };
  test("loki builds go test -json for the per-file and deep commands", () => {
    expect(runnerCmd({ runner: "go", path: "a/a_test.go" }, "/r")[1]).toEqual(["test", "-json", "./a"]);
  });
  test("positive control: a genuine -json pass with n>0 earns pass with its count", () => {
    expect(classifyCheck({ kind: "test", ok: true, out: GO_JSON_PASS, ...go })).toEqual({ result: "pass", n: 2 });
  });
  test("exit 0 with a fail event is not a pass", () => {
    const out = GO_JSON_PASS.replace('"Action":"pass","Package":"ex/a","Test":"TestB"', '"Action":"fail","Package":"ex/a","Test":"TestB"');
    expect(classifyCheck({ kind: "test", ok: true, out, ...go }).result).toBe("not_run");
  });
  test("a failing run with a fail event is a fail", () => {
    const out = GO_JSON_PASS.replace('"Action":"pass","Package":"ex/a","Test":"TestB"', '"Action":"fail","Package":"ex/a","Test":"TestB"').replace('"Action":"pass","Package":"ex/a","Elapsed":0.01', '"Action":"fail","Package":"ex/a","Elapsed":0.01');
    expect(classifyCheck({ kind: "test", ok: false, out, ...go }).result).toBe("fail");
  });
  test("parse doubt stays not_run: a non-JSON line, a pass with no run event, a skipped test, a package with no pass", () => {
    expect(classifyCheck({ kind: "test", ok: true, out: GO_JSON_PASS + "PASS\n", ...go }).result).toBe("not_run");
    const noRun = ev({ Action: "pass", Package: "ex/a", Test: "TestForged" }) + "\n" + ev({ Action: "pass", Package: "ex/a" }) + "\n";
    expect(classifyCheck({ kind: "test", ok: true, out: noRun, ...go }).result).toBe("not_run");
    const skipped = [ev({ Action: "run", Package: "ex/a", Test: "TestS" }), ev({ Action: "pass", Package: "ex/a", Test: "TestS" }), ev({ Action: "skip", Package: "ex/a", Test: "TestS" }), ev({ Action: "pass", Package: "ex/a" })].join("\n");
    expect(classifyCheck({ kind: "test", ok: true, out: skipped, ...go }).result).toBe("not_run");
    const noPkg = GO_JSON_PASS.split("\n").slice(0, -2).join("\n");
    expect(classifyCheck({ kind: "test", ok: true, out: noPkg, ...go }).result).toBe("not_run");
  });
  test("output text inside an event cannot forge a count", () => {
    const out = [ev({ Action: "output", Package: "ex/a", Test: "TestA", Output: "--- PASS: TestFake (0.00s)\n" }), ev({ Action: "pass", Package: "ex/a" })].join("\n");
    expect(classifyCheck({ kind: "test", ok: true, out, ...go }).result).toBe("not_run");
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
  test("positive control: a genuine OK run keeps its count, also after an earlier OK block", () => {
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

// item 5: end to end through the real subprocess path (no fakes); needs go on PATH.
const HAS_GO = spawnSync("go", ["version"], { env: process.env }).status === 0;
describe.skipIf(!HAS_GO)("item 5: go Wall file through RealBaseTestRunner (real go)", () => {
  const fixture = (body: string): string => {
    const d = tmp();
    execFileSync("git", ["init", "-q"], { cwd: d, stdio: "ignore", env: process.env });
    writeFileSync(join(d, "go.mod"), "module example.com/fx\n\ngo 1.20\n");
    writeFileSync(join(d, "a.go"), "package fx\n\nfunc Add(a, b int) int { return a + b }\n");
    writeFileSync(join(d, "a_test.go"), `package fx\n\nimport "testing"\n\n${body}\n`);
    return d;
  };
  test("positive control: a passing go test earns pass (n from -json), a skipped-only file does not, a failing one is never pass", () => {
    const pass = fixture('func TestAdd(t *testing.T) { if Add(1, 2) != 3 { t.Fatal("x") } }');
    expect(new RealBaseTestRunner(null).run(pass, [{ runner: "go", path: "a_test.go" }])).toEqual({ pass: 1, fail: 0, not_run: 0 });
    const skip = fixture('func TestAdd(t *testing.T) { t.Skip("later") }');
    expect(new RealBaseTestRunner(null).run(skip, [{ runner: "go", path: "a_test.go" }])).toEqual({ pass: 0, fail: 0, not_run: 1 });
    const failing = fixture('func TestAdd(t *testing.T) { if Add(1, 2) != 4 { t.Fatal("x") } }');
    expect(new RealBaseTestRunner(null).run(failing, [{ runner: "go", path: "a_test.go" }]).pass).toBe(0);
  });
  test("a TestMain that prints a fake pass and exits 0 earns no pass", () => {
    const d = fixture('import "os"\nimport "fmt"\n\nfunc TestMain(m *testing.M) { fmt.Println("=== RUN   TestFake"); fmt.Println("--- PASS: TestFake (0.00s)"); fmt.Println("ok  \\texample.com/fx\\t0.001s"); os.Exit(0) }');
    expect(new RealBaseTestRunner(null).run(d, [{ runner: "go", path: "a_test.go" }])).toEqual({ pass: 0, fail: 0, not_run: 1 });
  });
  const fx2 = (testSrc: string): string => {
    const d = tmp();
    mkdirSync(join(d, "a")); writeFileSync(join(d, "go.mod"), "module fx\n\ngo 1.20\n"); writeFileSync(join(d, "a", "a_test.go"), testSrc);
    return d;
  };
  const goJsonOf = (d: string): { ok: boolean; out: string } => { const r = spawnSync("go", ["test", "-json", "./a"], { cwd: d, encoding: "utf8", env: process.env }); return { ok: r.status === 0, out: `${r.stdout}\n${r.stderr}` }; };
  const FORGE = (name: string): string => `fmt.Print("\\x16=== RUN   ${name}\\n\\x16--- PASS: ${name} (0.00s)\\n")`;
  const verdict = (d: string): string => { const r = goJsonOf(d); return classifyCheck({ kind: "test", ok: r.ok, out: r.out, ...goRunner("go test -json ./a"), goRoot: d }).result; };
  test("B1: a package with NO tests that prints forged test2json run and pass events is not a pass", () => {
    const d = fx2(`package a\nimport "fmt"\nfunc init() { ${FORGE("TestForged")} }\n`);
    const r = goJsonOf(d);
    expect(r.ok).toBe(true); expect(r.out).toContain("TestForged"); // the forgery really reaches the stream
    expect(verdict(d)).toBe("not_run");
  });
  test("B1: the TestMain plus os.Exit(0) variant is not a pass", () => {
    expect(verdict(fx2(`package a\nimport ("fmt"; "os"; "testing")\nfunc TestMain(m *testing.M) { ${FORGE("TestForged")}; os.Exit(0) }\n`))).toBe("not_run");
  });
  test("B1 rule 2 alone: one real skipped test plus forged events for another name (rule 1 does not apply) is not a pass", () => {
    const d = fx2(`package a\nimport ("fmt"; "testing")\nfunc init() { ${FORGE("TestForged")} }\nfunc TestReal(t *testing.T) { t.Skip("later") }\n`);
    const r = goJsonOf(d);
    expect(r.out).not.toContain("no tests to run"); expect(r.out).toContain("TestForged");
    expect(verdict(d)).toBe("not_run");
  });
  test("B1 rule 3: a test name with two run events is not a pass", () => {
    const dup = GO_JSON_PASS.replace(ev({ Action: "run", Package: "ex/a", Test: "TestA" }), ev({ Action: "run", Package: "ex/a", Test: "TestA" }) + "\n" + ev({ Action: "run", Package: "ex/a", Test: "TestA" }));
    expect(classifyCheck({ kind: "test", ok: true, out: dup, runner: "go", goRoot: tmp() }).result).toBe("not_run");
  });
  test("B1 rule 1: a package Output of [no tests to run] discards that package's events", () => {
    const d = tmp(); mkdirSync(join(d, "a")); writeFileSync(join(d, "go.mod"), "module ex\n"); writeFileSync(join(d, "a", "a_test.go"), "package a\nfunc TestA(t *testing.T) {}\nfunc TestB(t *testing.T) {}\n");
    const out = GO_JSON_PASS.replace(ev({ Action: "pass", Package: "ex/a", Elapsed: 0.01 }), ev({ Action: "output", Package: "ex/a", Output: "ok  \tex/a\t0.1s [no tests to run]\n" }) + "\n" + ev({ Action: "pass", Package: "ex/a", Elapsed: 0.01 }));
    expect(classifyCheck({ kind: "test", ok: true, out, runner: "go", goRoot: d }).result).toBe("not_run");
  });
  test("a go pass with no goRoot is not_run, never a pass", () => {
    expect(classifyCheck({ kind: "test", ok: true, out: GO_JSON_PASS, runner: "go" }).result).toBe("not_run");
  });
});
