// loki-ts/tests/engine10/wall.test.ts
//
// E-15 wall check (docs/v10/ENGINE.md sections 4 and 16). Depends on
// machine.ts/intake.ts/session.ts only through the RunContext/SessionRunner
// interfaces in types.ts, so every sibling here is a fake.
import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWallBrief,
  classify,
  RealBaseTestRunner,
  runWall,
  wallStage,
  type BaseTestRunner,
} from "../../src/engine10/stages/wall.ts";
import type {
  RunContext,
  SessionResult,
  SessionRunOptions,
  SessionRunner,
  StageName,
} from "../../src/engine10/types.ts";

const FIX = join(import.meta.dir, "fixtures", "wall");
const SAMPLE = readFileSync(join(FIX, "loki_wall_sample.test.ts"), "utf8");

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

class FakeSessionRunner implements SessionRunner {
  lastOpts: SessionRunOptions | null = null;
  constructor(private onRun?: (opts: SessionRunOptions) => void) {}
  async run(opts: SessionRunOptions): Promise<SessionResult> {
    this.lastOpts = opts;
    this.onRun?.(opts);
    return { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0.1, killed: false };
  }
}

class FakeBaseTestRunner implements BaseTestRunner {
  calls: unknown[] = [];
  constructor(private result: { pass: number; fail: number }) {}
  run(repoDir: string, files: unknown): { pass: number; fail: number } {
    this.calls.push(files);
    return this.result;
  }
}

/** Real repoDir/runDir on disk (wall.ts does real file I/O); everything else
 *  the machine/session/testmap would own is faked. */
function setup(testmap: { runners: string[]; tests: { runner: string; path: string }[] }) {
  const repoDir = mkdtempSync(join(tmpdir(), "loki-e15-repo-"));
  const runDir = join(repoDir, ".loki", "runs", "e10-test-1");
  mkdirSync(runDir, { recursive: true });
  const repomapRef = join(runDir, "repomap.json");
  writeFileSync(
    repomapRef,
    JSON.stringify({ files: ["src/a.ts"], entries: [{ path: "src/a.ts", symbols: ["foo"] }], truncated: false }),
    "utf8",
  );
  return { repoDir, runDir, repomapRef, testmap };
}

function fakeCtx(
  repoDir: string,
  runDir: string,
  sessions: SessionRunner,
  outputs: Partial<Record<StageName, Record<string, unknown>>>,
  events: string[],
): RunContext {
  return {
    runId: "e10-test-1",
    repoDir,
    runDir,
    baseSha: "deadbeef",
    branch: "loki/e10-test-1",
    provider: "claude",
    model: "claude-test",
    deep: false,
    capS: 900,
    emit: (type, stage) => {
      events.push(`${type}:${stage}`);
    },
    sessions,
    tests: {
      async detect() {
        return { runners: [], tests: [] };
      },
      impacted() {
        return [];
      },
    },
    cost: {
      read() {
        return { usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
      },
    },
    clock: { now: () => 0 },
    outputs: () => outputs,
  };
}

describe("engine10 wall brief", () => {
  test("tells the session it cannot see the repo and names the loki_wall_ prefix", () => {
    const brief = buildWallBrief("add a search bar");
    expect(brief).toContain("add a search bar");
    expect(brief.toLowerCase()).toContain("cannot see the repository");
    expect(brief).toContain("loki_wall_");
  });
});

describe("engine10 wall stage", () => {
  test("the session cwd holds only task.md and repomap.txt: never the repo", async () => {
    const { repoDir, runDir, testmap: tm } = setup({ runners: ["vitest"], tests: [] });
    const events: string[] = [];
    let seenCwdListing: string[] = [];
    const sessions = new FakeSessionRunner((opts) => {
      seenCwdListing = readdirSync(opts.cwd!).sort();
    });
    const ctx = fakeCtx(repoDir, runDir, sessions, { intake: { task: "add x", testmap: tm, repomap_ref: join(runDir, "repomap.json") } }, events);

    await wallStage.run(ctx, new AbortController().signal);

    expect(seenCwdListing).toEqual(["repomap.txt", "task.md"]);
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("seals the generated files (sha256) and emits wall.sealed before implement's session starts", async () => {
    const { repoDir, runDir, testmap: tm } = setup({ runners: ["vitest"], tests: [] });
    const events: string[] = [];
    const sessions = new FakeSessionRunner((opts) => {
      writeFileSync(join(opts.cwd!, "loki_wall_sample.test.ts"), SAMPLE, "utf8");
    });
    const baseRunner = new FakeBaseTestRunner({ pass: 1, fail: 0 });
    const ctx = fakeCtx(repoDir, runDir, sessions, { intake: { task: "add x", testmap: tm, repomap_ref: join(runDir, "repomap.json") } }, events);

    const result = await runWall(ctx, new AbortController().signal, { baseRunner });
    // Simulate the machine moving on to Implement's session once Wall (and Plan) complete.
    ctx.emit("session.started", "implement", {});

    expect(result.status).toBe("completed");
    const files = result.data.files as { path: string; sha256: string }[];
    expect(files).toHaveLength(1);
    expect(files[0]!.sha256).toBe(sha256(SAMPLE));
    expect(readFileSync(files[0]!.path, "utf8")).toBe(SAMPLE);
    expect(events.indexOf("wall.sealed:wall")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("wall.sealed:wall")).toBeLessThan(events.indexOf("session.started:implement"));

    rmSync(repoDir, { recursive: true, force: true });
  });

  test("all Wall tests passing on the base tree short-circuits to already_satisfied", async () => {
    const { repoDir, runDir, testmap: tm } = setup({ runners: ["vitest"], tests: [] });
    const events: string[] = [];
    const sessions = new FakeSessionRunner((opts) => {
      writeFileSync(join(opts.cwd!, "loki_wall_sample.test.ts"), SAMPLE, "utf8");
    });
    const baseRunner = new FakeBaseTestRunner({ pass: 1, fail: 0 });
    const ctx = fakeCtx(repoDir, runDir, sessions, { intake: { task: "add x", testmap: tm, repomap_ref: join(runDir, "repomap.json") } }, events);

    const result = await runWall(ctx, new AbortController().signal, { baseRunner });

    expect(result.data.already_satisfied).toBe(true);
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("a base-tree failure never short-circuits", async () => {
    const { repoDir, runDir, testmap: tm } = setup({ runners: ["vitest"], tests: [] });
    const events: string[] = [];
    const sessions = new FakeSessionRunner((opts) => {
      writeFileSync(join(opts.cwd!, "loki_wall_sample.test.ts"), SAMPLE, "utf8");
    });
    const baseRunner = new FakeBaseTestRunner({ pass: 0, fail: 1 });
    const ctx = fakeCtx(repoDir, runDir, sessions, { intake: { task: "add x", testmap: tm, repomap_ref: join(runDir, "repomap.json") } }, events);

    const result = await runWall(ctx, new AbortController().signal, { baseRunner });

    expect(result.data.already_satisfied).toBe(false);
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("no generated files: empty seal, never already_satisfied, and the base runner is not asked to run", async () => {
    const { repoDir, runDir, testmap: tm } = setup({ runners: ["vitest"], tests: [] });
    const events: string[] = [];
    const sessions = new FakeSessionRunner(); // writes nothing
    const baseRunner = new FakeBaseTestRunner({ pass: 99, fail: 0 });
    const ctx = fakeCtx(repoDir, runDir, sessions, { intake: { task: "add x", testmap: tm, repomap_ref: join(runDir, "repomap.json") } }, events);

    const result = await runWall(ctx, new AbortController().signal, { baseRunner });

    expect(result.data.files).toEqual([]);
    expect(result.data.already_satisfied).toBe(false);
    expect(baseRunner.calls).toHaveLength(0);
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("briefs the author with intake's task (E-42: intake outputs it), never an env fallback", async () => {
    const { repoDir, runDir, testmap: tm } = setup({ runners: ["vitest"], tests: [] });
    let seenTaskMd = "";
    const sessions = new FakeSessionRunner((opts) => {
      seenTaskMd = readFileSync(join(opts.cwd!, "task.md"), "utf8");
    });
    const ctx = fakeCtx(repoDir, runDir, sessions, { intake: { task: "add a search bar", testmap: tm, repomap_ref: join(runDir, "repomap.json") } }, []);
    const prevEnv = process.env.LOKI_E10_TASK_TEXT;
    process.env.LOKI_E10_TASK_TEXT = "not this";
    try {
      const r = await wallStage.run(ctx, new AbortController().signal);
      expect(r.data.iteration_ids).toEqual([`${ctx.runId}-wall`]);
    } finally {
      if (prevEnv === undefined) delete process.env.LOKI_E10_TASK_TEXT;
      else process.env.LOKI_E10_TASK_TEXT = prevEnv;
    }
    expect(seenTaskMd).toBe("add a search bar");
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("a sealed file whose runner cannot be guessed never counts toward already_satisfied, even if every executed test passes", async () => {
    const { repoDir, runDir, testmap: tm } = setup({ runners: [], tests: [] });
    const events: string[] = [];
    const sessions = new FakeSessionRunner((opts) => {
      // .py always resolves to pytest regardless of the detected runners;
      // the second file's extension matches no runner and none of
      // vitest/jest/bun are detected, so guessRunner() returns null for it.
      writeFileSync(join(opts.cwd!, "loki_wall_a.py"), "def test_a(): assert True", "utf8");
      writeFileSync(join(opts.cwd!, "loki_wall_b.rb"), "# unselectable", "utf8");
    });
    // Only the one selectable (pytest) file is ever handed to the runner,
    // and it "passes" - the old bug reported already_satisfied: true here.
    const baseRunner = new FakeBaseTestRunner({ pass: 1, fail: 0 });
    const ctx = fakeCtx(repoDir, runDir, sessions, { intake: { task: "add x", testmap: tm, repomap_ref: join(runDir, "repomap.json") } }, events);

    const result = await runWall(ctx, new AbortController().signal, { baseRunner });

    expect((result.data.files as unknown[]).length).toBe(2); // both sealed
    expect(baseRunner.calls[0]).toHaveLength(1); // only one ever executed
    expect(result.data.already_satisfied).toBe(false);
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("places generated files alongside an existing detected test file, not tests/", async () => {
    const { repoDir, runDir, testmap: tm } = setup({
      runners: ["vitest"],
      tests: [{ runner: "vitest", path: "src/foo.test.ts" }],
    });
    const events: string[] = [];
    const sessions = new FakeSessionRunner((opts) => {
      writeFileSync(join(opts.cwd!, "loki_wall_sample.test.ts"), SAMPLE, "utf8");
    });
    const baseRunner = new FakeBaseTestRunner({ pass: 1, fail: 0 });
    const ctx = fakeCtx(repoDir, runDir, sessions, { intake: { task: "add x", testmap: tm, repomap_ref: join(runDir, "repomap.json") } }, events);

    const result = await runWall(ctx, new AbortController().signal, { baseRunner });

    const files = result.data.files as { path: string }[];
    expect(files[0]!.path).toBe(join(repoDir, "src", "loki_wall_sample.test.ts"));
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("readOnlyFiles carries {path, content} for implement.ts to enforce", async () => {
    const { repoDir, runDir, testmap: tm } = setup({ runners: ["vitest"], tests: [] });
    const events: string[] = [];
    const sessions = new FakeSessionRunner((opts) => {
      writeFileSync(join(opts.cwd!, "loki_wall_sample.test.ts"), SAMPLE, "utf8");
    });
    const baseRunner = new FakeBaseTestRunner({ pass: 1, fail: 0 });
    const ctx = fakeCtx(repoDir, runDir, sessions, { intake: { task: "add x", testmap: tm, repomap_ref: join(runDir, "repomap.json") } }, events);

    const result = await runWall(ctx, new AbortController().signal, { baseRunner });

    const readOnly = result.data.readOnlyFiles as { path: string; content: string }[];
    expect(readOnly).toHaveLength(1);
    expect(readOnly[0]!.content).toBe(SAMPLE);
    rmSync(repoDir, { recursive: true, force: true });
  });

  // A real git repo, .loki ignored, so `git status` reflects only what wall.ts wrote to the tree.
  function initGitRepo(repoDir: string): (...args: string[]) => string {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "e54@test.local");
    git("config", "user.name", "e54-test");
    writeFileSync(join(repoDir, ".gitignore"), ".loki/\n", "utf8");
    git("add", ".gitignore");
    git("commit", "-q", "-m", "init");
    return git;
  }

  test("E-54: an aborted, killed, or timed-out session never copies its test file into the repo", async () => {
    const { repoDir, runDir, testmap: tm } = setup({ runners: ["vitest"], tests: [] });
    const git = initGitRepo(repoDir);

    // The session writes its file before it is killed: a real Wall author can be
    // mid-write when the group is SIGTERM/SIGKILL'd or the AbortSignal fires.
    class KilledSessionRunner implements SessionRunner {
      async run(opts: SessionRunOptions): Promise<SessionResult> {
        writeFileSync(join(opts.cwd!, "loki_wall_sample.test.ts"), SAMPLE, "utf8");
        return { exit: null, markers: { done: false, alreadyDone: null, specConflict: null }, durationS: 1, killed: true };
      }
    }
    const baseRunner = new FakeBaseTestRunner({ pass: 99, fail: 0 });
    const ctx = fakeCtx(repoDir, runDir, new KilledSessionRunner(), { intake: { task: "add x", testmap: tm, repomap_ref: join(runDir, "repomap.json") } }, []);

    const result = await runWall(ctx, new AbortController().signal, { baseRunner });

    expect(result.status).toBe("failed");
    expect(result.data.files ?? []).toEqual([]);
    expect(baseRunner.calls).toHaveLength(0);
    expect(git("status", "--porcelain").trim()).toBe("");
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("E-54: a session killed from outside (exit null, killed false) also never copies its test file", async () => {
    const { repoDir, runDir, testmap: tm } = setup({ runners: ["vitest"], tests: [] });
    const git = initGitRepo(repoDir);

    // types.ts documents exit:null as "killed before exiting" independent of the killed flag: an
    // external SIGKILL (OOM killer, a supervisor outside our own AbortSignal path) reports this
    // shape without ever setting killed=true.
    class ExternallyKilledSessionRunner implements SessionRunner {
      async run(opts: SessionRunOptions): Promise<SessionResult> {
        writeFileSync(join(opts.cwd!, "loki_wall_sample.test.ts"), SAMPLE, "utf8");
        return { exit: null, markers: { done: false, alreadyDone: null, specConflict: null }, durationS: 1, killed: false };
      }
    }
    const baseRunner = new FakeBaseTestRunner({ pass: 99, fail: 0 });
    const ctx = fakeCtx(repoDir, runDir, new ExternallyKilledSessionRunner(), { intake: { task: "add x", testmap: tm, repomap_ref: join(runDir, "repomap.json") } }, []);

    const result = await runWall(ctx, new AbortController().signal, { baseRunner });

    expect(result.status).toBe("failed");
    expect(result.data.files ?? []).toEqual([]);
    expect(baseRunner.calls).toHaveLength(0);
    expect(git("status", "--porcelain").trim()).toBe("");
    rmSync(repoDir, { recursive: true, force: true });
  });
});

// D42 (3) / S41-16: RealBaseTestRunner must resolve the interpreter the way verify.ts does since
// E-98a, and never read a launch failure as a failing test. Exercises the real subprocess path
// (no fakes) so the classification is proven against an actual pytest, not a mocked exit code.
describe("engine10 wall base run, D42 (3)", () => {
  const PYTHON3 = Bun.which("python3");
  if (!PYTHON3) throw new Error("python3 not found on PATH: required to exercise RealBaseTestRunner");

  function repo(): string {
    return mkdtempSync(join(tmpdir(), "loki-s41-16-"));
  }

  /** repoDir/.venv/bin/python execs the host's real python3, found via .venv (E-98a), never PATH. */
  // E-132/r5: CI installs pytest (test.yml, coverage.yml, release.yml); without it fail loudly, never misread.
  const HAS_PYTEST = spawnSync(PYTHON3, ["-m", "pytest", "--version"]).status === 0;
  function venvShim(repoDir: string): void {
    if (!HAS_PYTEST) throw new Error(`pytest required for this test: ${PYTHON3} -m pytest is unavailable`);
    mkdirSync(join(repoDir, ".venv", "bin"), { recursive: true });
    writeFileSync(join(repoDir, ".venv", "bin", "python"), `#!/bin/sh\nexec ${PYTHON3} "$@"\n`, { mode: 0o755 });
  }

  /** Overrides PATH to an empty dir for the duration of `fn`, so no `python`/`python3` resolves at all. */
  function withNoInterpreterOnPath<T>(fn: () => T): T {
    const emptyDir = mkdtempSync(join(tmpdir(), "loki-s41-16-empty-path-"));
    const prevPath = process.env.PATH;
    process.env.PATH = emptyDir;
    try {
      return fn();
    } finally {
      process.env.PATH = prevPath;
      rmSync(emptyDir, { recursive: true, force: true });
    }
  }

  test("(1) no `python` on PATH, a .venv shim, a genuinely failing test: red, and the seal proceeds", () => {
    const repoDir = repo();
    venvShim(repoDir);
    writeFileSync(join(repoDir, "loki_wall_fail.py"), "def test_x():\n    assert False\n", "utf8");

    const result = new RealBaseTestRunner().run(repoDir, [{ runner: "pytest", path: "loki_wall_fail.py" }]);

    expect(result).toEqual({ pass: 0, fail: 1, not_run: 0 });
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("(2) no interpreter at all: not_run, and the seal is refused (never counted as red)", () => {
    const repoDir = repo();
    writeFileSync(join(repoDir, "loki_wall_fail.py"), "def test_x():\n    assert False\n", "utf8");

    const result = withNoInterpreterOnPath(() =>
      new RealBaseTestRunner().run(repoDir, [{ runner: "pytest", path: "loki_wall_fail.py" }]),
    );

    expect(result).toEqual({ pass: 0, fail: 0, not_run: 1 });
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("(3a) ImportError on a missing repo symbol: red", () => {
    const repoDir = repo();
    venvShim(repoDir); // B4 (r2): must be the project interpreter, or classify() short-circuits to not_run
    mkdirSync(join(repoDir, "mypkg"), { recursive: true });
    writeFileSync(join(repoDir, "mypkg", "__init__.py"), "", "utf8");
    writeFileSync(join(repoDir, "mypkg", "mymod.py"), "# the feature is not built yet\n", "utf8");
    writeFileSync(join(repoDir, "loki_wall_import.py"), "from mypkg.mymod import missing_function\n\ndef test_x():\n    missing_function()\n", "utf8");

    const result = new RealBaseTestRunner().run(repoDir, [{ runner: "pytest", path: "loki_wall_import.py" }]);

    expect(result).toEqual({ pass: 0, fail: 1, not_run: 0 });
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("(3b) ImportError on a missing third-party package: not_run", () => {
    const repoDir = repo();
    venvShim(repoDir);
    writeFileSync(join(repoDir, "loki_wall_thirdparty.py"), "import loki_s41_16_never_installed_xyz\n\ndef test_x():\n    pass\n", "utf8");

    const result = new RealBaseTestRunner().run(repoDir, [{ runner: "pytest", path: "loki_wall_thirdparty.py" }]);

    expect(result).toEqual({ pass: 0, fail: 0, not_run: 1 });
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("(4) pytest exit 5, no tests collected: not_run", () => {
    const repoDir = repo();
    venvShim(repoDir);
    writeFileSync(join(repoDir, "loki_wall_empty.py"), "# no test_ functions in this file\nx = 1\n", "utf8");

    const result = new RealBaseTestRunner().run(repoDir, [{ runner: "pytest", path: "loki_wall_empty.py" }]);

    expect(result).toEqual({ pass: 0, fail: 0, not_run: 1 });
    rmSync(repoDir, { recursive: true, force: true });
  });

  // r2 rework: B2, B3, B4 unit-test classify() directly with synthetic status/output, so they never
  // depend on real vitest/jest binaries (not installed here) or on the host's PATH state.
  test("(B2) jest/vitest/bun red needs a parsed failed count; npm/go/cargo never fail (coarse)", () => {
    const repoDir = repo();
    expect(classify({ runner: "vitest", path: "x" }, 1, "Test Files  1 failed (1)\n     Tests  1 failed | 2 passed (3)\n", repoDir)).toBe("fail");
    expect(classify({ runner: "vitest", path: "x" }, 1, "a crash before any summary line\n", repoDir)).toBe("not_run");
    expect(classify({ runner: "jest", path: "x" }, 1, "Tests:       2 failed, 1 passed, 3 total\n", repoDir)).toBe("fail");
    expect(classify({ runner: "bun", path: "x" }, 1, " 0 pass\n 1 fail\n", repoDir)).toBe("fail");
    expect(classify({ runner: "npm", path: "x" }, 1, "npm test failed somewhere in the whole suite\n", repoDir)).toBe("not_run");
    expect(classify({ runner: "go", path: "x" }, 1, "FAIL\texample.com/pkg 0.01s\n", repoDir)).toBe("not_run");
    rmSync(repoDir, { recursive: true, force: true });
  });

  // E-125 (real fixtures, not synthetic strings): real pytest reports the frame it needs to read as
  // "path.py:N: in <scope>" (relative to repoDir), not the plain-traceback "File \"path\", line N" the
  // old B3 fixtures assumed -- that shape never appears for pytest's own collection frames, so the red
  // class never fired. (3a)/(3b) above already prove the ImportError/third-party-module shapes for real.
  test("(3c) AttributeError on a repo symbol at collection time: red", () => {
    const repoDir = repo();
    venvShim(repoDir);
    mkdirSync(join(repoDir, "mypkg"), { recursive: true });
    writeFileSync(join(repoDir, "mypkg", "__init__.py"), "", "utf8");
    writeFileSync(join(repoDir, "mypkg", "mymod.py"), "# the feature is not built yet\n", "utf8");
    writeFileSync(join(repoDir, "loki_wall_attr.py"), "from mypkg import mymod\n\nVALUE = mymod.missing_attribute\n\ndef test_x():\n    pass\n", "utf8");

    const result = new RealBaseTestRunner().run(repoDir, [{ runner: "pytest", path: "loki_wall_attr.py" }]);

    expect(result).toEqual({ pass: 0, fail: 1, not_run: 0 });
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("(3d) AttributeError raised by an outside (non-repo) frame reached via a repo import: not_run, not red", () => {
    const repoDir = repo();
    venvShim(repoDir);
    const outsideDir = mkdtempSync(join(tmpdir(), "loki-e125-outside-"));
    writeFileSync(join(outsideDir, "thirdparty_plugin.py"), "VALUE = None.missing_attr\n", "utf8");
    writeFileSync(
      join(repoDir, "loki_wall_outside.py"),
      `import sys\nsys.path.insert(0, ${JSON.stringify(outsideDir)})\nimport thirdparty_plugin\n\ndef test_x():\n    pass\n`,
      "utf8",
    );

    const result = new RealBaseTestRunner().run(repoDir, [{ runner: "pytest", path: "loki_wall_outside.py" }]);

    expect(result).toEqual({ pass: 0, fail: 0, not_run: 1 });
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  test("(3e) a syntax error at collection: not_run (D42 names only ImportError/AttributeError/NameError)", () => {
    const repoDir = repo();
    venvShim(repoDir);
    writeFileSync(join(repoDir, "loki_wall_syntax.py"), "def test_x(:\n    pass\n", "utf8");

    const result = new RealBaseTestRunner().run(repoDir, [{ runner: "pytest", path: "loki_wall_syntax.py" }]);

    expect(result).toEqual({ pass: 0, fail: 0, not_run: 1 });
    rmSync(repoDir, { recursive: true, force: true });
  });

  // opus review of E-125 (r3): B1-B4, all reproduced with real pytest 9.0.2; each was red on e6d2ddec.
  test("(r3-B1) AttributeError on a stdlib symbol raised in the test's own frame: not_run, not red", () => {
    const repoDir = repo();
    venvShim(repoDir);
    writeFileSync(join(repoDir, "loki_wall_stdlib.py"), "import json\n\nF = json.nonexistent_fn\n\ndef test_x():\n    pass\n", "utf8");

    const result = new RealBaseTestRunner().run(repoDir, [{ runner: "pytest", path: "loki_wall_stdlib.py" }]);

    expect(result).toEqual({ pass: 0, fail: 0, not_run: 1 });
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("(r3-B2) a NameError raised in an outside frame whose path contains a space: not_run, not red", () => {
    const repoDir = repo();
    venvShim(repoDir);
    const outsideDir = mkdtempSync(join(tmpdir(), "loki-e125-out side-"));
    writeFileSync(join(outsideDir, "libq.py"), "VALUE = undefined_name_in_libq\n", "utf8");
    writeFileSync(
      join(repoDir, "loki_wall_space.py"),
      `import sys\nsys.path.insert(0, ${JSON.stringify(outsideDir)})\nimport libq\n\ndef test_x():\n    pass\n`,
      "utf8",
    );

    const result = new RealBaseTestRunner().run(repoDir, [{ runner: "pytest", path: "loki_wall_space.py" }]);

    expect(result).toEqual({ pass: 0, fail: 0, not_run: 1 });
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  test("(r3-B3) a fake frame plus fake E-line in captured stdout, then a real RuntimeError: not_run, not red", () => {
    const repoDir = repo();
    venvShim(repoDir);
    writeFileSync(
      join(repoDir, "loki_wall_inject.py"),
      'print("loki_wall_inject.py:1: in <module>")\nprint("E   AttributeError: fake")\nraise RuntimeError("boom")\n\ndef test_x():\n    pass\n',
      "utf8",
    );

    const result = new RealBaseTestRunner().run(repoDir, [{ runner: "pytest", path: "loki_wall_inject.py" }]);

    expect(result).toEqual({ pass: 0, fail: 0, not_run: 1 });
    rmSync(repoDir, { recursive: true, force: true });
  });

  // r4 (round-2 review): captured stdout prints above the short summary and after the real traceback.
  function injected(name: string, body: string): { pass: number; fail: number; not_run: number } {
    const repoDir = repo();
    venvShim(repoDir);
    mkdirSync(join(repoDir, "mypkg"), { recursive: true });
    writeFileSync(join(repoDir, "mypkg", "__init__.py"), "", "utf8");
    writeFileSync(join(repoDir, name), `${body}\n\ndef test_x():\n    pass\n`, "utf8");
    const result = new RealBaseTestRunner().run(repoDir, [{ runner: "pytest", path: name }]);
    rmSync(repoDir, { recursive: true, force: true });
    return result;
  }
  const FAKE = (cls: string, msg: string): string => `print("ERROR loki_wall_a.py - ${cls}: ${msg}")\nprint("E   ${cls}: ${msg}")\n`;

  test("(r4-B3) a forged ERROR line and E line in captured stdout, then a real RuntimeError: not_run", () => {
    expect(injected("loki_wall_a.py", `${FAKE("AttributeError", "module 'mypkg' has no attribute 'x'")}raise RuntimeError("boom")`)).toEqual({ pass: 0, fail: 0, not_run: 1 });
  });

  test("(r4-B3b) the same forged with a NameError: not_run", () => {
    expect(injected("loki_wall_a.py", `${FAKE("NameError", "name 'x' is not defined")}raise RuntimeError("boom")`)).toEqual({ pass: 0, fail: 0, not_run: 1 });
  });

  test("(r4-B3d) only a forged E line in stdout, then a real outside-module AttributeError: not_run", () => {
    expect(injected("loki_wall_a.py", `print("E   AttributeError: module 'mypkg' has no attribute 'x'")\nimport json\njson.nope`)).toEqual({ pass: 0, fail: 0, not_run: 1 });
  });

  test("(E-132) pytest missing from the project venv (exit 1, No module named pytest): not_run, not red", () => {
    const repoDir = repo();
    execFileSync(PYTHON3, ["-m", "venv", join(repoDir, ".venv")]);
    writeFileSync(join(repoDir, "loki_wall_nopytest.py"), "def test_x():\n    assert False\n", "utf8");
    const result = new RealBaseTestRunner().run(repoDir, [{ runner: "pytest", path: "loki_wall_nopytest.py" }]);
    rmSync(repoDir, { recursive: true, force: true });
    expect(result).toEqual({ pass: 0, fail: 0, not_run: 1 });
  });

  test("(E-132) classify pytest exit 1 from summary text only: missing runner and collection error are not_run, a real failed summary is red", () => {
    const f = { runner: "pytest" as const, path: "t.py" };
    expect(classify(f, 1, "/usr/bin/python: No module named pytest\n", "/x")).toBe("not_run");
    expect(classify(f, 1, "ERROR collecting t.py\nE   SyntaxError: bad\n=== short test summary info ===\nERROR t.py\n!!! Interrupted: 1 error during collection !!!\n=== 1 error in 0.10s ===\n", "/x")).toBe("not_run");
    expect(classify(f, 1, "=== short test summary info ===\nFAILED t.py::test_a - assert 0\n=== 1 failed in 0.10s ===\n", "/x")).toBe("fail");
  });

  // r5 (opus r4): real-pytest fixtures for the verbosity and forgery blockers.
  function run1(name: string, body: string, extra: Record<string, string> = {}): { pass: number; fail: number; not_run: number } {
    const repoDir = repo();
    venvShim(repoDir);
    for (const [k, v] of Object.entries(extra)) writeFileSync(join(repoDir, k), v, "utf8");
    writeFileSync(join(repoDir, name), body, "utf8");
    const result = new RealBaseTestRunner().run(repoDir, [{ runner: "pytest", path: name }]);
    rmSync(repoDir, { recursive: true, force: true });
    return result;
  }
  const FAILING = "def test_a():\n    assert 0\n";
  test("(r5-B1) addopts `-ra -q` (stacks to -qq, no footer) plus a real failure: red", () => {
    expect(run1("loki_wall_x.py", FAILING, { "pyproject.toml": '[tool.pytest.ini_options]\naddopts = "-ra -q"\n' })).toEqual({ pass: 0, fail: 1, not_run: 0 });
  });
  test("(r5-B1b) pytest.ini `-q` plus a real failure: red", () => {
    expect(run1("loki_wall_x.py", FAILING, { "pytest.ini": "[pytest]\naddopts = -q\n" })).toEqual({ pass: 0, fail: 1, not_run: 0 });
  });
  test("(r5-B2) pytest.exit('1 failed', returncode=1): not_run", () => {
    expect(run1("loki_wall_x.py", "import pytest\ndef test_a():\n    pytest.exit('1 failed', returncode=1)\n")).toEqual({ pass: 0, fail: 0, not_run: 1 });
  });
  test("(r5-B2b) pytest.exit('x\\n1 failed', returncode=1): not_run", () => {
    expect(run1("loki_wall_x.py", "import pytest\ndef test_a():\n    pytest.exit('x\\n1 failed', returncode=1)\n")).toEqual({ pass: 0, fail: 0, not_run: 1 });
  });
  test("(r5-B2d) pytest.exit('x\\n1 failed in 0.01s', returncode=1) forges a footer-shaped line: not_run (Exit-banner check)", () => {
    expect(run1("loki_wall_x.py", "import pytest\ndef test_a():\n    pytest.exit('x\\n1 failed in 0.01s', returncode=1)\n")).toEqual({ pass: 0, fail: 0, not_run: 1 });
  });
  test("(r5-B2c) pytest.exit('x\\nFAILED a.py::t - boom', returncode=1) under -ra addopts: not_run", () => {
    expect(run1("loki_wall_x.py", "import pytest\ndef test_a():\n    pytest.exit('x\\nFAILED a.py::t - boom', returncode=1)\n", { "pytest.ini": "[pytest]\naddopts = -ra -q\n" })).toEqual({ pass: 0, fail: 0, not_run: 1 });
  });

  test("(r3-B4) a chained AttributeError then a final RuntimeError: not_run, not red", () => {
    const repoDir = repo();
    venvShim(repoDir);
    writeFileSync(
      join(repoDir, "loki_wall_chained.py"),
      'try:\n    import json\n    X = json.nonexistent_fn\nexcept AttributeError:\n    raise RuntimeError("boom")\n\ndef test_x():\n    pass\n',
      "utf8",
    );

    const result = new RealBaseTestRunner().run(repoDir, [{ runner: "pytest", path: "loki_wall_chained.py" }]);

    expect(result).toEqual({ pass: 0, fail: 0, not_run: 1 });
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("(B4) any result on the system interpreter is not_run, even an apparent pass", () => {
    const repoDir = repo();
    expect(classify({ runner: "pytest", path: "x" }, 0, "", repoDir, "system")).toBe("not_run");
    expect(classify({ runner: "pytest", path: "x" }, 1, "F", repoDir, "system")).toBe("not_run");
    expect(classify({ runner: "pytest", path: "x" }, 0, "1 passed in 0.01s", repoDir, "project")).toBe("pass");
    rmSync(repoDir, { recursive: true, force: true });
  });
});

// D77 / W1-S2: LOKI_E10_WALL_MANIFEST puts a signatures-only wall_manifest.txt in the Wall cwd.
describe("engine10 wall manifest wiring, D77", () => {
  const SRC = 'export function search(q: string): string[] {\n  const secret = "CANARY_BODY_7731";\n  return [q, secret];\n}\n';
  function gitRepo() {
    const s = setup({ runners: ["bun"], tests: [{ runner: "bun", path: "tests/a.test.ts" }] });
    const g = (...a: string[]) => execFileSync("git", ["-C", s.repoDir, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" }).trim();
    g("init", "-q");
    mkdirSync(join(s.repoDir, "src")); mkdirSync(join(s.repoDir, "tests"));
    writeFileSync(join(s.repoDir, "package.json"), '{"scripts":{"test":"bun test"}}', "utf8");
    writeFileSync(join(s.repoDir, "src", "search.ts"), SRC, "utf8");
    writeFileSync(join(s.repoDir, "tests", "a.test.ts"), 'import { test } from "bun:test";\ntest("a", () => {});\n', "utf8");
    g("add", "package.json", "src/search.ts", "tests/a.test.ts"); g("commit", "-q", "-m", "base");
    writeFileSync(join(s.repoDir, "src", "search.ts"), SRC.replace("CANARY_BODY_7731", "CANARY_DIFF_5519"), "utf8"); // uncommitted implement change
    return { ...s, tree: g("rev-parse", "HEAD^{tree}") };
  }
  async function wall(flag: string | undefined) {
    const s = gitRepo(), events: { type: string; data: Record<string, unknown> }[] = [];
    let listing: string[] = [], files: Record<string, string> = {}, brief = "";
    const sessions = new FakeSessionRunner((o) => {
      listing = readdirSync(o.cwd!).sort(); brief = o.brief;
      files = Object.fromEntries(listing.map((f) => [f, readFileSync(join(o.cwd!, f), "utf8")]));
    });
    const ctx = fakeCtx(s.repoDir, s.runDir, sessions, {
      intake: { task: "extend search in search.ts", testmap: s.testmap, repomap_ref: s.repomapRef, tree: s.tree },
      implement: { diff: "+ CANARY_DIFF_5519" },
    }, []);
    ctx.emit = (type, _stage, data) => { events.push({ type, data: (data ?? {}) as Record<string, unknown> }); };
    const prev = process.env.LOKI_E10_WALL_MANIFEST;
    if (flag === undefined) delete process.env.LOKI_E10_WALL_MANIFEST; else process.env.LOKI_E10_WALL_MANIFEST = flag;
    try { await runWall(ctx, new AbortController().signal, { baseRunner: new FakeBaseTestRunner({ pass: 0, fail: 1 }) }); }
    finally { if (prev === undefined) delete process.env.LOKI_E10_WALL_MANIFEST; else process.env.LOKI_E10_WALL_MANIFEST = prev; }
    rmSync(s.repoDir, { recursive: true, force: true });
    return { listing, files, brief, sealed: events.find((e) => e.type === "wall.sealed")!.data };
  }

  test("flag on: cwd holds only task.md, repomap.txt and wall_manifest.txt", async () => {
    expect((await wall("1")).listing).toEqual(["repomap.txt", "task.md", "wall_manifest.txt"]);
  });

  test("flag on: canaries (function body, implement diff) never reach the cwd or the brief; signatures do", async () => {
    const r = await wall("1");
    const all = [r.brief, ...Object.values(r.files)].join("\n");
    expect(all).not.toContain("CANARY_BODY_7731");
    expect(all).not.toContain("CANARY_DIFF_5519");
    expect(r.files["wall_manifest.txt"]).toContain("export function search(q: string): string[]");
    expect(r.brief).toContain("wall_manifest.txt");
    expect(r.brief).not.toContain("export function search"); // A4: the brief only references the file, never embeds it
  });

  test("flag on: wall.sealed carries manifest_sha256 equal to sha256 of wall_manifest.txt", async () => {
    const r = await wall("1");
    expect(r.sealed.manifest_sha256).toBe(sha256(r.files["wall_manifest.txt"]!));
  });

  test("flag off or unset: no manifest file, no manifest_sha256, brief byte-identical to the no-manifest brief", async () => {
    for (const flag of [undefined, "0", "off"]) {
      const r = await wall(flag);
      expect(r.listing).toEqual(["repomap.txt", "task.md"]);
      expect("manifest_sha256" in r.sealed).toBe(false);
      expect(r.brief).toBe(buildWallBrief("extend search in search.ts", r.files["repomap.txt"]!, ["bun"]));
    }
  });

  test("flag on without an intake tree fails closed to the off behaviour", async () => {
    const s = setup({ runners: ["bun"], tests: [] });
    let listing: string[] = [];
    const sessions = new FakeSessionRunner((o) => { listing = readdirSync(o.cwd!).sort(); });
    const ctx = fakeCtx(s.repoDir, s.runDir, sessions, { intake: { task: "add x", testmap: s.testmap, repomap_ref: s.repomapRef } }, []);
    process.env.LOKI_E10_WALL_MANIFEST = "1";
    try { await runWall(ctx, new AbortController().signal, { baseRunner: new FakeBaseTestRunner({ pass: 0, fail: 1 }) }); }
    finally { delete process.env.LOKI_E10_WALL_MANIFEST; }
    expect(listing).toEqual(["repomap.txt", "task.md"]);
    rmSync(s.repoDir, { recursive: true, force: true });
  });
});
