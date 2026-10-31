// E-09 Wall check (docs/v10/ENGINE.md section 16).
//
// testmap.ts (E-05) and machine.ts (E-02) are not on main: RunContext.tests
// is always a fake TestMapProvider here, never a real import of testmap.ts.
import { ignoreSnapshot } from "../../src/util/check_result.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { EventType, RunContext, StageName, TestMap, TestRef } from "../../src/engine10/types.ts";
import { WALL_FAILURE_TAIL_CAP, WALL_FAILURE_TAIL_FILE, writeWallFailureTail, wallTailOf, changedFiles, runCheck, runLintChecks, runnerCmd, verifyStage, type VerifyCheck } from "../../src/engine10/stages/verify.ts";
import { classifyRisk, diffFiles, markExecuted, recordRisk, type DiffFile } from "../../src/util/check_result.ts";
import { readRiskSummary, withRiskLine } from "../../src/util/run_summary.ts";

const FIX = join(import.meta.dir, "fixtures", "verify");
const cleanupDirs: string[] = [];

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

/** A fresh git repo, optionally seeded from fixtures/verify/<seed>, with one
 *  committed base state (so baseSha() is meaningful). */
function mkRepo(seed?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "e10-verify-"));
  cleanupDirs.push(dir);
  if (seed) cpSync(join(FIX, seed), dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), "seed\n");
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t.test"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  return dir;
}

function baseSha(dir: string): string {
  return git(dir, ["rev-parse", "HEAD"]);
}

afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Emitted { type: EventType | string; stage: StageName | string | null; data: Record<string, unknown> }

function fakeCtx(opts: {
  repoDir: string;
  baseSha: string;
  outputs?: Partial<Record<StageName, Record<string, unknown>>>;
  detect?: (repoDir: string) => Promise<TestMap>;
  impacted?: (map: TestMap, changed: string[]) => TestRef[];
}): { ctx: RunContext; emitted: Emitted[] } {
  const emitted: Emitted[] = [];
  const outputs = { ...(opts.outputs ?? {}), intake: { ignore_snapshot: ignoreSnapshot(opts.repoDir), ...(opts.outputs?.intake ?? {}) } }; // intake records the ignore sources before the run; a missing record refuses VERIFIED
  const ctx: RunContext = {
    runId: "e10-test",
    repoDir: opts.repoDir,
    runDir: join(opts.repoDir, ".loki", "runs", "e10-test"),
    baseSha: opts.baseSha,
    branch: "loki/e10-test",
    provider: "claude",
    model: "test-model",
    deep: false,
    capS: 900,
    emit: (type, stage, data) => { emitted.push({ type, stage, data }); },
    sessions: { run: async () => ({ exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0, killed: false }) },
    tests: {
      detect: opts.detect ?? (async () => ({ runners: [], tests: [] })),
      impacted: opts.impacted ?? (() => []),
    },
    cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
    clock: { now: () => Date.now() },
    outputs: () => outputs,
  };
  return { ctx, emitted };
}

const sig = () => new AbortController().signal;

describe("engine10 verify: empty diff", () => {
  test("with the already_done marker seals ALREADY_SATISFIED, no checks run", async () => {
    const repoDir = mkRepo();
    const { ctx } = fakeCtx({ repoDir, baseSha: baseSha(repoDir), outputs: { implement: { exit: "already_done" } } });
    const result = await verifyStage.run(ctx, sig());
    expect(result.status).toBe("completed");
    expect(result.data.already_satisfied).toBe(true);
    expect(result.data.checks).toEqual([]);
  });

  test("without the marker is a failure", async () => {
    const repoDir = mkRepo();
    const { ctx } = fakeCtx({ repoDir, baseSha: baseSha(repoDir) });
    const result = await verifyStage.run(ctx, sig());
    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/already_done/);
  });

  test("a broken baseSha is a failure, never a false ALREADY_SATISFIED", async () => {
    const repoDir = mkRepo();
    const { ctx } = fakeCtx({ repoDir, baseSha: "0".repeat(40), outputs: { implement: { exit: "already_done" } } });
    const result = await verifyStage.run(ctx, sig());
    expect(result.status).toBe("failed");
    expect(result.data.already_satisfied).toBeUndefined();
  });
});

describe("engine10 verify: missing tool and flaky rerun", () => {
  test("a missing tool is NOT PROVEN (not_run), not a failure", async () => {
    const repoDir = mkRepo();
    const { ctx, emitted } = fakeCtx({ repoDir, baseSha: "HEAD" });
    const checks: VerifyCheck[] = [];
    const check = await runCheck(ctx, "lint:ruff", "ruff", ["check"], sig(), checks, { path: "/nonexistent-test-path" });
    expect(check.result).toBe("not_run");
    expect(checks).toHaveLength(1);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.type).toBe("test.result");
  });

  test("a fail-then-pass check is flaky, not a failure", async () => {
    const repoDir = mkRepo();
    const counter = join(repoDir, "counter");
    const script = join(repoDir, "flaky.sh");
    writeFileSync(counter, "0");
    writeFileSync(script, [
      "#!/usr/bin/env bash",
      `n=$(cat "${counter}")`,
      "n=$((n+1))",
      `echo "$n" > "${counter}"`,
      'echo "1 passed in 0.01s"',
      '[ "$n" -ge 2 ]',
    ].join("\n") + "\n");
    chmodSync(script, 0o755);
    const { ctx } = fakeCtx({ repoDir, baseSha: "HEAD" });
    const checks: VerifyCheck[] = [];
    const check = await runCheck(ctx, "flaky-test", "bash", [script], sig(), checks);
    expect(check.result).toBe("flaky");
    expect(readFileSync(counter, "utf8").trim()).toBe("2"); // ran exactly twice
  });

  test("a check that fails twice stays a failure", async () => {
    const repoDir = mkRepo();
    const { ctx } = fakeCtx({ repoDir, baseSha: "HEAD" });
    const checks: VerifyCheck[] = [];
    const check = await runCheck(ctx, "always-fails", "bash", ["-c", "exit 1"], sig(), checks);
    expect(check.result).toBe("fail");
  });

  test("an aborted check is NOT PROVEN, not read as a failure and never retried", async () => {
    const repoDir = mkRepo();
    const { ctx, emitted } = fakeCtx({ repoDir, baseSha: "HEAD" });
    const checks: VerifyCheck[] = [];
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const check = await runCheck(ctx, "slow", "bash", ["-c", "sleep 5"], controller.signal, checks);
    expect(check.result).toBe("not_run");
    expect(check.duration_s).toBeLessThan(2);
    expect(checks).toHaveLength(1); // exactly one attempt, no retry
    expect(emitted).toHaveLength(1);
  }, 10_000);

  test("a check whose per-attempt timeout is injected short times out and is never retried", async () => {
    const repoDir = mkRepo();
    const counter = join(repoDir, "counter");
    const script = join(repoDir, "slow.sh");
    writeFileSync(counter, "0");
    writeFileSync(script, [
      "#!/usr/bin/env bash",
      `n=$(cat "${counter}")`,
      "n=$((n+1))",
      `echo "$n" > "${counter}"`,
      "sleep 5",
    ].join("\n") + "\n");
    chmodSync(script, 0o755);
    const { ctx } = fakeCtx({ repoDir, baseSha: "HEAD" });
    const checks: VerifyCheck[] = [];
    // Real timeout path (AbortSignal.timeout), not the caller's own signal:
    // proves the timeout itself is injectable and still never retries.
    const check = await runCheck(ctx, "slow-timeout", "bash", [script], sig(), checks, { timeoutMs: 200 });
    expect(check.result).toBe("not_run");
    expect(check.reason).toMatch(/timed out after 0\.2s/);
    expect(readFileSync(counter, "utf8").trim()).toBe("1"); // ran exactly once, never retried
  }, 10_000);
});

describe("engine10 verify: test selection and select-tests.sh", () => {
  test("impacted + wall + changed test files are deduped before running", async () => {
    const repoDir = mkRepo("bun-target");
    const sha = baseSha(repoDir);
    writeFileSync(join(repoDir, "src.txt"), "changed\n"); // untracked -> non-empty diff
    // Also modify the test file itself, so all three sources genuinely
    // contribute: impacted (fake), wall (fake output), changed-test-file
    // (this stage's own diff-vs-map cross-check).
    execFileSync("bash", ["-c", `printf '\\n// touched\\n' >> "${join(repoDir, "sample.test.ts")}"`]);
    const map: TestMap = { runners: ["bun"], tests: [{ runner: "bun", path: "sample.test.ts" }] };
    const { ctx, emitted } = fakeCtx({
      repoDir, baseSha: sha,
      detect: async () => map,
      impacted: () => [{ runner: "bun", path: "sample.test.ts" }],
      outputs: { wall: { files: [{ path: "sample.test.ts" }] } },
    });
    const result = await verifyStage.run(ctx, sig());
    expect(result.status).toBe("completed");
    const checks = result.data.checks as VerifyCheck[];
    const testChecks = checks.filter((c) => c.name.startsWith("bun:"));
    expect(testChecks).toHaveLength(1); // 3 sources (impacted, wall, changed-test-file), 1 run
    expect(testChecks[0]?.result).toBe("pass");
    expect(emitted.filter((e) => e.type === "test.result" && String(e.data["name"]).startsWith("bun:"))).toHaveLength(1);
  }, 20_000);

  test("FC-WALL-FILE-WITHOUT-RUNNER-SILENTLY-DROPPED: a sealed Wall file no runner can run is named in not_proven and never lets wall_passed be true", async () => {
    const repoDir = mkRepo("bun-target"), sha = baseSha(repoDir); writeFileSync(join(repoDir, "src.txt"), "changed\n");
    const NAMED = (p: string) => `Wall test not executed: ${p}: no runner of this repo runs this file`;
    const mixed = fakeCtx({ repoDir, baseSha: sha, detect: async () => ({ runners: ["bun"], tests: [{ runner: "bun", path: "sample.test.ts" }] }), impacted: () => [], outputs: { wall: { files: [{ path: join(repoDir, "sample.test.ts") }, { path: join(repoDir, "loki_wall_B.java") }] } } });
    const m = await verifyStage.run(mixed.ctx, sig());
    expect((m.data.checks as VerifyCheck[]).find((c) => c.name === "bun:sample.test.ts")?.result).toBe("pass");
    expect(m.data.not_proven as string[]).toContain(NAMED("loki_wall_B.java")); expect(m.data.wall_passed).toBeUndefined(); // the runnable half passed; the dropped half stops a bare true
    const only = fakeCtx({ repoDir, baseSha: sha, detect: async () => ({ runners: [], tests: [] }), impacted: () => [], outputs: { wall: { files: [{ path: join(repoDir, "loki_wall_B.java") }, { path: join(repoDir, "loki_wall_c.rs") }] } } });
    const o = await verifyStage.run(only.ctx, sig());
    expect(o.data.not_proven as string[]).toEqual(expect.arrayContaining([NAMED("loki_wall_B.java"), NAMED("loki_wall_c.rs")])); expect(o.data.wall_passed).toBeUndefined(); // every Wall file dropped: unset, never true
    const ctl = fakeCtx({ repoDir, baseSha: sha, detect: async () => ({ runners: ["bun"], tests: [{ runner: "bun", path: "sample.test.ts" }] }), impacted: () => [], outputs: { wall: { files: [{ path: join(repoDir, "sample.test.ts") }] } } });
    const c = await verifyStage.run(ctl.ctx, sig()); expect(c.data.wall_passed).toBe(true); expect((c.data.not_proven as string[]).some((n) => n.startsWith("Wall test not executed"))).toBe(false); // positive control: nothing dropped
  }, 40_000);

  test("an absolute Wall path is normalized to repo-relative and still selected", async () => {
    const repoDir = mkRepo("bun-target");
    const sha = baseSha(repoDir);
    writeFileSync(join(repoDir, "src.txt"), "changed\n"); // untracked -> non-empty diff
    const map: TestMap = { runners: ["bun"], tests: [{ runner: "bun", path: "sample.test.ts" }] };
    const { ctx } = fakeCtx({
      repoDir, baseSha: sha,
      detect: async () => map,
      impacted: () => [],
      outputs: { wall: { files: [{ path: join(repoDir, "sample.test.ts") }] } }, // absolute, as wall.ts (E-15) emits
    });
    const result = await verifyStage.run(ctx, sig());
    const checks = result.data.checks as VerifyCheck[];
    const testChecks = checks.filter((c) => c.name.startsWith("bun:"));
    expect(testChecks).toHaveLength(1);
    expect(testChecks[0]?.result).toBe("pass");
  }, 20_000);

  test("no project runner: the Wall file runs with Loki's bun, so the receipt gets a real Wall result (not 'no tests to run')", async () => {
    const repoDir = mkRepo("bun-target");
    const sha = baseSha(repoDir);
    writeFileSync(join(repoDir, "src.txt"), "changed\n");
    const { ctx } = fakeCtx({ repoDir, baseSha: sha, detect: async () => ({ runners: [], tests: [] }), impacted: () => [], outputs: { wall: { files: [{ path: join(repoDir, "sample.test.ts"), runner: "bun" as const }] } } });
    const res = await verifyStage.run(ctx, sig()), testChecks = (res.data.checks as VerifyCheck[]).filter((c) => c.name.startsWith("bun:"));
    expect(testChecks).toHaveLength(1);
    expect(testChecks[0]?.result).toBe("pass");
    expect(res.data.wall_passed).toBe(true); // seal reads this into receipt.wall.passed; it was never written before
    const part = fakeCtx({ repoDir, baseSha: sha, detect: async () => ({ runners: [], tests: [] }), impacted: () => [], outputs: { wall: { files: [{ path: join(repoDir, "sample.test.ts"), runner: "bun" as const }, { path: join(repoDir, "gone.test.ts"), runner: "bun" as const }] } } });
    const pr = await verifyStage.run(part.ctx, sig()), gone = (pr.data.checks as VerifyCheck[]).find((c) => c.name === "bun:gone.test.ts");
    expect(gone?.result).not.toBe("pass");
    expect(pr.data.wall_passed).not.toBe(true); // a Wall check that did not pass never yields wall.passed true
    writeFileSync(join(repoDir, "loki_wall_feature_test.ts"), 'import { test, expect } from "bun:test";\ntest("w", () => expect(1).toBe(1));\n');
    const us = fakeCtx({ repoDir, baseSha: sha, detect: async () => ({ runners: [], tests: [] }), impacted: () => [], outputs: { wall: { files: [{ path: join(repoDir, "loki_wall_feature_test.ts"), runner: "bun" as const }] } } });
    const ur = await verifyStage.run(us.ctx, sig());
    expect((ur.data.checks as VerifyCheck[]).find((c) => c.name === "bun:loki_wall_feature_test.ts")?.result).toBe("pass"); // bun accepts _test names; a Wall file is a test whatever its suffix
    const rm = join(repoDir, "repomap-py.json"); writeFileSync(rm, JSON.stringify({ files: ["app.py", "tests/test_app.py"], entries: [], truncated: false }));
    const py = fakeCtx({ repoDir, baseSha: sha, detect: async () => ({ runners: [], tests: [] }), impacted: () => [], outputs: { intake: { repomap_ref: rm }, wall: { files: [{ path: join(repoDir, "sample.test.ts") }] } } });
    expect(((await verifyStage.run(py.ctx, sig())).data.checks as VerifyCheck[]).filter((c) => c.name.startsWith("bun:"))).toHaveLength(0); // a Python test suite keeps its own rules, in verify as in the Wall
    const prev = process.env.LOKI_WALL_HARNESS_RUNNER; process.env.LOKI_WALL_HARNESS_RUNNER = "0";
    try { const off = await verifyStage.run(py.ctx, sig()); expect((off.data.checks as VerifyCheck[]).filter((c) => c.name.startsWith("bun:"))).toHaveLength(0); expect(off.data.wall_passed).toBeUndefined(); }
    finally { if (prev === undefined) delete process.env.LOKI_WALL_HARNESS_RUNNER; else process.env.LOKI_WALL_HARNESS_RUNNER = prev; }
  }, 20_000);

  test("select-tests.sh runs when the target carries it (self-hosting)", async () => {
    const repoDir = mkRepo("loki-mode-repo");
    const sha = baseSha(repoDir);
    writeFileSync(join(repoDir, "changed.py"), "x = 1\n");
    const { ctx } = fakeCtx({ repoDir, baseSha: sha });
    const result = await verifyStage.run(ctx, sig());
    const checks = result.data.checks as VerifyCheck[];
    expect(checks.some((c) => c.name === "select-tests")).toBe(true);
    const log = readFileSync(join(repoDir, "called.log"), "utf8");
    expect(log).toContain("changed.py");
    expect(log).toContain("argv:--files - --run");
  });

  test("select-tests.sh is never invoked for a non-loki-mode target", async () => {
    const repoDir = mkRepo();
    const sha = baseSha(repoDir);
    writeFileSync(join(repoDir, "changed.txt"), "x\n");
    const { ctx } = fakeCtx({ repoDir, baseSha: sha });
    const result = await verifyStage.run(ctx, sig());
    const checks = result.data.checks as VerifyCheck[];
    expect(checks.some((c) => c.name === "select-tests")).toBe(false);
  });
});

describe("engine10 verify: lint/typecheck matrix (ENGINE.md section 4)", () => {
  test("a malformed .sh as the only changed file fails bash -n, never an empty check list", async () => {
    const repoDir = mkRepo();
    writeFileSync(join(repoDir, "broken.sh"), "if [ -z \"$x\" ]\n  echo unterminated\n");
    const { ctx } = fakeCtx({ repoDir, baseSha: baseSha(repoDir) });
    const result = await verifyStage.run(ctx, sig());
    expect(result.status).toBe("completed");
    const checks = result.data.checks as VerifyCheck[];
    expect(checks.length).toBeGreaterThan(0); // never checks: [] for a changed shell file
    const bashCheck = checks.find((c) => c.name === "lint:bash-n");
    expect(bashCheck?.result).toBe("fail");
  });

  test("shellcheck missing from PATH is not_run, never a silently absent entry", async () => {
    const repoDir = mkRepo();
    writeFileSync(join(repoDir, "ok.sh"), "#!/usr/bin/env bash\necho ok\n");
    const pathDir = mkdtempSync(join(tmpdir(), "e10-verify-path-"));
    cleanupDirs.push(pathDir);
    const bashReal = execFileSync("which", ["bash"], { encoding: "utf8" }).trim();
    execFileSync("ln", ["-s", bashReal, join(pathDir, "bash")]);
    const { ctx } = fakeCtx({ repoDir, baseSha: baseSha(repoDir) });
    const checks: VerifyCheck[] = [];
    await runLintChecks(ctx, ["ok.sh"], sig(), checks, { path: pathDir });
    const shellcheckCheck = checks.find((c) => c.name === "lint:shellcheck");
    expect(shellcheckCheck?.result).toBe("not_run");
    expect(shellcheckCheck?.reason).toMatch(/not found on PATH/);
    const bashCheck = checks.find((c) => c.name === "lint:bash-n");
    expect(bashCheck?.result).toBe("pass");
  });
});

describe("engine10 verify: pytest interpreter resolution (E-98a)", () => {
  test("a .venv/bin/python shim resolves and runs, even with no python on PATH", async () => {
    const repoDir = mkRepo();
    const venvBin = join(repoDir, ".venv", "bin");
    mkdirSync(venvBin, { recursive: true });
    const shim = join(venvBin, "python");
    writeFileSync(shim, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(shim, 0o755);
    const [cmd, , interpreter] = runnerCmd({ runner: "pytest", path: "tests/test_x.py" }, repoDir);
    expect(cmd).toBe(shim); // resolved to the venv interpreter, not bare "python"
    expect(interpreter).toBe("project");

    // Before E-98a, runnerCmd always returned bare "python": on a PATH with no python at
    // all (only the venv shim, which a bare lookup never finds), that check was not_run.
    // With the resolved absolute path, the same PATH still runs it and it passes.
    const { ctx } = fakeCtx({ repoDir, baseSha: "HEAD" });
    const checks: VerifyCheck[] = [];
    const emptyPath = mkdtempSync(join(tmpdir(), "e10-verify-emptypath-"));
    cleanupDirs.push(emptyPath);
    const [rcmd, rargs] = runnerCmd({ runner: "pytest", path: "tests/test_x.py" }, repoDir);
    const check = await runCheck(ctx, "pytest:tests/test_x.py", rcmd, rargs, sig(), checks, { path: emptyPath });
    expect(["pass", "fail"]).toContain(check.result); // never not_run: "python not found on PATH"
  });

  test("no venv: falls back to a system interpreter, flagged in cmd and in not_proven", async () => {
    const repoDir = mkRepo();
    writeFileSync(join(repoDir, "changed.txt"), "x\n");
    const shimDir = mkdtempSync(join(tmpdir(), "e10-verify-shim-"));
    cleanupDirs.push(shimDir);
    writeFileSync(join(shimDir, "python3"), "#!/usr/bin/env bash\necho '1 passed in 0.01s'\n");
    chmodSync(join(shimDir, "python3"), 0o755);
    const map: TestMap = { runners: ["pytest"], tests: [{ runner: "pytest", path: "tests/test_x.py" }] };
    const { ctx } = fakeCtx({
      repoDir, baseSha: baseSha(repoDir),
      detect: async () => map,
      impacted: () => [{ runner: "pytest", path: "tests/test_x.py" }],
    });
    const savedPath = process.env["PATH"];
    process.env["PATH"] = `${shimDir}:${savedPath ?? ""}`; // shim first: resolves before any real python3
    try {
      const result = await verifyStage.run(ctx, sig());
      const checks = result.data.checks as VerifyCheck[];
      const pyCheck = checks.find((c) => c.name === "pytest:tests/test_x.py");
      expect(pyCheck?.result).toBe("pass");
      expect(pyCheck?.cmd.startsWith("python3 ")).toBe(true); // records which interpreter it used
      expect(pyCheck?.interpreter).toBe("system");
      expect(result.data.not_proven).toEqual(["tests ran on the system interpreter"]);
    } finally {
      if (savedPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = savedPath;
    }
  });

  // E-98a B2: $VIRTUAL_ENV is not trusted just because it's set -- only when it actually lives
  // inside the repo. A venv anywhere else on disk (a common host setup: one shared venv for many
  // checkouts) must still count as "system" and carry the not_proven line.
  test("VIRTUAL_ENV outside the repo is never trusted as project: system=true, not_proven set", async () => {
    const repoDir = mkRepo();
    writeFileSync(join(repoDir, "changed.txt"), "x\n");
    // A real, existing venv -- just not inside repoDir. resolveTool's candidate path is
    // literally $VIRTUAL_ENV/bin/python, and this file genuinely exists there, so only the
    // realpath-under-repoDir check (B2), not existsSync, is what must reject it.
    const outsideVenv = mkdtempSync(join(tmpdir(), "e10-verify-outside-venv-"));
    cleanupDirs.push(outsideVenv);
    const outsideVenvBin = join(outsideVenv, "bin");
    mkdirSync(outsideVenvBin, { recursive: true });
    const outsideVenvPython = join(outsideVenvBin, "python");
    writeFileSync(outsideVenvPython, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(outsideVenvPython, 0o755);
    const shimDir = mkdtempSync(join(tmpdir(), "e10-verify-shim-"));
    cleanupDirs.push(shimDir);
    writeFileSync(join(shimDir, "python3"), "#!/usr/bin/env bash\necho '1 passed in 0.01s'\n"); // the correct PATH fallback
    chmodSync(join(shimDir, "python3"), 0o755);
    const savedVenv = process.env["VIRTUAL_ENV"];
    const savedPath = process.env["PATH"];
    process.env["VIRTUAL_ENV"] = outsideVenv;
    process.env["PATH"] = `${shimDir}:${savedPath ?? ""}`;
    try {
      const [cmd, , interpreter] = runnerCmd({ runner: "pytest", path: "tests/test_x.py" }, repoDir);
      expect(cmd).not.toBe(outsideVenvPython); // never the out-of-repo venv, even though it exists
      expect(cmd).toBe("python3"); // fell through to PATH instead
      expect(interpreter).toBe("system");

      const map: TestMap = { runners: ["pytest"], tests: [{ runner: "pytest", path: "tests/test_x.py" }] };
      const { ctx } = fakeCtx({
        repoDir, baseSha: baseSha(repoDir),
        detect: async () => map,
        impacted: () => [{ runner: "pytest", path: "tests/test_x.py" }],
      });
      const result = await verifyStage.run(ctx, sig());
      expect(result.data.not_proven).toEqual(["tests ran on the system interpreter"]);
    } finally {
      if (savedVenv === undefined) delete process.env["VIRTUAL_ENV"]; else process.env["VIRTUAL_ENV"] = savedVenv;
      if (savedPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = savedPath;
    }
  });

  test("an in-repo VIRTUAL_ENV IS trusted as project", () => {
    const repoDir = mkRepo();
    const insideVenv = join(repoDir, ".custom-venv");
    mkdirSync(join(insideVenv, "bin"), { recursive: true });
    const shim = join(insideVenv, "bin", "python");
    writeFileSync(shim, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(shim, 0o755);
    const savedVenv = process.env["VIRTUAL_ENV"];
    process.env["VIRTUAL_ENV"] = insideVenv;
    try {
      const [cmd, , interpreter] = runnerCmd({ runner: "pytest", path: "tests/test_x.py" }, repoDir);
      expect(cmd).toBe(shim);
      expect(interpreter).toBe("project");
    } finally {
      if (savedVenv === undefined) delete process.env["VIRTUAL_ENV"]; else process.env["VIRTUAL_ENV"] = savedVenv;
    }
  });

  test("TEN-QUALITY-11: uv.lock and no .venv resolves through uv run as the project interpreter", () => {
    const repoDir = mkRepo();
    const uvDir = mkdtempSync(join(tmpdir(), "e10-verify-uv-"));
    cleanupDirs.push(uvDir);
    writeFileSync(join(uvDir, "uv"), "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(join(uvDir, "uv"), 0o755);
    const savedPath = process.env["PATH"];
    process.env["PATH"] = `${uvDir}:${savedPath ?? ""}`;
    try {
      // no uv.lock: today's system result
      expect(runnerCmd({ runner: "pytest", path: "tests/test_x.py" }, repoDir)[2]).toBe("system");
      writeFileSync(join(repoDir, "uv.lock"), "version = 1\n");
      const [cmd, args, interpreter] = runnerCmd({ runner: "pytest", path: "tests/test_x.py" }, repoDir);
      expect([cmd, args, interpreter]).toEqual(["uv", ["run", "--", "python", "-m", "pytest", "-q", "tests/test_x.py"], "project"]);
      // a real .venv still wins over uv
      const venvBin = join(repoDir, ".venv", "bin");
      mkdirSync(venvBin, { recursive: true });
      writeFileSync(join(venvBin, "python"), "#!/usr/bin/env bash\nexit 0\n");
      chmodSync(join(venvBin, "python"), 0o755);
      expect(runnerCmd({ runner: "pytest", path: "tests/test_x.py" }, repoDir)[0]).toBe(join(venvBin, "python"));
    } finally {
      if (savedPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = savedPath;
    }
  });

  test("TEN-QUALITY-11: uv.lock but no uv on PATH keeps the system result; ruff goes through uv run when uv exists", async () => {
    const repoDir = mkRepo();
    writeFileSync(join(repoDir, "uv.lock"), "version = 1\n");
    const savedPath = process.env["PATH"];
    const emptyDir = mkdtempSync(join(tmpdir(), "e10-verify-nouv-"));
    cleanupDirs.push(emptyDir);
    process.env["PATH"] = `${emptyDir}:/usr/bin:/bin`;
    try {
      if (!Bun.which("uv")) expect(runnerCmd({ runner: "pytest", path: "tests/test_x.py" }, repoDir)[2]).toBe("system");
    } finally {
      if (savedPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = savedPath;
    }
    const uvDir = mkdtempSync(join(tmpdir(), "e10-verify-uv-"));
    cleanupDirs.push(uvDir);
    writeFileSync(join(uvDir, "uv"), "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(join(uvDir, "uv"), 0o755);
    process.env["PATH"] = `${uvDir}:${savedPath ?? ""}`;
    try {
      const { ctx } = fakeCtx({ repoDir, baseSha: "HEAD" });
      const checks: VerifyCheck[] = [];
      await runLintChecks(ctx, ["changed.py"], sig(), checks);
      const ruffCheck = checks.find((c) => c.name === "lint:ruff");
      expect(ruffCheck?.cmd.startsWith("uv run -- ruff check")).toBe(true);
      expect(ruffCheck?.interpreter).toBe("project");
    } finally {
      if (savedPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = savedPath;
    }
  });

  test("ruff resolves the same way: project .venv/bin/ruff over a bare PATH ruff", async () => {
    const repoDir = mkRepo();
    const venvBin = join(repoDir, ".venv", "bin");
    mkdirSync(venvBin, { recursive: true });
    const shim = join(venvBin, "ruff");
    writeFileSync(shim, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(shim, 0o755);
    const { ctx } = fakeCtx({ repoDir, baseSha: "HEAD" });
    const checks: VerifyCheck[] = [];
    await runLintChecks(ctx, ["changed.py"], sig(), checks);
    const ruffCheck = checks.find((c) => c.name === "lint:ruff");
    expect(ruffCheck?.cmd.startsWith(shim)).toBe(true);
    expect(ruffCheck?.interpreter).toBe("project");
    expect(ruffCheck?.result).toBe("pass");
  });

  test("E-115: a passing system ruff adds the lint line, not the tests line", async () => {
    const repoDir = mkRepo();
    writeFileSync(join(repoDir, "changed.py"), "x = 1\n");
    const shimDir = mkdtempSync(join(tmpdir(), "e10-verify-ruff-"));
    cleanupDirs.push(shimDir);
    writeFileSync(join(shimDir, "ruff"), "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(join(shimDir, "ruff"), 0o755);
    const { ctx } = fakeCtx({ repoDir, baseSha: baseSha(repoDir) });
    const savedPath = process.env["PATH"];
    process.env["PATH"] = `${shimDir}:${savedPath ?? ""}`;
    try {
      const result = await verifyStage.run(ctx, sig());
      expect((result.data.checks as VerifyCheck[]).find((c) => c.name === "lint:ruff")?.interpreter).toBe("system");
      expect(result.data.not_proven).toEqual(["lint ran on the system ruff"]);
    } finally {
      if (savedPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = savedPath;
    }
  });
});

describe("engine10 verify: changedFiles", () => {
  test("sees an untracked file and excludes .loki/", async () => {
    const repoDir = mkRepo();
    writeFileSync(join(repoDir, "new.txt"), "x\n");
    mkdirSync(join(repoDir, ".loki", "runs", "r1"), { recursive: true });
    writeFileSync(join(repoDir, ".loki", "runs", "r1", "events.jsonl"), "{}\n");
    const files = changedFiles(repoDir, baseSha(repoDir));
    expect(files).toEqual(["new.txt"]);
  });
});

// RISKTIER: artifact-based risk tier (moved from risk_tier.test.ts, assertions unchanged)
const rf = (path: string, added = 5, deleted = 1, status: DiffFile["status"] = "modified"): DiffFile => ({ path, added, deleted, status });
describe("classifyRisk tiers", () => {
  test("small source change is low, council and reviewer deferred", () => {
    const r = classifyRisk([rf("src/util.ts"), rf("src/util_helper.ts", 3, 0, "added")], {});
    expect(r.tier).toBe("low");
    expect(r.checks_deferred).toContain("council");
    expect(r.checks_selected).not.toContain("council");
    expect(r.summary).toContain("risk: low (2 files, no sensitive paths)");
    expect(r.summary).toBe("risk: low (2 files, no sensitive paths), full test command, reviewer, council, security scan not run");
  });
  test("many files or lines is medium: full test command plus one reviewer", () => {
    const r = classifyRisk(["a", "b", "c", "d"].map((n) => rf(`src/${n}.ts`)), {});
    expect(r.tier).toBe("medium");
    expect(r.checks_selected).toContain("one reviewer");
    expect(r.checks_deferred).toEqual(["full test command", "one reviewer"]);
    expect(r.summary).toMatch(/full test command, one reviewer not run$/);
    expect(classifyRisk([rf("src/big.ts", 120, 0)], {}).tier).toBe("medium");
  });
  test("modifying an existing test is medium, adding a new test is not", () => {
    expect(classifyRisk([rf("src/a.ts"), rf("tests/a.test.ts", 3, 3)], {}).tier).toBe("medium");
    expect(classifyRisk([rf("src/a.ts"), rf("tests/a.test.ts", 9, 0, "added")], {}).tier).toBe("low");
  });
  test("large diff is high with full suite, council and security scan", () => {
    const r = classifyRisk([rf("src/big.ts", 600, 0)], {});
    expect(r.tier).toBe("high");
    expect(r.checks_selected).toEqual(expect.arrayContaining(["full suite", "council", "security scan"]));
    expect(r.checks_deferred).toEqual(["full test command", "full suite", "council", "security scan"]);
    expect(r.summary).toMatch(/full test command, full suite, council, security scan not run$/);
  });
  test("markExecuted removes only what really ran and keeps the rest not run", () => {
    const r = markExecuted(classifyRisk([rf("src/big.ts", 600, 0)], {}), ["full test command", "full suite"]);
    expect(r.checks_deferred).toEqual(["council", "security scan"]);
    expect(r.summary).toMatch(/council, security scan not run$/);
    expect(markExecuted(classifyRisk(["a", "b", "c", "d"].map((n) => rf(`src/${n}.ts`)), {}), ["full test command"]).checks_deferred).toEqual(["one reviewer"]);
  });
  test("readRiskSummary returns the recorded line, null when absent or stale; withRiskLine honors the line cap", () => {
    const d = mkdtempSync(join(tmpdir(), "risk-sum-")); cleanupDirs.push(d);
    expect(readRiskSummary(d)).toBeNull();
    const r = classifyRisk([rf("src/a.ts")], {});
    recordRisk(d, r);
    expect(readRiskSummary(d)).toBe(r.summary);
    expect(readRiskSummary(d, Date.now() + 60_000)).toBeNull();
    expect(withRiskLine("a\nb\n", r.summary)).toBe(`a\nb\n${r.summary}\n`);
    expect(withRiskLine("1\n2\n3\n4\n5\n6\n7\n", r.summary)).toBe("1\n2\n3\n4\n5\n6\n7\n");
    expect(withRiskLine("a\n", null)).toBe("a\n");
    expect(withRiskLine("1\n2\n3\n4\n5\n6\n", r.summary, 7, 1)).toBe("1\n2\n3\n4\n5\n6\n"); // F3: a provider disclosure line counts against the 8-line cap
    expect(withRiskLine("1\n2\n3\n4\n5\n", r.summary, 7, 1)).toBe(`1\n2\n3\n4\n5\n${r.summary}\n`);
  });
  test("deleted test file and public API are high", () => {
    expect(classifyRisk([rf("tests/old.test.ts", 0, 40, "deleted")], {}).tier).toBe("high");
    expect(classifyRisk([rf("openapi.yaml")], {}).tier).toBe("high");
  });
});

describe("sensitive-path escalation", () => {
  for (const [p, kind] of [
    ["src/auth/login.ts", "auth"], ["lib/crypto/sign.py", "crypto"], ["src/payments/charge.ts", "payments"],
    ["db/migrations/001_init.sql", "migration"], [".github/workflows/ci.yml", "ci"], ["package-lock.json", "lockfile"],
    ["Dockerfile", "infra"], ["infra/main.tf", "infra"], [".env.production", "env"],
  ] as const) {
    test(`${p} escalates a one-line change to high (${kind})`, () => {
      const r = classifyRisk([rf(p, 1, 0)], {});
      expect(r.tier).toBe("high");
      expect(r.stats.sensitive[0]).toContain(kind);
      expect(r.reasons[0]).toContain("sensitive paths");
    });
  }
  test("a test named after a sensitive area is not sensitive", () => {
    expect(classifyRisk([rf("tests/auth.test.ts", 4, 0, "added")], {}).tier).toBe("low");
  });
});

describe("override rules", () => {
  test("prompt or flag can raise", () => {
    const r = classifyRisk([rf("src/a.ts")], { LOKI_RISK_TIER: "high" });
    expect(r.tier).toBe("high");
    expect(r.override?.from).toBe("low");
  });
  test("high is not downgraded without a recorded reason", () => {
    const r = classifyRisk([rf("src/auth/x.ts")], { LOKI_RISK_TIER: "low" });
    expect(r.tier).toBe("high");
    expect(r.override).toBeUndefined();
    expect(r.override_ignored).toContain("LOKI_RISK_OVERRIDE_REASON");
  });
  test("downgrade with explicit reason is honored and recorded", () => {
    const r = classifyRisk([rf("src/auth/x.ts")], { LOKI_RISK_TIER: "low", LOKI_RISK_OVERRIDE_REASON: "comment-only change, reviewed by owner" });
    expect(r.tier).toBe("low");
    expect(r.computed).toBe("high");
    expect(r.override).toEqual({ from: "high", to: "low", reason: "comment-only change, reviewed by owner" });
    expect(r.summary).toContain("override high to low");
  });
});

describe("diffFiles and recordRisk against a real repo", () => {
  test("derives the tier from the artifact and records it", () => {
    const d = mkdtempSync(join(tmpdir(), "risk-tier-")); cleanupDirs.push(d);
    const git = (...a: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: d, encoding: "utf8" }).trim();
    git("init", "-q"); writeFileSync(join(d, "a.ts"), "x\n"); git("add", "a.ts"); git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(d, "a.ts"), "x\ny\n");
    mkdirSync(join(d, "auth")); writeFileSync(join(d, "auth", "token.ts"), "z\n");
    const files = diffFiles(d, base);
    expect(files.map((x) => x.path).sort()).toEqual(["a.ts", "auth/token.ts"]);
    const r = classifyRisk(files, {});
    expect(r.tier).toBe("high");
    const p = recordRisk(d, r);
    expect(p && existsSync(p)).toBe(true);
    expect(JSON.parse(readFileSync(p!, "utf8")).tier).toBe("high");
  });
});

describe("engine10 verify: npx no install (TEN-SPEED-16)", () => {
  test("npx no install: vitest and jest runnerCmd pass --no-install so a missing tool fails fast", () => {
    expect(runnerCmd({ runner: "vitest", path: "a.test.ts" }, "/nonexistent")).toEqual(["npx", ["--no-install", "vitest", "run", "a.test.ts"]]);
    expect(runnerCmd({ runner: "jest", path: "a.test.ts" }, "/nonexistent")).toEqual(["npx", ["--no-install", "jest", "a.test.ts"]]);
  });
  test("npx no install: the tsc and eslint lint checks never use bare npx", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/engine10/stages/verify.ts"), "utf8");
    expect(src).not.toMatch(/"npx", \["(tsc|eslint|vitest|jest)"/);
    expect(src).toContain('"npx", ["--no-install", "tsc"');
    expect(src).toContain('"npx", ["--no-install", "eslint"');
  });
});

describe("engine10 verify: full-suite evidence (P12-01)", () => {
  test("a medium-risk run emits a verify-stage test.result for each full-suite check it records", async () => {
    const repoDir = mkRepo();
    writeFileSync(join(repoDir, "big.ts"), Array.from({ length: 150 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n");
    const { ctx, emitted } = fakeCtx({ repoDir, baseSha: baseSha(repoDir), detect: async () => ({ runners: ["node"], tests: [] }) });
    const result = await verifyStage.run(ctx, sig());
    const full = (result.data.checks as VerifyCheck[]).filter((c) => c.name.startsWith("full suite"));
    expect(full.length).toBeGreaterThan(0);
    for (const c of full) expect(emitted.some((e) => e.type === "test.result" && e.stage === "verify" && e.data["name"] === c.name && e.data["result"] === c.result)).toBe(true);
  });
});

describe("engine10 verify: verify jobs (TEN-SPEED-18)", () => {
  const slow = 'import { expect, test } from "bun:test";\ntest("slow", async () => { await Bun.sleep(1500); expect(1).toBe(1); });\n';
  const fast = 'import { expect, test } from "bun:test";\ntest("fast", () => { expect(1).toBe(1); });\n';
  async function runJobs(jobs: string | undefined): Promise<{ names: string[]; emitted: string[]; ms: number; results: string[] }> {
    const repoDir = mkRepo();
    const sha = baseSha(repoDir);
    writeFileSync(join(repoDir, "a_slow.test.ts"), slow);
    writeFileSync(join(repoDir, "b_slow.test.ts"), slow.replace('"slow"', '"slow2"'));
    writeFileSync(join(repoDir, "c_fast.test.ts"), fast);
    const tests: TestRef[] = ["a_slow.test.ts", "b_slow.test.ts", "c_fast.test.ts"].map((path) => ({ runner: "bun", path }));
    const { ctx, emitted } = fakeCtx({ repoDir, baseSha: sha, detect: async () => ({ runners: ["bun"], tests }), impacted: () => tests });
    const prev = process.env["LOKI_E10_VERIFY_JOBS"];
    if (jobs === undefined) delete process.env["LOKI_E10_VERIFY_JOBS"]; else process.env["LOKI_E10_VERIFY_JOBS"] = jobs;
    try {
      const t0 = Date.now();
      const r = await verifyStage.run(ctx, sig());
      const ms = Date.now() - t0;
      const checks = (r.data.checks as VerifyCheck[]).filter((c) => c.name.startsWith("bun:"));
      return { names: checks.map((c) => c.name), results: checks.map((c) => c.result), emitted: emitted.filter((e) => e.type === "test.result" && String(e.data["name"]).startsWith("bun:")).map((e) => String(e.data["name"])), ms };
    } finally {
      if (prev === undefined) delete process.env["LOKI_E10_VERIFY_JOBS"]; else process.env["LOKI_E10_VERIFY_JOBS"] = prev;
    }
  }
  test("verify jobs: default runs sequentially in selected order", async () => {
    const r = await runJobs(undefined);
    expect(r.names).toEqual(["bun:a_slow.test.ts", "bun:b_slow.test.ts", "bun:c_fast.test.ts"]);
    expect(r.emitted).toEqual(r.names);
    expect(r.results).toEqual(["pass", "pass", "pass"]);
  }, 60_000);
  test("verify jobs: LOKI_E10_VERIFY_JOBS=3 overlaps processes yet records checks in selected order", async () => {
    const seq = await runJobs("1");
    const par = await runJobs("3");
    expect(par.names).toEqual(["bun:a_slow.test.ts", "bun:b_slow.test.ts", "bun:c_fast.test.ts"]);
    expect(par.results).toEqual(["pass", "pass", "pass"]);
    expect(par.emitted[0]).toBe("bun:c_fast.test.ts"); // the fast one finishes first: real overlap
    expect(par.ms).toBeLessThan(seq.ms - 1000);
  }, 90_000);
  test("verify jobs: an invalid value falls back to 1", async () => {
    for (const v of ["0", "abc", "-2", ""]) expect((await runJobs(v)).emitted[0]).toBe("bun:a_slow.test.ts");
  }, 120_000);
});

describe("FC-LINT-TOOL-NEVER-USED-BY-PROJECT", () => {
  const noRuffPath = (): string => { const d = mkdtempSync(join(tmpdir(), "e10-noruff-")); cleanupDirs.push(d); return d; };
  test("a Python repo that neither declares ruff nor has one installed records no lint:ruff check", async () => {
    const repoDir = mkRepo();
    const saved = process.env["PATH"]; process.env["PATH"] = noRuffPath();
    try {
      const { ctx } = fakeCtx({ repoDir, baseSha: "HEAD" });
      const checks: VerifyCheck[] = [];
      await runLintChecks(ctx, ["changed.py"], sig(), checks);
      expect(checks.find((c) => c.name === "lint:ruff")).toBeUndefined();
    } finally { if (saved === undefined) delete process.env["PATH"]; else process.env["PATH"] = saved; }
  });
  test("a repo that declares ruff but has none installed still records lint:ruff as not_run", async () => {
    const repoDir = mkRepo();
    writeFileSync(join(repoDir, "pyproject.toml"), "[tool.ruff]\nline-length = 100\n");
    const saved = process.env["PATH"]; process.env["PATH"] = noRuffPath();
    try {
      const { ctx } = fakeCtx({ repoDir, baseSha: "HEAD" });
      const checks: VerifyCheck[] = [];
      await runLintChecks(ctx, ["changed.py"], sig(), checks);
      expect(checks.find((c) => c.name === "lint:ruff")?.result).toBe("not_run");
    } finally { if (saved === undefined) delete process.env["PATH"]; else process.env["PATH"] = saved; }
  });
});

describe("FC-WALL-FILE-NOT-DISCOVERED-BY-RUNNER: verify runs every sealed Wall path", () => {
  // The runner's discovery lists only test_x.py; the Wall file loki_wall_x.py is not a pytest-discovered name.
  function wallRepo(files: Record<string, string>): { repoDir: string; sha: string } {
    const repoDir = mkRepo();
    for (const [n, c] of Object.entries(files)) { mkdirSync(dirname(join(repoDir, n)), { recursive: true }); writeFileSync(join(repoDir, n), c); }
    const sha = baseSha(repoDir);
    writeFileSync(join(repoDir, "src.txt"), "changed\n"); // untracked -> non-empty diff
    return { repoDir, sha };
  }
  test("a pytest repo runs loki_wall_x.py although detect() lists only test_x.py", async () => {
    const { repoDir, sha } = wallRepo({ "test_x.py": "def test_x():\n    assert True\n", "loki_wall_x.py": "def test_wall():\n    assert True\n" });
    const { ctx } = fakeCtx({ repoDir, baseSha: sha, detect: async () => ({ runners: ["pytest"], tests: [{ runner: "pytest", path: "test_x.py" }] }), impacted: () => [], outputs: { wall: { files: [{ path: join(repoDir, "loki_wall_x.py") }] } } });
    const names = ((await verifyStage.run(ctx, sig())).data.checks as VerifyCheck[]).map((c) => c.name);
    expect(names).toContain("pytest:loki_wall_x.py");
  }, 60_000);
  test("a Go loki_wall_x_test.go still runs (discovery already lists it)", async () => {
    const { repoDir, sha } = wallRepo({ "go.mod": "module x\n\ngo 1.20\n", "loki_wall_x_test.go": 'package x\n\nimport "testing"\n\nfunc TestWall(t *testing.T) {}\n' });
    const { ctx } = fakeCtx({ repoDir, baseSha: sha, detect: async () => ({ runners: ["go"], tests: [{ runner: "go", path: "loki_wall_x_test.go" }] }), impacted: () => [], outputs: { wall: { files: [{ path: join(repoDir, "loki_wall_x_test.go") }] } } });
    const names = ((await verifyStage.run(ctx, sig())).data.checks as VerifyCheck[]).map((c) => c.name);
    expect(names).toContain("go:loki_wall_x_test.go");
  }, 60_000);
  test("a sealed file no runner of this repo can run is not invented into a check", async () => {
    const { repoDir, sha } = wallRepo({ "loki_wall_x.rs": "// no runner\n" });
    const { ctx } = fakeCtx({ repoDir, baseSha: sha, detect: async () => ({ runners: ["cargo"], tests: [] }), impacted: () => [], outputs: { wall: { files: [{ path: join(repoDir, "loki_wall_x.rs") }] } } });
    const names = ((await verifyStage.run(ctx, sig())).data.checks as VerifyCheck[]).map((c) => c.name);
    expect(names.filter((n) => n.includes("loki_wall_x.rs"))).toEqual([]);
  }, 60_000);
  // FC-WALL-GO-FILE-RUNS-WHOLE-PACKAGE: a Go Wall file runs only its own Test functions, never the package's
  test("a Go Wall file is run with -run for its own tests; a red sibling test does not decide the Wall check", async () => {
    const { repoDir, sha } = wallRepo({ "go.mod": "module wallx\n\ngo 1.20\n", "a_test.go": 'package wallx\n\nimport "testing"\n\nfunc TestSibling(t *testing.T) { t.Fatal("sibling is red") }\n', "loki_wall_x_test.go": 'package wallx\n\nimport "testing"\n\nfunc TestMain(m *testing.M) { m.Run() }\n\nfunc TestWall(t *testing.T) {}\n' });
    const { ctx } = fakeCtx({ repoDir, baseSha: sha, detect: async () => ({ runners: ["go"], tests: [] }), impacted: () => [], outputs: { wall: { files: [{ path: join(repoDir, "loki_wall_x_test.go") }] } } });
    const c = ((await verifyStage.run(ctx, sig())).data.checks as VerifyCheck[]).find((k) => k.name.includes("loki_wall_x_test.go"));
    expect(c?.cmd).toContain("-run ^(TestWall)$");
    expect(c?.result).not.toBe("fail");
    expect(c?.result).not.toBe("pass"); // FC-16b: a Go exit 0 is never a pass
  }, 120_000);
  // FC-WALL-RUST-FILE-HAS-NO-RUNNER: a sealed Rust Wall file is run by name or reported NOT PROVEN
  const crate = { "Cargo.toml": '[package]\nname = "wallx"\nversion = "0.1.0"\nedition = "2021"\n', "src/lib.rs": "pub fn one() -> u32 { 1 }\n" };
  test("a file under tests/ runs as `cargo test --test <stem>` and the Wall result is recorded", async () => {
    const { repoDir, sha } = wallRepo({ ...crate, "tests/loki_wall_x.rs": "#[test]\nfn wall() { assert_eq!(wallx::one(), 1); }\n" });
    const { ctx } = fakeCtx({ repoDir, baseSha: sha, detect: async () => ({ runners: ["cargo"], tests: [] }), impacted: () => [], outputs: { wall: { files: [{ path: join(repoDir, "tests/loki_wall_x.rs") }] } } });
    const data = (await verifyStage.run(ctx, sig())).data, checks = data.checks as VerifyCheck[], c = checks.find((k) => k.name.includes("loki_wall_x.rs"));
    expect(c?.cmd).toContain("--test loki_wall_x");
    expect(c?.result).toBe("pass");
    expect(data.wall_passed).toBe(true);
  }, 180_000);
  test("a file outside tests/ makes no check and is named in not_proven", async () => {
    const { repoDir, sha } = wallRepo({ ...crate, "src/loki_wall_x.rs": "// no per-file runner\n" });
    const { ctx } = fakeCtx({ repoDir, baseSha: sha, detect: async () => ({ runners: ["cargo"], tests: [] }), impacted: () => [], outputs: { wall: { files: [{ path: join(repoDir, "src/loki_wall_x.rs") }] } } });
    const data = (await verifyStage.run(ctx, sig())).data;
    expect((data.checks as VerifyCheck[]).filter((k) => k.name.includes("loki_wall_x.rs"))).toEqual([]);
    expect(data.not_proven as string[]).toContain("Wall test not executed: src/loki_wall_x.rs: no runner of this repo runs this file");
  }, 60_000);
});

describe("engine10 verify: red Wall failure tail", () => {
  const wallRun = async (body: string) => {
    const repoDir = mkRepo(), sha = baseSha(repoDir);
    writeFileSync(join(repoDir, "loki_wall_feature_test.ts"), body);
    const f = fakeCtx({ repoDir, baseSha: sha, detect: async () => ({ runners: [], tests: [] }), impacted: () => [], outputs: { wall: { files: [{ path: join(repoDir, "loki_wall_feature_test.ts"), runner: "bun" as const }] } } });
    const res = await verifyStage.run(f.ctx, sig());
    return { f, res, file: join(f.ctx.runDir, WALL_FAILURE_TAIL_FILE) };
  };
  const RED = 'import { test, expect } from "bun:test";\ntest("w", () => expect("sentinel-actual-9f3").toBe("sentinel-expected-9f3"));\n';
  test("a red Wall leaves its failing output in the run dir and verify names the file", async () => {
    const { res, file } = await wallRun(RED);
    expect(res.data.wall_passed).toBe(false);
    expect(res.data.wall_failure_tail).toBe(WALL_FAILURE_TAIL_FILE);
    const t = readFileSync(file, "utf8");
    expect(t).toContain("== bun:loki_wall_feature_test.ts ==");
    expect(t).toContain("sentinel-expected-9f3");
  }, 60_000);
  test("a green Wall writes no file and sets no key", async () => {
    const { res, file } = await wallRun('import { test, expect } from "bun:test";\ntest("w", () => expect(1).toBe(1));\n');
    expect(res.data.wall_passed).toBe(true);
    expect("wall_failure_tail" in res.data).toBe(false);
    expect(existsSync(file)).toBe(false);
  }, 60_000);
  test("the tail text never reaches an emitted event", async () => {
    const { f } = await wallRun(RED);
    expect(JSON.stringify(f.emitted)).not.toContain("sentinel-expected-9f3");
  }, 60_000);
  test("a secret straddling the cap cut is redacted, not left with its prefix cut off", () => {
    const tok = "ghp_" + "A1b2C3d4E5".repeat(4).slice(0, 36), keyed = "token=" + "Zq9".repeat(12);
    for (const secret of [tok, keyed]) {
      const out = "x".repeat(20000) + "\n" + secret + " " + "y".repeat(WALL_FAILURE_TAIL_CAP - 30);
      const t = wallTailOf(out, "/repo");
      expect(t.length).toBeLessThanOrEqual(WALL_FAILURE_TAIL_CAP);
      expect(t).not.toContain(secret.slice(12)); // the part of the secret left after the cut must not survive unredacted
    }
  });
  test("output over the cap keeps only the tail, and a later green run removes the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "e10-wft-")); cleanupDirs.push(dir);
    const out = "HEAD-MARK" + "x".repeat(WALL_FAILURE_TAIL_CAP * 2) + "TAIL-MARK";
    expect(writeWallFailureTail(dir, [{ name: "a", out }])).toBe(WALL_FAILURE_TAIL_FILE);
    const t = readFileSync(join(dir, WALL_FAILURE_TAIL_FILE), "utf8");
    expect(Buffer.byteLength(t)).toBeLessThanOrEqual(WALL_FAILURE_TAIL_CAP + 64);
    expect(t).toContain("TAIL-MARK"); expect(t).not.toContain("HEAD-MARK");
    expect(writeWallFailureTail(dir, [])).toBeUndefined();
    expect(existsSync(join(dir, WALL_FAILURE_TAIL_FILE))).toBe(false);
  });
});

// PR-FIRST-4: the high tier's security scan runs in verify (before seal), so a high-tier receipt is not left waiting on the post-PR deep stage.
describe("PR-FIRST-4 high-tier security scan in verify", () => {
  const high = async (files: Record<string, string>) => {
    const repoDir = mkRepo();
    for (const [f, body] of Object.entries(files)) { mkdirSync(dirname(join(repoDir, f)), { recursive: true }); writeFileSync(join(repoDir, f), body); }
    const { ctx } = fakeCtx({ repoDir, baseSha: baseSha(repoDir) });
    const r = await verifyStage.run(ctx, sig());
    const sec = (r.data.checks as VerifyCheck[]).filter((c) => c.name === "security scan");
    return { r, sec, risk: JSON.parse(readFileSync(join(repoDir, ".loki", "state", "risk-tier.json"), "utf8")) as { tier: string; checks_deferred: string[] } };
  };
  test("a clean high-tier change runs the scan, passes, and drops it from the deferred list", async () => {
    const { sec, risk } = await high({ "src/auth/login.ts": "export const ok = 1;\n" });
    expect(risk.tier).toBe("high");
    expect(sec.map((c) => c.result)).toEqual(["pass"]);
    expect(risk.checks_deferred).not.toContain("security scan");
  }, 60_000);
  test("a secret-looking file fails the scan, which is a failing check (never VERIFIED)", async () => {
    const { r, sec } = await high({ "src/auth/credentials.json": "{}\n" });
    expect(sec.map((c) => c.result)).toEqual(["fail"]);
    expect(String(sec[0]!.reason)).toContain("credentials.json");
    expect((r.data.failures_grouped as { signature: string }[]).some((g) => g.signature.startsWith("security scan"))).toBe(true);
  }, 60_000);
  test("only lines the run added are scanned: a key already on base never fails, the same key added by the run does", async () => {
    const key = `const k = "${"AKIA" + "QWERTYUIOPASDFGH"}";\n`; // built at runtime so the repo's own leak scanner never sees a literal
    const edited = async (added: string) => {
      const repoDir = mkRepo();
      mkdirSync(join(repoDir, "src", "auth"), { recursive: true });
      writeFileSync(join(repoDir, "src", "auth", "keys.ts"), key);
      git(repoDir, ["add", "-A"]); git(repoDir, ["commit", "-qm", "base with a key"]);
      const base = baseSha(repoDir);
      writeFileSync(join(repoDir, "src", "auth", "keys.ts"), key + added);
      const { ctx } = fakeCtx({ repoDir, baseSha: base });
      const r = await verifyStage.run(ctx, sig());
      return (r.data.checks as VerifyCheck[]).filter((c) => c.name === "security scan");
    };
    expect((await edited("export const ok = 1;\n")).map((c) => c.result)).toEqual(["pass"]);
    const bad = await edited(key.replace("k =", "k2 ="));
    expect(bad.map((c) => c.result)).toEqual(["fail"]);
    expect(String(bad[0]!.reason)).toContain("src/auth/keys.ts");
  }, 120_000);
  test("a scanner that cannot run (secret-scan.sh fails to load) is not_run, NOT PROVEN in verify's own list (caps the verdict), and stays deferred", async () => {
    const bin = mkdtempSync(join(tmpdir(), "e10-verify-bin-")); cleanupDirs.push(bin);
    writeFileSync(join(bin, "bash"), "#!/bin/sh\nexit 3\n"); chmodSync(join(bin, "bash"), 0o755); // the scan's bash cannot source the matcher script
    const oldPath = process.env["PATH"];
    try {
      process.env["PATH"] = `${bin}:${oldPath ?? ""}`;
      const { r, sec, risk } = await high({ "src/auth/login.ts": "export const ok = 1;\n" });
      expect(sec.map((c) => c.result)).toEqual(["not_run"]);
      expect((r.data.not_proven as string[]).some((n) => n.startsWith("not run: security scan (") && n.includes("secret-scan.sh failed to load"))).toBe(true);
      expect(risk.checks_deferred).toContain("security scan");
    } finally { process.env["PATH"] = oldPath; }
  }, 60_000);
});
