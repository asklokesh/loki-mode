// E-09 Wall check (docs/v10/ENGINE.md section 16).
//
// testmap.ts (E-05) and machine.ts (E-02) are not on main: RunContext.tests
// is always a fake TestMapProvider here, never a real import of testmap.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventType, RunContext, StageName, TestMap, TestRef } from "../../src/engine10/types.ts";
import { changedFiles, runCheck, runLintChecks, runnerCmd, verifyStage, type VerifyCheck } from "../../src/engine10/stages/verify.ts";

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
    outputs: () => opts.outputs ?? {},
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
    expect(emitted.filter((e) => e.type === "test.result")).toHaveLength(1);
  }, 20_000);

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
    writeFileSync(join(shimDir, "python3"), "#!/usr/bin/env bash\nexit 0\n");
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
    writeFileSync(join(shimDir, "python3"), "#!/usr/bin/env bash\nexit 0\n"); // the correct PATH fallback
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
