// loki-ts/tests/engine10/wall.test.ts
//
// E-15 wall check (docs/v10/ENGINE.md sections 4 and 16). Depends on
// machine.ts/intake.ts/session.ts only through the RunContext/SessionRunner
// interfaces in types.ts, so every sibling here is a fake.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
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
  function venvShim(repoDir: string): void {
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
    writeFileSync(join(repoDir, "loki_wall_thirdparty.py"), "import loki_s41_16_never_installed_xyz\n\ndef test_x():\n    pass\n", "utf8");

    const result = new RealBaseTestRunner().run(repoDir, [{ runner: "pytest", path: "loki_wall_thirdparty.py" }]);

    expect(result).toEqual({ pass: 0, fail: 0, not_run: 1 });
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("(4) pytest exit 5, no tests collected: not_run", () => {
    const repoDir = repo();
    writeFileSync(join(repoDir, "loki_wall_empty.py"), "# no test_ functions in this file\nx = 1\n", "utf8");

    const result = new RealBaseTestRunner().run(repoDir, [{ runner: "pytest", path: "loki_wall_empty.py" }]);

    expect(result).toEqual({ pass: 0, fail: 0, not_run: 1 });
    rmSync(repoDir, { recursive: true, force: true });
  });
});
