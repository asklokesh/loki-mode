// FC-43: a LOKI_DONE exit with an empty diff gets exactly one correction round before verify fails it; no wording is inspected.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEvent } from "../../src/engine10/events.ts";
import { runSupervisor } from "../../src/engine10/supervisor.ts";
import { implementStage } from "../../src/engine10/stages/implement.ts";
import { EMPTY_DONE_CORRECTION } from "../../src/util/conflict_resume.ts";
import type { RunContext, SessionResult, SessionRunOptions, SessionRunner } from "../../src/engine10/types.ts";

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const done: SessionResult = { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 1, killed: false };
const already = (e: string): SessionResult => ({ exit: 0, markers: { done: false, alreadyDone: e, specConflict: null }, durationS: 1, killed: false });
const errored: SessionResult = { exit: 1, markers: { done: false, alreadyDone: null, specConflict: null }, durationS: 2, killed: false };

describe("FC-43 empty-diff done resume", () => {
  let repo: string, base: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "fc43-"));
    git(repo, ["init", "-q"]);
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, ["add", "a.txt"]);
    git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
    base = git(repo, ["rev-parse", "HEAD"]);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  class Seq implements SessionRunner {
    calls: SessionRunOptions[] = [];
    constructor(private rs: Array<SessionResult | (() => SessionResult)>) {}
    async run(o: SessionRunOptions): Promise<SessionResult> {
      this.calls.push(o);
      const r = this.rs[Math.min(this.calls.length - 1, this.rs.length - 1)]!;
      return typeof r === "function" ? r() : r;
    }
  }
  const ctxOf = (s: SessionRunner): RunContext => ({
    runId: "e10-fc43", repoDir: repo, runDir: join(repo, ".loki", "runs", "e10-fc43"), baseSha: base, branch: "b", provider: "claude", model: "m", deep: false, capS: 900,
    emit: () => {}, sessions: s,
    tests: { async detect() { return { runners: [], tests: [] }; }, impacted() { return []; } },
    cost: { read() { return { usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }; } },
    clock: { now: () => 0 }, outputs: () => ({}),
  } as unknown as RunContext);

  test("done with an empty tree resumes once with the correction", async () => {
    const s = new Seq([done, already("a.txt:1 already one")]);
    const r = await implementStage.run(ctxOf(s), new AbortController().signal);
    expect(s.calls.length).toBe(2);
    expect(s.calls[1]!.brief).toContain(EMPTY_DONE_CORRECTION);
    expect(r.status).toBe("completed");
    expect(r.data.exit).toBe("already_done");
    expect(r.data.iteration_ids).toEqual(["e10-fc43-impl", "e10-fc43-impl-e"]);
  });
  test("a resume that makes the change completes as done", async () => {
    const s = new Seq([done, () => { writeFileSync(join(repo, "a.txt"), "two\n"); return done; }]);
    const r = await implementStage.run(ctxOf(s), new AbortController().signal);
    expect(s.calls.length).toBe(2);
    expect(r.data.exit).toBe("done");
  });
  test("a persistent empty done is resumed exactly once", async () => {
    const s = new Seq([done, done, done]);
    const r = await implementStage.run(ctxOf(s), new AbortController().signal);
    expect(s.calls.length).toBe(2);
    expect(r.data.exit).toBe("done");
  });
  test("a resume that errors keeps the first result", async () => {
    const s = new Seq([done, errored]);
    const r = await implementStage.run(ctxOf(s), new AbortController().signal);
    expect(s.calls.length).toBe(2);
    expect(r.status).toBe("completed");
    expect(r.data.exit).toBe("done");
  });
  test("no resume when the tree already has a change", async () => {
    writeFileSync(join(repo, "b.txt"), "new\n");
    const s = new Seq([done]);
    await implementStage.run(ctxOf(s), new AbortController().signal);
    expect(s.calls.length).toBe(1);
  });
  test("no resume for an already_done claim", async () => {
    const s = new Seq([already("a.txt:1")]);
    await implementStage.run(ctxOf(s), new AbortController().signal);
    expect(s.calls.length).toBe(1);
  });
  test("an unreadable git tree skips the resume and never throws", async () => {
    const s = new Seq([done]);
    const c = { ...ctxOf(s), baseSha: "not-a-sha" } as RunContext;
    const r = await implementStage.run(c, new AbortController().signal);
    expect(s.calls.length).toBe(1);
    expect(r.status).toBe("completed");
  });

  test("FC-CRASH-WORK-READ-AS-PREEXISTING: already_done over crash-written files is done, never base evidence", async () => {
    writeFileSync(join(repo, "mul.js"), "x\n");
    const s = new Seq([already("mul.js:1 exists")]);
    const c = { ...ctxOf(s), outputs: () => ({ intake: { crash_written: ["mul.js"] } }) } as unknown as RunContext;
    const r = await implementStage.run(c, new AbortController().signal);
    expect(r.data.exit).toBe("done");
    expect(r.data.crash_recovered).toEqual(["mul.js"]);
    expect(r.data.already_done_evidence).toBeNull();
  });
  test("FC-RESUME-IMPLEMENT-READS-OWN-CRASH-WORK: a resumed run's already_done over files untracked since its own intake is done", async () => {
    writeFileSync(join(repo, "mul.js"), "x\n");
    const s = new Seq([already("mul.js:1 exists")]);
    const c = { ...ctxOf(s), outputs: () => ({ intake: { crash_written: [], preexisting_untracked: [] } }) } as unknown as RunContext;
    process.env.LOKI_E10_RESUME = "1";
    try {
      const r = await implementStage.run(c, new AbortController().signal);
      expect(r.data.exit).toBe("done");
      expect(r.data.crash_recovered).toEqual(["mul.js"]);
    } finally { delete process.env.LOKI_E10_RESUME; }
  });
  // The supervisor spawns the worker; the worker reads LOKI_E10_RESUME, restores the intake from the durable log, then runs the stage.
  // The stand-in below is that worker's resume path (resumeMachineOpts then implementStage) with a stub session, so the env var and the
  // restored preexisting_untracked reach the stage across a real process boundary instead of being read off supervisor.ts.
  const resumeThroughSupervisor = async (preexisting: string[]): Promise<{ exit: unknown; crash_recovered: unknown; resumeEnv: string | null }> => {
    const rid = "e10-20260101T000000Z-abcd", out = join(repo, "..", `${rid}-${Math.random().toString(36).slice(2)}.json`), script = out + ".mjs";
    writeFileSync(join(repo, "mul.js"), "x\n"); // written by the killed run, untracked
    const runDir = join(repo, ".loki", "runs", rid); mkdirSync(runDir, { recursive: true });
    const evs = ([["run.started", null, {}], ["stage.completed", "intake", { base_sha: base, task: "t", crash_written: [], preexisting_untracked: preexisting }], ["stage.completed", "plan", {}], ["stage.completed", "wall", {}]] as Array<[string, string | null, Record<string, unknown>]>)
      .map(([t, st, d], i) => makeEvent(rid, i, t, st as never, d, "2026-01-01T00:00:00.000Z"));
    writeFileSync(join(runDir, "events.jsonl"), evs.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const src = (f: string): string => JSON.stringify(join(import.meta.dir, "../../src", f));
    writeFileSync(script, `import { readFileSync, writeFileSync } from "node:fs";
import { readEvents } from ${src("engine10/events.ts")};
import { resumeMachineOpts } from ${src("util/run_outputs.ts")};
import { implementStage } from ${src("engine10/stages/implement.ts")};
const repo = ${JSON.stringify(repo)}, p = ${JSON.stringify(join(runDir, "events.jsonl"))}, resumeEnv = process.env.LOKI_E10_RESUME ?? null;
const ctx = { runId: ${JSON.stringify(rid)}, repoDir: repo, runDir: ${JSON.stringify(runDir)}, baseSha: ${JSON.stringify(base)}, branch: "b", provider: "claude", model: "m", deep: false, capS: 900, emit() {},
  sessions: { async run() { return { exit: 0, markers: { done: false, alreadyDone: "mul.js:1 exists", specConflict: null }, durationS: 1, killed: false }; } },
  tests: { async detect() { return { runners: [], tests: [] }; }, impacted() { return []; } }, cost: { read() { return { usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }; } }, clock: { now: () => 0 }, outputs: () => ({}) };
let restored = {};
if (resumeEnv === "1") { const r = resumeMachineOpts(ctx, readEvents(p), readFileSync(p, "utf8"), ["intake", "plan", "wall", "implement"]); if (r.ok) restored = r.restored; }
ctx.outputs = () => restored;
const r = await implementStage.run(ctx, new AbortController().signal);
writeFileSync(${JSON.stringify(out)}, JSON.stringify({ exit: r.data.exit, crash_recovered: r.data.crash_recovered ?? null, resumeEnv }));
`);
    try {
      await runSupervisor({ runId: rid, repoDir: repo, env: { ...process.env, LOKI_CLAUDE_CLI: "/usr/bin/true" }, capS: 600, resume: true, workerArgv: [process.execPath, script], started: {} });
      return JSON.parse(readFileSync(out, "utf8"));
    } finally { rmSync(out, { force: true }); rmSync(script, { force: true }); }
  };
  test("FC-RESUME-IMPLEMENT-READS-OWN-CRASH-WORK: through runSupervisor(resume), the worker sees LOKI_E10_RESUME and the restored intake, and a crash-written file blocks already_done", async () => {
    const r = await resumeThroughSupervisor([]);
    expect(r.resumeEnv).toBe("1");
    expect(r.exit).toBe("done");
    expect(r.crash_recovered).toEqual(["mul.js"]);
  }, 60000);
  test("through runSupervisor(resume): a file the restored intake lists as pre-existing untracked still lets already_done stand", async () => {
    const r = await resumeThroughSupervisor(["mul.js"]);
    expect(r.resumeEnv).toBe("1");
    expect(r.exit).toBe("already_done");
  }, 60000);
  test("resume positive control: a file intake recorded as pre-existing untracked still lets already_done stand", async () => {
    writeFileSync(join(repo, "mine.js"), "x\n");
    const s = new Seq([already("mine.js:1 exists")]);
    const c = { ...ctxOf(s), outputs: () => ({ intake: { crash_written: [], preexisting_untracked: ["mine.js"] } }) } as unknown as RunContext;
    process.env.LOKI_E10_RESUME = "1";
    try { expect((await implementStage.run(c, new AbortController().signal)).data.exit).toBe("already_done"); } finally { delete process.env.LOKI_E10_RESUME; }
  });
  test("a fresh run (no LOKI_E10_RESUME) is unchanged by an untracked file intake did not record", async () => {
    writeFileSync(join(repo, "mul.js"), "x\n");
    const s = new Seq([already("mul.js:1 exists")]);
    const c = { ...ctxOf(s), outputs: () => ({ intake: { crash_written: [], preexisting_untracked: [] } }) } as unknown as RunContext;
    expect((await implementStage.run(c, new AbortController().signal)).data.exit).toBe("already_done");
  });
  test("positive control: already_done with no crash-written file stays already_done", async () => {
    const s = new Seq([already("a.txt:1 already one")]);
    const r = await implementStage.run(ctxOf(s), new AbortController().signal);
    expect(r.data.exit).toBe("already_done");
    expect(r.data.already_done_evidence).toBe("a.txt:1 already one");
  });
  test("a recorded crash file that is gone does not block already_done", async () => {
    const s = new Seq([already("a.txt:1")]);
    const c = { ...ctxOf(s), outputs: () => ({ intake: { crash_written: ["gone.js"] } }) } as unknown as RunContext;
    expect((await implementStage.run(c, new AbortController().signal)).data.exit).toBe("already_done");
  });
});
