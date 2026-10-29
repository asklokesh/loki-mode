// FC-02 / Engine Law L5: a runner load or collection error is harness-owned (not_run, no fix rounds);
// a genuine assertion failure stays a code failure. FC-17: a Wall that cannot write a runnable check skips fast.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { classifyRunnerOutput } from "../../src/runner/runner_errors.ts";
import { runCheck, type VerifyCheck } from "../../src/engine10/stages/verify.ts";
import { classify } from "../../src/util/check_result.ts";
import { runWall } from "../../src/engine10/stages/wall.ts";
import { removeHoldout } from "../../src/util/holdout.ts";
import type { RunContext, SessionRunner } from "../../src/engine10/types.ts";

const FX = join(import.meta.dir, "fixtures", "runner-outputs");
const fx = (p: string): string => readFileSync(join(FX, p), "utf8");

describe("FC-02 runner output classifier", () => {
  test("vitest 'Failed Suites 1' load error is harness-owned", () => {
    const o = classifyRunnerOutput(fx("vitest/load-error.txt"));
    expect(o.kind).toBe("load_error");
    expect(o.owner).toBe("harness");
    expect(o.reason).toContain("runner could not load");
  });
  test("pytest collection ImportError is harness-owned", () => {
    expect(classifyRunnerOutput(fx("pytest/collection-error.txt")).kind).toBe("load_error");
  });
  test("unittest import: 'Failed to import test module' is harness-owned", () => {
    const out = [
      "ERROR: test_foo (unittest.loader._FailedTest.test_foo)",
      "----------------------------------------------------------------------",
      "ImportError: Failed to import test module: test_foo",
      "Traceback (most recent call last):",
      "ModuleNotFoundError: No module named 'foo'",
      "",
      "Ran 1 test in 0.000s",
      "",
      "FAILED (errors=1)",
    ].join("\n");
    const o = classifyRunnerOutput(out);
    expect(o.kind).toBe("load_error");
    expect(o.owner).toBe("harness");
    expect(o.reason).toContain("unittest test module import error");
  });
  test("unittest import error mixed with a real assertion failure stays a code failure", () => {
    const out = "ImportError: Failed to import test module: a\nFAIL: test_b (t.T)\nAssertionError: 1 != 2\nFAILED (failures=1, errors=1)";
    expect(classifyRunnerOutput(out).owner).toBe("code");
  });
  test("unittest exit 5 with NO TESTS RAN is not_run, never fail", () => {
    const out = "\n----------------------------------------------------------------------\nRan 0 tests in 0.000s\n\nNO TESTS RAN\n";
    expect(classify({ runner: "unittest", path: "tests/test_a.py" }, 5, out, "/nonexistent", "project")).toBe("not_run");
  });
  test("unittest exit 1 with a FAILED trailer is a fail", () => {
    const out = "FAIL: test_a (t.T)\nAssertionError: 1 != 2\n\nRan 1 test in 0.001s\n\nFAILED (failures=1)\n";
    expect(classify({ runner: "unittest", path: "tests/test_a.py" }, 1, out, "/nonexistent", "project")).toBe("fail");
  });
  test("a genuine vitest assertion failure stays a code failure", () => {
    expect(classifyRunnerOutput(fx("vitest/assertion-failure.txt"))).toEqual({ kind: "test_failure", owner: "code" });
  });
  test("a genuine pytest assertion failure stays a code failure", () => {
    expect(classifyRunnerOutput(fx("pytest/assertion-failure.txt")).owner).toBe("code");
  });
  test("a load error mixed with a real failed test is a code failure", () => {
    expect(classifyRunnerOutput(`${fx("vitest/load-error.txt")}\n${fx("vitest/assertion-failure.txt")}`).owner).toBe("code");
  });
});

function ctxFor(repoDir: string, events: string[], baseSha = ""): RunContext {
  return { repoDir, baseSha, emit: (t: string) => { events.push(t); } } as unknown as RunContext;
}
const sh = (cwd: string, ...a: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" }).trim();
/** A git repo with a base commit holding `files`; returns [dir, baseSha]. */
function repoWith(files: Record<string, string>): [string, string] {
  const dir = mkdtempSync(join(tmpdir(), "loki-fc02-"));
  sh(dir, "init", "-q");
  for (const [f, c] of Object.entries(files)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), c); }
  sh(dir, "add", "-A"); sh(dir, "commit", "-q", "-m", "base");
  return [dir, sh(dir, "rev-parse", "HEAD")];
}
const sig = (): AbortSignal => new AbortController().signal;

describe("FC-02 verify runCheck", () => {
  test("a load error is not_run, owner harness, run once (no rerun), never fail", async () => {
    const [dir, base] = repoWith({ "out.txt": fx("vitest/load-error.txt"), "count": "" });
    try {
      const checks: VerifyCheck[] = [];
      const c = await runCheck(ctxFor(dir, [], base), "vitest:src/a.test.ts", "bash", ["-c", `echo x >> ${dir}/count; cat ${dir}/out.txt; exit 1`], sig(), checks);
      expect(c.result).toBe("not_run");
      expect(c.owner).toBe("harness");
      expect(c.reason).toContain("runner could not load");
      expect(readFileSync(join(dir, "count"), "utf8").trim().split("\n").length).toBe(1); // run once on head; base rerun is in its own worktree
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("a genuine assertion failure is still fail (fix rounds stay)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-fc02-"));
    try {
      writeFileSync(join(dir, "out.txt"), fx("vitest/assertion-failure.txt"));
      const checks: VerifyCheck[] = [];
      const c = await runCheck(ctxFor(dir, []), "vitest:src/sum.test.ts", "bash", ["-c", `cat ${dir}/out.txt; exit 1`], sig(), checks);
      expect(c.result).toBe("fail");
      expect(c.owner).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("a lint check is never reclassified as a runner load error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-fc02-"));
    try {
      const checks: VerifyCheck[] = [];
      const c = await runCheck(ctxFor(dir, []), "lint:tsc", "bash", ["-c", "echo \"error TS2307: Cannot find module 'x'\"; exit 1"], sig(), checks);
      expect(c.result).toBe("fail");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("FC-02 load error ownership (HIGH review B1, B2, N1)", () => {
  const calcOk = "def add(a, b):\n    return a + b\n";
  const testCalc = "from calc import add\n\ndef test_add():\n    assert add(1, 2) == 3\n";
  const pyArgs = (t: string): string[] => ["-m", "pytest", "-q", t];
  const env = { PYTHONDONTWRITEBYTECODE: "1" };
  test("B1: a SyntaxError in a changed source file is fail, not harness not_run", async () => {
    const [dir, base] = repoWith({ "src/calc.py": calcOk, "tests/test_calc.py": testCalc, "conftest.py": "import sys; sys.path.insert(0, 'src')\n" });
    try {
      writeFileSync(join(dir, "src/calc.py"), "def add(a, b)\n    return a + b\n");
      const c = await runCheck(ctxFor(dir, [], base), "pytest:tests/test_calc.py", "python3", pyArgs("tests/test_calc.py"), sig(), [], { path: process.env["PATH"] ?? "" });
      expect(c.result).toBe("fail");
      expect(c.owner).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("B2: a Wall test importing a missing symbol is fail (protected check)", async () => {
    const [dir, base] = repoWith({ "src/calc.py": calcOk, "conftest.py": "import sys; sys.path.insert(0, 'src')\n", "tests/test_wall.py": "from calc import multiply\n\ndef test_m():\n    assert multiply(2, 3) == 6\n" });
    try {
      writeFileSync(join(dir, "README.md"), "x\n");
      const c = await runCheck(ctxFor(dir, [], base), "pytest:tests/test_wall.py", "python3", pyArgs("tests/test_wall.py"), sig(), [], { protect: true });
      expect(c.result).toBe("fail");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("a load error that base also shows, naming no changed file, stays not_run/harness", async () => {
    const [dir, base] = repoWith({ "tests/test_x.py": "import no_such_dep_zz\n\ndef test_x():\n    pass\n", "src/calc.py": calcOk });
    try {
      writeFileSync(join(dir, "src/calc.py"), `${calcOk}# edit\n`);
      const c = await runCheck(ctxFor(dir, [], base), "pytest:tests/test_x.py", "python3", pyArgs("tests/test_x.py"), sig(), [], {});
      expect(c.result).toBe("not_run");
      expect(c.owner).toBe("harness");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("a load error that does NOT reproduce on base is fail", async () => {
    const [dir, base] = repoWith({ "tests/test_x.py": "def test_x():\n    pass\n" });
    try {
      writeFileSync(join(dir, "out.txt"), fx("vitest/load-error.txt")); writeFileSync(join(dir, "mark"), "");
      // head prints a load error; base (clean worktree has no mark file) passes
      const script = `if [ -e ${dir}/mark ]; then cat ${dir}/out.txt; exit 1; fi; exit 0`;
      const c = await runCheck(ctxFor(dir, [], base), "vitest:src/a.test.ts", "bash", ["-c", script], sig(), [], {});
      expect(c.result).toBe("fail");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("N1: arbitrary test output is not a runner load error", () => {
    const o = (s: string) => classifyRunnerOutput(s).kind;
    expect(o("expected output to mention: foo command not found in help text")).toBe("test_failure");
    expect(o("error TS2307: Cannot find module './x' or its corresponding type declarations.")).toBe("test_failure");
    expect(o("  console.log: Cannot find module support is optional")).toBe("test_failure");
    expect(o("Error: Cannot find module '/app/x.js'\nRequire stack:")).toBe("load_error");
    expect(o("bash: line 1: vitest: command not found")).toBe("load_error");
  });
  test("FC-DEPS-NOT-INSTALLED: a runner whose package is not installed is harness-owned; the same words in test output are not", () => {
    const o = (s: string) => classifyRunnerOutput(s);
    const npx = "> frontend@0.1.0 test\n> vitest run\n\nnpm error npx canceled due to missing packages and no YES option: [\"vitest@5.0.5\"]\nnpm error A complete log of this run can be found in: /x.log";
    expect(o(npx)).toMatchObject({ kind: "load_error", owner: "harness" });
    expect(o(npx).reason).toContain("not installed");
    expect(o("npm ERR! canceled due to missing packages and no YES option: [\"jest@29\"]").kind).toBe("load_error");
    expect(o("sh: 1: vitest: not found").kind).toBe("load_error");
    expect(o("> frontend@0.1.0 test\n> vitest run\n\nsh: 1: mytool: not found").reason).toContain("mytool: not found"); // the error line, never the npm banner
    expect(o(npx).reason).toContain("canceled due to missing packages");
    expect(o("expected log to say: npx canceled due to missing packages\n Tests  1 failed | 2 passed").kind).toBe("test_failure");
    expect(o("AssertionError: expected 'sh: 1: x: not found' to be ''").kind).toBe("test_failure");
  });
});

describe("FC-17 Wall no-op precheck", () => {
  test("no runnable test command: skipped in under 10s with a reason, no model session", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "loki-fc17-")), prev = process.env.LOKI_WALL_HARNESS_RUNNER;
    process.env.LOKI_WALL_HARNESS_RUNNER = "0"; // the bun harness fallback off: FC-17's skip is what remains
    try {
      const runDir = join(repoDir, ".loki", "runs", "r1"); mkdirSync(runDir, { recursive: true });
      const ref = join(runDir, "repomap.json");
      writeFileSync(ref, JSON.stringify({ files: ["src/a.ts"], entries: [], truncated: false }));
      let called = 0;
      const sessions: SessionRunner = { async run() { called++; return { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0, killed: false }; } };
      const ctx = { ...ctxFor(repoDir, []), runId: "r1", runDir, sessions, tests: { async detect() { return { runners: [], tests: [] }; }, impacted: () => [] }, outputs: () => ({ intake: { task: "add x", testmap: { runners: [], tests: [] }, repomap_ref: ref } }) } as unknown as RunContext;
      const t0 = Date.now();
      const r = await runWall(ctx, sig());
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(r.status).toBe("skipped");
      expect(r.reason).toContain("no runnable test command");
      expect(called).toBe(0);
    } finally { if (prev === undefined) delete process.env.LOKI_WALL_HARNESS_RUNNER; else process.env.LOKI_WALL_HARNESS_RUNNER = prev; rmSync(repoDir, { recursive: true, force: true }); }
  });
});

describe("TEN-COST-09 Wall skipped when no project interpreter", () => {
  const run = async (venv: boolean, files = ["app.py", "tests/test_app.py"], holdoutOff = true, nFiles = 0): Promise<{ r: Awaited<ReturnType<typeof runWall>>; called: number }> => {
    const repoDir = mkdtempSync(join(tmpdir(), "loki-c09-")), savedVenv = process.env["VIRTUAL_ENV"], savedHo = process.env["LOKI_WALL_HOLDOUT"]; delete process.env["VIRTUAL_ENV"]; if (holdoutOff) process.env["LOKI_WALL_HOLDOUT"] = "0"; else delete process.env["LOKI_WALL_HOLDOUT"];
    try {
      const runDir = join(repoDir, ".loki", "runs", "r1"); mkdirSync(runDir, { recursive: true });
      if (venv) { mkdirSync(join(repoDir, ".venv", "bin"), { recursive: true }); writeFileSync(join(repoDir, ".venv", "bin", "python"), ""); }
      const ref = join(runDir, "repomap.json");
      writeFileSync(ref, JSON.stringify({ files, entries: [], truncated: false }));
      let called = 0;
      const sessions: SessionRunner = { async run(o) { called++; for (let i = 1; i <= nFiles; i++) writeFileSync(join(o.cwd!, `loki_wall_f${i}.py`), `def test_f${i}():\n    assert ${i} + 1 == ${i + 1}\n`); return { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0, killed: false }; } };
      const tm = { runners: ["pytest"], tests: [{ runner: "pytest", path: "tests/test_app.py" }] };
      const ctx = { ...ctxFor(repoDir, []), runId: "r1", runDir, sessions, tests: { async detect() { return tm; }, impacted: () => [] }, outputs: () => ({ intake: { task: "add a feature to the app with new behavior across modules", testmap: tm, repomap_ref: ref } }) } as unknown as RunContext;
      process.env["LOKI_E10_PLAN"] = "always"; process.env["LOKI_E10_WALL_FIRST"] = "0"; // single rung: these assert one session, and the trivial always-green tests would otherwise escalate (COST-11)
      const r = await runWall(ctx, sig());
      return { r, called };
    } finally { delete process.env["LOKI_E10_PLAN"]; delete process.env["LOKI_E10_WALL_FIRST"]; if (savedHo === undefined) delete process.env["LOKI_WALL_HOLDOUT"]; else process.env["LOKI_WALL_HOLDOUT"] = savedHo; if (savedVenv !== undefined) process.env["VIRTUAL_ENV"] = savedVenv; removeHoldout("r1", repoDir); rmSync(repoDir, { recursive: true, force: true }); }
  };
  test("holdout off, pytest repo without a venv: no session, skip names the reason and carries not_proven", async () => {
    const { r, called } = await run(false);
    expect(r.status).toBe("skipped");
    expect(r.reason).toBe("Wall skipped: no project test interpreter");
    expect(r.data["not_proven"]).toEqual(["Wall skipped: no project test interpreter"]);
    expect(called).toBe(0);
  });
  test("holdout default on, 5-file pytest Wall without a venv: NOT skipped, holdout_dir produced", async () => {
    const { r, called } = await run(false, undefined, false, 5);
    expect(called).toBe(1);
    expect(r.reason ?? "").not.toContain("no project test interpreter");
    expect(r.data["not_proven"]).toBeUndefined();
    expect(typeof r.data["holdout_dir"]).toBe("string");
  });
  test("pytest repo with a .venv: the Wall session still starts", async () => {
    const { r, called } = await run(true);
    expect(called).toBe(1);
    expect(r.reason ?? "").not.toContain("no project test interpreter");
  });
});

describe("FC-WALL-HARNESS-TOOLCHAIN-ON-FOREIGN-STACK Wall runs in the repo's own stack", () => {
  const wallFor = async (files: string[], authored: Record<string, string>, extra: Record<string, string> = {}): Promise<{ r: Awaited<ReturnType<typeof runWall>>; brief: string; called: number }> => {
    const repoDir = mkdtempSync(join(tmpdir(), "loki-fcts-")), prev = process.env.LOKI_E10_WALL_FIRST;
    process.env.LOKI_E10_WALL_FIRST = "0";
    try {
      const runDir = join(repoDir, ".loki", "runs", "r1"); mkdirSync(runDir, { recursive: true });
      for (const [p, c] of Object.entries(extra)) { mkdirSync(dirname(join(repoDir, p)), { recursive: true }); writeFileSync(join(repoDir, p), c); }
      const ref = join(runDir, "repomap.json");
      writeFileSync(ref, JSON.stringify({ files, entries: [], truncated: false }));
      let called = 0, brief = "";
      const sessions: SessionRunner = { async run(o) { called++; if (!brief) brief = o.brief; for (const [n, c] of Object.entries(authored)) writeFileSync(join(o.cwd!, n), c); return { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0, killed: false }; } };
      const tm = { runners: [], tests: [] };
      const ctx = { ...ctxFor(repoDir, []), runId: "r1", runDir, sessions, tests: { async detect() { return tm; }, impacted: () => [] }, outputs: () => ({ intake: { task: "add a paginate helper that slices a list into pages with new behavior across modules", testmap: tm, repomap_ref: ref } }) } as unknown as RunContext;
      const r = await runWall(ctx, sig());
      return { r, brief, called };
    } finally { if (prev === undefined) delete process.env.LOKI_E10_WALL_FIRST; else process.env.LOKI_E10_WALL_FIRST = prev; rmSync(repoDir, { recursive: true, force: true }); }
  };
  test("Python unittest-only repo: the brief names python3 -m unittest and no Wall file is .ts or .js", async () => {
    const { r, brief, called } = await wallFor(["paginate.py", "README.md"], { "loki_wall_paginate.py": "import unittest\n\nclass T(unittest.TestCase):\n    def test_ok(self):\n        import paginate\n        self.assertEqual(paginate.paginate([1, 2, 3], 2), [[1, 2], [3]])\n" }, { "paginate.py": "def paginate(xs, n):\n    return [xs]\n" });
    expect(called).toBe(1);
    expect(brief).toContain("python3 -m unittest");
    expect(brief).not.toContain("bun:test");
    expect((r.data["base_run"] as { fail: number }).fail).toBe(1); // the stdlib runner's red is counted, not not_run
    expect((r.data["files"] as { runner?: string }[]).map((f) => f.runner)).toEqual(["unittest"]); // D122: the sealed entry records the runner verify will reuse
    const files = (r.data["files"] as { path: string }[]).map((f) => f.path);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((p) => p.endsWith(".py"))).toBe(true);
  });
  test("Go module with no _test.go, and a Rust crate: the brief names go test / cargo test, never bun", async () => {
    const go = await wallFor(["go.mod", "main.go"], { "loki_wall_x_test.go": "package main\n" });
    expect(go.brief).toContain("go test");
    expect(go.brief).not.toContain("bun:test");
    const rs = await wallFor(["src/lib.rs"], { "loki_wall_x.rs": "#[test] fn t() {}\n" });
    expect(rs.brief).toContain("cargo test");
    expect(rs.brief).not.toContain("bun:test");
  });
  test("source with no stdlib runner (Java): skipped in under 10s with NOT PROVEN, no session", async () => {
    const t0 = Date.now();
    const { r, called } = await wallFor(["src/Main.java"], {});
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r.status).toBe("skipped");
    expect(called).toBe(0);
    expect(r.data["not_proven"]).toEqual(["Wall skipped: no runnable test command for this stack"]);
  });
  test("docs-only repo: bun fallback kept", async () => {
    const { brief, called } = await wallFor(["README.md", "docs/a.md"], { "loki_wall_x.test.ts": "import { test, expect } from 'bun:test'; test('a', () => expect(1).toBe(1));\n" });
    expect(called).toBeGreaterThan(0);
    expect(brief).toContain("bun:test");
  });
});
