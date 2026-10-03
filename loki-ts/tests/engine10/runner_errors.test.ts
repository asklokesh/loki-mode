// FC-02 / Engine Law L5: a runner load or collection error is harness-owned (not_run, no fix rounds);
// a genuine assertion failure stays a code failure. FC-17: a Wall that cannot write a runnable check skips fast.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { classifyRunnerOutput } from "../../src/runner/runner_errors.ts";
import { runCheck, type VerifyCheck } from "../../src/engine10/stages/verify.ts";
import { runWall } from "../../src/engine10/stages/wall.ts";
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
});

describe("FC-17 Wall no-op precheck", () => {
  test("no runnable test command: skipped in under 10s with a reason, no model session", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "loki-fc17-"));
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
    } finally { rmSync(repoDir, { recursive: true, force: true }); }
  });
});
