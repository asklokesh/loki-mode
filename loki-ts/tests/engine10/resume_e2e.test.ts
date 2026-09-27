// E-39 (docs/v10/ENGINE.md): interrupt and resume end to end.
//
// supervisor.ts and worker.ts have no `main()` yet -- that wiring (parsing
// `--resume <run-id>`, choosing the real stage modules, spawning the real
// session per stage) is E-42's job, in flight in a sibling worktree at the
// time this test was written. Driving the literal `loki --resume <id>` CLI
// surface is therefore not possible yet; this file instead drives the real
// primitives E-42's `main()` will sit on top of:
//   - runSupervisor (supervisor.ts): calling it twice with the SAME run id
//     reuses the same events.jsonl and engine.json, and its SIGINT handler
//     is real code today, not a stand-in.
//   - runMachine (machine.ts): `opts.prior` already skips any stage whose
//     stage.completed is in the prior events -- the resume primitive itself.
//   - session.ts's real, detached-process-group session runner, for the
//     "sleeping implement" half (fixtures/resume/sleep-provider.sh).
// Each worker process below is a small real module that plugs FAKE, instant
// stage objects into the REAL runMachine for intake/plan/wall/verify/commit/
// seal/pr, and the REAL session runner only for implement -- so intake really
// runs once (real stage.started/stage.completed events), and only implement
// blocks on a real, separately-grouped child process.
//
// Two ENGINE.md green bullets do not hold against today's real code, verified
// by running this file, not assumed:
//   - "The session process group is gone": supervisor.ts's SIGINT handler
//     (spawnWorker's onStop) SIGKILLs only the worker's OWN process group.
//     session.ts spawns its session child with its own `detached: true`
//     group (session.ts:145), one level deeper, so an external SIGINT never
//     reaches it -- the session child (and the sleeping provider under it)
//     is left running. Tracked as a `test.todo` below; not fixed here (E-39
//     has no source files, and this is exactly the class of gap E-42's
//     worker.ts `main()` needs to close by aborting the active stage before
//     the worker itself dies).
//   - "Changing the origin between runs refuses the push": runSupervisor
//     re-reads `remote.origin.url` fresh on every call and never compares it
//     with the run's first-attempt origin, so a resume against a changed
//     origin pushes anyway. Also tracked as a `test.todo`.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents } from "../../src/engine10/events.ts";
import { runSupervisor, type PrStep } from "../../src/engine10/supervisor.ts";

const ENGINE10 = join(import.meta.dir, "..", "..", "src", "engine10");
const SUPERVISOR_ABS = join(ENGINE10, "supervisor.ts");
const WORKER_ABS = join(ENGINE10, "worker.ts");
const MACHINE_ABS = join(ENGINE10, "machine.ts");
const SESSION_ABS = join(ENGINE10, "session.ts");
const EVENTS_ABS = join(ENGINE10, "events.ts");
const SLEEP_PROVIDER = join(import.meta.dir, "fixtures", "resume", "sleep-provider.sh");

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "e10-resume-"));
  roots.push(d);
  execFileSync("git", ["init", "-q", d]);
  execFileSync("git", ["-C", d, "remote", "add", "origin", "https://github.com/acme/widget.git"]);
  return d;
}

function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: process.env.HOME, ...extra };
}

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor timed out");
    await Bun.sleep(25);
  }
}

/** Kills a whole process group by pgid. Used only to reap the orphan this
 *  file's own SIGINT test.todo documents -- production has no equivalent
 *  call yet, which is exactly the gap. */
function reapGroup(pgid: number): void {
  if (!Number.isFinite(pgid) || pgid <= 0) return;
  try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ }
}

/**
 * Fake, instant stage objects for every name except `implement`, which (when
 * `hangOnImplement` is true) runs the REAL session.ts runner against the
 * sleeping provider fixture -- the one and only stage that blocks on a real,
 * separately-grouped child process. `E10_PRIOR_EVENTS`, when set, is read as
 * this attempt's `prior` (the resume primitive machine.ts already has).
 */
function workerModule(hangOnImplement: boolean): string {
  return `
import { writeFileSync } from "node:fs";
import { runWorker } from ${JSON.stringify(WORKER_ABS)};
import { runMachine } from ${JSON.stringify(MACHINE_ABS)};
import { createSessionRunner } from ${JSON.stringify(SESSION_ABS)};
import { readEvents } from ${JSON.stringify(EVENTS_ABS)};

const priorPath = process.env.E10_PRIOR_EVENTS;
const prior = priorPath ? readEvents(priorPath) : [];
const pgidFile = process.env.E10_SESSION_PGID_FILE;

function fakeStage(name, targetS, limitS, onRun) {
  return {
    name, targetS, limitS,
    async run(ctx) {
      if (onRun) await onRun(ctx);
      return { status: "completed", data: {} };
    },
  };
}

const hangOnImplement = ${JSON.stringify(hangOnImplement)};

const load = async (name) => {
  if (name === "implement" && hangOnImplement) {
    return {
      name, targetS: 180, limitS: 480,
      async run(ctx, signal) {
        const runner = createSessionRunner({
          provider: "codex",
          emit: (type, _stage, data) => {
            if (type === "session.started" && pgidFile) writeFileSync(pgidFile, String(data.pgid ?? ""));
          },
        });
        // Never resolves on its own: sleep-provider.sh only exits on a signal.
        await runner.run({
          stage: "implement", brief: "b", tier: "development",
          iterationId: "e10-resume-impl", limitS: 480, signal, cwd: ctx.repoDir,
        });
        return { status: "completed", data: {} };
      },
    };
  }
  if (name === "seal") {
    return fakeStage(name, 15, 60, (ctx) => ctx.emit("receipt.sealed", "seal", { verdict: "VERIFIED", not_proven: [] }));
  }
  if (["intake", "plan", "wall", "implement", "verify", "commit", "pr"].includes(name)) {
    return fakeStage(name, 10, 30);
  }
  return null;
};

await runWorker(async (emit) => {
  const ctx = {
    runId: "unused", repoDir: process.cwd(), runDir: ".", baseSha: "x", branch: "b",
    provider: "codex", model: "m", deep: false, capS: 900, emit,
    sessions: { run: async () => ({ exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0, killed: false }) },
    tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] },
    cost: { read: () => ({ usd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
    clock: { now: () => Date.now() },
    outputs: () => ({}),
  };
  await runMachine(ctx, { load, prior });
});
`;
}

/** Runs runSupervisor() in a spawned process, so a real SIGINT to a real
 *  top-level process is what we send -- exactly what a terminal Ctrl-C
 *  delivers to `loki` in production. */
function driverModule(): string {
  return `
import { runSupervisor } from ${JSON.stringify(SUPERVISOR_ABS)};
await runSupervisor({
  runId: process.env.E10_RUN_ID,
  repoDir: process.env.E10_REPO_DIR,
  env: process.env,
  workerArgv: [process.execPath, process.env.E10_WORKER_SCRIPT],
});
`;
}

describe("E-39 interrupt and resume", () => {
  test(
    "SIGINT during a sleeping implement exits 130 with no run.completed; " +
      "--resume then reaches seal on the same run without rerunning intake",
    async () => {
      const dir = repo();
      const runId = "e10-resume-1";
      const eventsPath = join(dir, ".loki", "runs", runId, "events.jsonl");
      const enginePath = join(dir, ".loki", "engine.json");
      const scratch = mkdtempSync(join(tmpdir(), "e10-resume-scripts-"));
      roots.push(scratch);
      const pgidFile = join(scratch, "session.pgid");

      const hangWorker = join(scratch, "hang-worker.mjs");
      writeFileSync(hangWorker, workerModule(true));
      const driver = join(scratch, "driver.mjs");
      writeFileSync(driver, driverModule());

      // --- attempt 1: interrupted mid-implement ---
      const proc = Bun.spawn({
        cmd: [process.execPath, driver],
        cwd: dir,
        env: baseEnv({
          E10_RUN_ID: runId,
          E10_REPO_DIR: dir,
          E10_WORKER_SCRIPT: hangWorker,
          E10_SESSION_PGID_FILE: pgidFile,
          LOKI_CODEX_CLI: SLEEP_PROVIDER,
        }),
        stdout: "ignore",
        stderr: "ignore",
      });

      await waitFor(() => existsSync(pgidFile), 10_000);
      // Give the fixture's exec() a beat to have actually replaced the shell.
      await Bun.sleep(150);

      proc.kill("SIGINT");
      const exitCode = await proc.exited;
      expect(exitCode).toBe(130);

      const attempt1 = readEvents(eventsPath);
      expect(attempt1.some((e) => e.type === "run.completed")).toBe(false);
      expect(attempt1.filter((e) => e.type === "stage.started" && e.stage === "intake").length).toBe(1);
      expect(attempt1.some((e) => e.type === "stage.started" && e.stage === "implement")).toBe(true);
      expect(JSON.parse(readFileSync(enginePath, "utf8")).run_id).toBe(runId);

      // Reap the orphaned session group so this test leaves nothing running
      // (see the SIGINT `test.todo` below for why it is orphaned at all).
      reapGroup(Number(readFileSync(pgidFile, "utf8").trim()));

      // --- attempt 2: resume, same run id, reaches seal ---
      const fastWorker = join(scratch, "resume-worker.mjs");
      writeFileSync(fastWorker, workerModule(false));
      let prCalls = 0;
      const prStep: PrStep = async () => {
        prCalls++;
        return { url: "https://github.com/acme/widget/pull/1", draft: false, existing: false };
      };
      const r2 = await runSupervisor({
        runId,
        repoDir: dir,
        env: baseEnv({ E10_PRIOR_EVENTS: eventsPath }),
        workerArgv: [process.execPath, fastWorker],
        pr: prStep,
      });

      expect(r2.verdict).toBe("VERIFIED");
      expect(prCalls).toBe(1);

      const combined = readEvents(eventsPath);
      expect(combined.filter((e) => e.type === "stage.started" && e.stage === "intake").length).toBe(1);
      expect(combined.filter((e) => e.type === "run.started").length).toBe(2); // one per attempt
      expect(combined.filter((e) => e.type === "run.completed").length).toBe(1);
      expect(combined.some((e) => e.type === "receipt.sealed")).toBe(true);
      // seq is strictly increasing across both attempts: attempt 2 continues
      // the same file, it never restarts it.
      const seqs = combined.map((e) => e.seq);
      expect(seqs).toEqual(seqs.map((_, i) => i));
      expect(JSON.parse(readFileSync(enginePath, "utf8")).run_id).toBe(runId);
    },
    30_000,
  );

  test(
    "a changed origin between the interrupted attempt and the resume is not currently refused",
    async () => {
      const dir = repo();
      const runId = "e10-resume-origin";
      const eventsPath = join(dir, ".loki", "runs", runId, "events.jsonl");
      const scratch = mkdtempSync(join(tmpdir(), "e10-resume-origin-"));
      roots.push(scratch);
      const pgidFile = join(scratch, "session.pgid");
      const hangWorker = join(scratch, "hang-worker.mjs");
      writeFileSync(hangWorker, workerModule(true));
      const driver = join(scratch, "driver.mjs");
      writeFileSync(driver, driverModule());

      const proc = Bun.spawn({
        cmd: [process.execPath, driver],
        cwd: dir,
        env: baseEnv({
          E10_RUN_ID: runId,
          E10_REPO_DIR: dir,
          E10_WORKER_SCRIPT: hangWorker,
          E10_SESSION_PGID_FILE: pgidFile,
          LOKI_CODEX_CLI: SLEEP_PROVIDER,
        }),
        stdout: "ignore",
        stderr: "ignore",
      });
      await waitFor(() => existsSync(pgidFile), 10_000);
      await Bun.sleep(150);
      proc.kill("SIGINT");
      expect(await proc.exited).toBe(130);
      reapGroup(Number(readFileSync(pgidFile, "utf8").trim()));

      execFileSync("git", ["-C", dir, "remote", "set-url", "origin", "https://github.com/acme/OTHER.git"]);

      const fastWorker = join(scratch, "resume-worker.mjs");
      writeFileSync(fastWorker, workerModule(false));
      const calls: string[] = [];
      const prStep: PrStep = async ({ pushEnv }) => {
        calls.push(pushEnv._LOKI_PINNED_ORIGIN);
        return { url: "https://github.com/acme/OTHER/pull/1", draft: false, existing: false };
      };
      const r2 = await runSupervisor({
        runId, repoDir: dir, env: baseEnv({ E10_PRIOR_EVENTS: eventsPath }),
        workerArgv: [process.execPath, fastWorker], pr: prStep,
      });

      // Documents today's real behavior: the resume pushes to the CHANGED
      // origin. ENGINE.md's green bullet wants this refused; see the
      // `test.todo` below.
      expect(r2.verdict).toBe("VERIFIED");
      expect(calls).toEqual(["https://github.com/acme/OTHER.git"]);
      const first = readEvents(eventsPath)[0]!;
      expect(first.data.origin_repo).toBe("acme/widget");
    },
    30_000,
  );

  // Tracked gaps, verified against real code while writing this file (see the
  // header comment for how each was reproduced). Neither is fixed here: E-39
  // carries no source files, and both belong to whichever slice next touches
  // supervisor.ts (most likely E-42, which is already wiring worker.ts's
  // main() and its signal handling).
  test.todo(
    "SIGINT also kills the session child's own process group (currently orphaned: " +
      "supervisor.ts's onStop only SIGKILLs the worker's group, one level above session.ts's own detached group)",
    () => {},
  );
  test.todo(
    "a resume whose origin changed since the interrupted attempt refuses the push " +
      "(currently unenforced: runSupervisor never compares origin_repo across attempts of the same run id)",
    () => {},
  );
});
