// MW-2 / CH-03: LOKI_E10_FIX_RESUME (default off; =1 opts in; CH-03 flips the default after RECEIPT-TRUTH). A fix round resumes the implement session; every failure path
// starts fresh and records why. Mocked sessions only: no real model, no query().
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixStage } from "../../src/engine10/stages/fix.ts";
import { createSessionRunner } from "../../src/engine10/session.ts";
import type { FailureGroup } from "../../src/engine10/failures.ts";
import type { RunContext, SessionResult, SessionRunOptions, SessionRunner, StageName } from "../../src/engine10/types.ts";

const groups: FailureGroup[] = [{ signature: "AssertionError: x", count: 1, sample: "expected 1 to equal 2" }];
const ok: SessionResult = { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 1, killed: false };
let repo: string;
let envBackup: Record<string, string | undefined>;
const KEYS = ["LOKI_E10_FIX_RESUME", "LOKI_E10_INVOKER", "LOKI_E10_RESUME_SESSION"];

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "loki-fixresume-"));
  envBackup = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  for (const k of KEYS) { if (envBackup[k] === undefined) delete process.env[k]; else process.env[k] = envBackup[k]; }
});

function writeId(iter: string, id: string): void {
  mkdirSync(join(repo, ".loki"), { recursive: true });
  writeFileSync(join(repo, ".loki", `e10-session-${iter}.json`), JSON.stringify({ session_id: id }));
}

class Fake implements SessionRunner {
  calls: SessionRunOptions[] = [];
  constructor(private script: (o: SessionRunOptions, n: number) => SessionResult & { stderrTail?: string }) {}
  async run(o: SessionRunOptions): Promise<SessionResult> { this.calls.push(o); return this.script(o, this.calls.length); }
}

function ctxFor(sessions: SessionRunner, outputs: Partial<Record<StageName, Record<string, unknown>>>, model = "sonnet", provider = "claude"): RunContext {
  return {
    runId: "r1", repoDir: repo, runDir: join(repo, ".loki/runs/r1"), baseSha: "x", branch: "b", provider, model, deep: false, capS: 900,
    emit: () => {}, sessions,
    tests: { async detect() { return { runners: [], tests: [] }; }, impacted() { return []; } },
    cost: { read: (_r, ids) => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: ids.some((i) => i.endsWith("f")) ? 7 : 123 }) },
    clock: { now: () => 0 }, outputs: () => outputs,
  };
}
const impl = { model: "sonnet", session_id: "sess-impl" };
const run = (c: RunContext) => fixStage.run(c, new AbortController().signal);

describe("fix resume (MW-2)", () => {
  test("flag unset reproduces the old behaviour: one fresh session, full brief, no resume option", async () => {
    const s = new Fake(() => ok);
    const r = await run(ctxFor(s, { intake: { task: "do it" }, verify: { failures_grouped: groups }, implement: impl }));
    expect(s.calls).toHaveLength(1);
    expect("resumeSessionId" in s.calls[0]!).toBe(false);
    expect(s.calls[0]!.brief).toContain("do it");
    expect(s.calls[0]!.iterationId).toBe("r1-fix1");
    expect(r.data.fix_resume).toBe("fresh");
    expect(r.data.iteration_ids).toEqual(["r1-fix1"]);
  });

  test("flag on passes resume with the captured implement session id and sends only the failure turn", async () => {
    process.env["LOKI_E10_FIX_RESUME"] = "1";
    const s = new Fake(() => { writeId("r1-fix1", "sess-fix1"); return ok; });
    const r = await run(ctxFor(s, { intake: { task: "do it" }, verify: { failures_grouped: groups }, implement: impl }));
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.resumeSessionId).toBe("sess-impl");
    expect(s.calls[0]!.brief).toContain("expected 1 to equal 2");
    expect(s.calls[0]!.brief).not.toContain("do it");
    expect(r.data.fix_resume).toBe("resumed");
    expect(r.data.session_id).toBe("sess-fix1");
    expect(r.data.fix_rounds).toEqual([{ round: 1, fix_resume: "resumed", cache_read_tokens: 123 }]);
  });

  test("round 2 resumes the latest session of the chain", async () => {
    process.env["LOKI_E10_FIX_RESUME"] = "1";
    const s = new Fake(() => ok);
    await run(ctxFor(s, { verify: { failures_grouped: groups }, implement: impl, fix: { round: 1, session_id: "sess-fix1", model: "sonnet", signatures: "other" } }));
    expect(s.calls[0]!.resumeSessionId).toBe("sess-fix1");
  });

  test("a resume error falls back to a fresh session and records the reason", async () => {
    process.env["LOKI_E10_FIX_RESUME"] = "1";
    const s = new Fake((o) => (o.resumeSessionId ? { ...ok, exit: 1, stderrTail: "[sdk-loop error: No conversation found with session ID sess-impl]" } : ok));
    const r = await run(ctxFor(s, { intake: { task: "do it" }, verify: { failures_grouped: groups }, implement: impl }));
    expect(s.calls).toHaveLength(2);
    expect(s.calls[1]!.resumeSessionId).toBeUndefined();
    expect(s.calls[1]!.brief).toContain("do it");
    expect(s.calls[1]!.iterationId).toBe("r1-fix1f");
    expect(r.status).toBe("completed");
    expect(r.data.fix_resume).toBe("fallback (No conversation found with session ID sess-impl)");
    expect(r.data.iteration_ids).toEqual(["r1-fix1", "r1-fix1f"]);
    expect((r.data.fix_rounds as { cache_read_tokens: number }[])[0]!.cache_read_tokens).toBe(7);
  });

  test("a timeout kill is not retried (never stalls the run)", async () => {
    process.env["LOKI_E10_FIX_RESUME"] = "1";
    const s = new Fake(() => ({ ...ok, exit: null, killed: true }));
    const r = await run(ctxFor(s, { verify: { failures_grouped: groups }, implement: impl }));
    expect(s.calls).toHaveLength(1);
    expect(r.data.killed).toBe(true);
  });

  test("fallback when there is no session id, a non-claude provider, or the CLI invoker", async () => {
    process.env["LOKI_E10_FIX_RESUME"] = "1";
    let s = new Fake(() => ok);
    let r = await run(ctxFor(s, { verify: { failures_grouped: groups }, implement: {} }));
    expect(r.data.fix_resume).toBe("fallback (no session id recorded)");
    expect(s.calls[0]!.resumeSessionId).toBeUndefined();
    s = new Fake(() => ok);
    r = await run(ctxFor(s, { verify: { failures_grouped: groups }, implement: impl }, "sonnet", "codex"));
    expect(r.data.fix_resume).toBe("fallback (provider is not the SDK)");
    process.env["LOKI_E10_INVOKER"] = "cli";
    s = new Fake(() => ok);
    r = await run(ctxFor(s, { verify: { failures_grouped: groups }, implement: impl }));
    expect(r.data.fix_resume).toBe("fallback (provider is not the SDK)");
    expect(s.calls[0]!.resumeSessionId).toBeUndefined();
  });

  test("escalation to a different model starts fresh and records why (L1)", async () => {
    process.env["LOKI_E10_FIX_RESUME"] = "1";
    const s = new Fake(() => ok);
    const r = await run(ctxFor(s, { verify: { failures_grouped: groups }, implement: impl, fix: { round: 1, signatures: "AssertionError: x", model: "sonnet", session_id: "sess-fix1" } }, "sonnet"));
    expect(s.calls[0]!.model).toBeDefined(); // escalated pin
    expect(s.calls[0]!.resumeSessionId).toBeUndefined();
    expect(r.data.fix_resume).toBe("fresh");
    expect(String(r.data.fix_resume_why)).toContain("model changed sonnet ->");
  });

  test("the session runner exports the resume id to the child only when asked", async () => {
    const runner = createSessionRunner({ provider: "claude", childCommand: ["sh", ["-c", "echo R=$LOKI_E10_RESUME_SESSION"]] });
    const base = { stage: "fix" as const, brief: "b", tier: "development" as const, iterationId: "i", limitS: 10, signal: new AbortController().signal, cwd: repo };
    process.env["LOKI_E10_RESUME_SESSION"] = "leaked";
    expect((await runner.run({ ...base, resumeSessionId: "abc" })).summary).toContain("R=abc");
    const plain = (await runner.run(base)).summary ?? "";
    expect(plain).toContain("R=");
    expect(plain).not.toContain("leaked");
  });
});

describe("fix resume trust and mutation (MW-2)", () => {
  const SRC = join(import.meta.dir, "..", "..", "src");
  test("seal reads only the engine-recorded fix_rounds, never a session id, transcript or resume module", () => {
    const seal = readFileSync(join(SRC, "engine10/stages/seal.ts"), "utf8");
    expect(seal).not.toMatch(/session_resume|e10-session|resumeSessionId|LOKI_E10_RESUME_SESSION|LOKI_E10_FIX_RESUME/);
    const fixRefs = [...seal.matchAll(/\bo\.fix\??\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(fixRefs)).toEqual(new Set(["fix_rounds"]));
    for (const f of ["verify.ts", "wall.ts"]) expect(readFileSync(join(SRC, "engine10/stages", f), "utf8")).not.toMatch(/session_resume|e10-session/);
  });

  test("mutation: dropping the resume option from runFixSession turns the resume assertion red", async () => {
    const orig = readFileSync(join(SRC, "runner/session_resume.ts"), "utf8");
    const mutated = orig.replace(/, \.\.\.\(resumeId \? \{ resumeSessionId: resumeId \} : \{\}\)/, "");
    expect(mutated).not.toBe(orig);
    const dir = mkdtempSync(join(tmpdir(), "loki-fixresume-mut-"));
    try {
      const file = join(dir, "mut.ts");
      writeFileSync(file, mutated.replace(/from "\.\.\/engine10\//g, `from "${join(SRC, "engine10")}/`).replace(/from "\.\.\/util\//g, `from "${join(SRC, "util")}/`));
      const mod = await import(file);
      process.env["LOKI_E10_FIX_RESUME"] = "1";
      const s = new Fake(() => ok);
      await mod.runFixSession(ctxFor(s, {}), { stage: "fix", tier: "development", limitS: 1, signal: new AbortController().signal }, "r1-fix1", [], { sessionId: "sess-impl", model: "sonnet" }, "sonnet", "full", "resume");
      // The real test asserts resumeSessionId === "sess-impl"; under the mutation it is undefined, so that assertion goes red.
      expect(s.calls[0]!.resumeSessionId).toBeUndefined();
      expect(s.calls[0]!.resumeSessionId).not.toBe("sess-impl");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// P12-07: per-stage checkpoints and resume-from-stage. Resume fails closed on any torn or inconsistent log.
import { execFileSync } from "node:child_process";
import { makeEvent, readEvents } from "../../src/engine10/events.ts";
import { DEEP_CAP_S, DEFAULT_CAP_S } from "../../src/engine10/types.ts";
import { workerCapS } from "../../src/engine10/worker.ts";
import { firstIncompleteStage, resumeFlag, resumeMachineOpts, resumePoint, seedResumeCtx, stageCheckpoints } from "../../src/util/run_outputs.ts";
import { applyCapEnv, runSupervisor, SupervisorLog } from "../../src/engine10/supervisor.ts";
import { readAliveBeat, writeAliveBeat } from "../../src/util/run_pid.ts";
import { verdictOf } from "../../src/engine10/stages/seal.ts";
import { staleWallRevisions } from "../../src/util/steer.ts";
import { composeHandoff, renderHandoff } from "../../src/util/run_summary.ts";
import { FLOW, runMachine } from "../../src/engine10/machine.ts";
import type { Stage } from "../../src/engine10/types.ts";

const fakeCtx = (): { ctx: RunContext; events: { type: string; stage: StageName | null }[] } => {
  const events: { type: string; stage: StageName | null }[] = [];
  const ctx: RunContext = {
    runId: RID, repoDir: "/nonexistent", runDir: "/nonexistent/run", baseSha: "abc", branch: `loki/${RID}`, provider: "claude", model: "fake", deep: false, capS: 900,
    emit: (type, stage) => { events.push({ type, stage }); },
    sessions: { run: async () => { throw new Error("no sessions"); } },
    tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] },
    cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
    clock: { now: () => Date.now() }, outputs: () => ({}),
  };
  return { ctx, events };
};

const RID = "e10-20260101T000000Z-abcd";
type Spec = [string, string | null, Record<string, unknown>?];
const mk = (spec: Spec[]) => spec.map(([t, s, d], i) => makeEvent(RID, i, t, s as never, d ?? {}, "2026-01-01T00:00:00.000Z"));
const killedAfterImplement = () => mk([
  ["run.started", null], ["stage.completed", "intake", { base_sha: "abc", task: "t" }], ["stage.completed", "plan"], ["stage.completed", "wall"], ["stage.completed", "implement"],
]);
const text = (evs: ReturnType<typeof mk>): string => evs.map((e) => JSON.stringify(e)).join("\n") + "\n";

describe("resume from stage (P12-07)", () => {
  const rev = { rev: 1, source: "chat", actor: "a", sha: "s", at: 2000 };
  const withSteer = (): ReturnType<typeof mk> => mk([
    ["run.started", null], ["stage.completed", "intake", { base_sha: "abc", task: "t" }], ["stage.started", "wall", { start_ms: 1000 }], ["stage.completed", "plan"], ["stage.completed", "wall"],
    ["intent.revised", "implement", { revisions: [rev] }], ["stage.completed", "implement"],
  ]);
  test("P12-07d: a revision applied before the interrupt is still in ctx after resume", () => {
    const r = resumePoint(withSteer());
    expect(r.ok && r.intentRevisions).toEqual([rev]);
  });
  test("P12-07d: the restored state marks a post-freeze steer stale (parse only; re-entry is P12-07h)", () => {
    const r = resumePoint(withSteer());
    if (!r.ok) throw new Error(r.reason);
    expect(staleWallRevisions(r.intentRevisions, r.timeline).map((x) => x.rev)).toEqual([1]);
  });
  const forge = (body: (log: SupervisorLog, t: number) => void): ReturnType<typeof resumePoint> => {
    const dir = mkdtempSync(join(tmpdir(), "loki-forge-")), log = new SupervisorLog(join(dir, "events.jsonl"), RID), j = (type: string, stage: string, data: object) => JSON.stringify({ type, stage, data });
    try {
      log.append("run.started", null, {}); log.append("stage.completed", "intake", { base_sha: "abc", task: "t" });
      body(log, Date.now());
      for (const s of ["plan", "wall", "implement"]) log.ingest(j("stage.completed", s, {}));
      return resumePoint(readEvents(join(dir, "events.jsonl")));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  const j2 = (type: string, stage: string, data: object) => JSON.stringify({ type, stage, data });
  test("P12-07h: a forged late Wall start cannot make a late revision read on time (earliest start, capped at append time)", () => {
    const r = forge((log, t) => {
      log.ingest(j2("stage.started", "wall", { start_ms: t - 10000 }));
      log.ingest(j2("intent.revised", "implement", { revisions: [{ rev: 1, source: "chat", actor: "a", sha: "s", at: t - 5000 }] }));
      log.ingest(j2("stage.started", "wall", { start_ms: Date.now() }));
    });
    if (!r.ok) throw new Error(r.reason);
    expect(r.timeline.length).toBe(1);
    expect(staleWallRevisions(r.intentRevisions, r.timeline).map((x) => x.rev)).toEqual([1]);
  });
  test("P12-07h: a Wall start claimed before its own append time is capped at the append time", () => {
    const evs = mk([["run.started", null], ["stage.completed", "intake", { base_sha: "abc" }], ["stage.started", "wall", { start_ms: Date.parse("2026-01-01T00:00:00.000Z") + 99999 }], ["stage.completed", "plan"], ["stage.completed", "wall"]]);
    const r = resumePoint(evs);
    expect(r.ok && r.timeline[0]!.startMs).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
  });
  test("P12-07h: a pre-claimed rev (at:0) cannot displace the honest revision", () => {
    const r = forge((log, t) => {
      log.ingest(j2("stage.started", "wall", { start_ms: t - 10000 }));
      log.ingest(j2("intent.revised", "plan", { revisions: [{ rev: 1, at: 0 }] }));
      log.ingest(j2("intent.revised", "implement", { revisions: [{ rev: 1, source: "chat", actor: "a", sha: "s", at: t - 5000 }] }));
    });
    if (!r.ok) throw new Error(r.reason);
    expect(r.intentRevisions.map((x) => x.sha)).toEqual(["s"]);
    expect(staleWallRevisions(r.intentRevisions, r.timeline).map((x) => x.rev)).toEqual([1]);
  });
  test("P12-07h: seedResumeCtx seeds ctx.intentRevisions and ctx.timeline from the resume point", () => {
    const r = resumePoint(withSteer());
    if (!r.ok) throw new Error(r.reason);
    const ctx: { intentRevisions?: typeof rev[]; timeline?: { stage: "wall"; startMs: number; endMs: number }[] } = {};
    seedResumeCtx(ctx, r);
    expect(ctx.intentRevisions).toEqual([rev]);
    expect(ctx.timeline).toEqual([{ stage: "wall", startMs: 1000, endMs: 1000 }]);
  });
  test("P12-07d: a later empty intent.revised cannot clear an honest revision (union)", () => {
    const evs = mk([...withSteer().map((e): Spec => [e.type, e.stage, e.data]), ["intent.revised", "verify", { revisions: [] }], ["stage.completed", "verify"]]);
    const r = resumePoint(evs);
    expect(r.ok && r.intentRevisions.map((x) => x.rev)).toEqual([1]);
  });
  test("P12-07d: a malformed revision is skipped; a wall start without start_ms fails closed (every revision stale)", () => {
    const evs = mk([["run.started", null], ["stage.completed", "intake", { base_sha: "abc" }], ["stage.started", "wall", {}], ["intent.revised", "plan", { revisions: [rev, { rev: "x" }, null] }], ["stage.completed", "plan"], ["stage.completed", "wall"]]);
    const r = resumePoint(evs);
    if (!r.ok) throw new Error(r.reason);
    expect(r.intentRevisions).toEqual([rev]);
    expect(staleWallRevisions(r.intentRevisions, r.timeline).map((x) => x.rev)).toEqual([1]);
  });
  test("P12-07d: SupervisorLog.ingest drops a forged far-future start_ms and a malformed intent.revised", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-forge-")), log = new SupervisorLog(join(dir, "events.jsonl"), RID);
    try {
      expect(log.ingest(JSON.stringify({ type: "stage.started", stage: "wall", data: { start_ms: 9e15 } }))).toBeNull();
      expect(log.ingest(JSON.stringify({ type: "intent.revised", stage: "plan", data: { revisions: [{ rev: "x" }] } }))).toBeNull();
      expect(log.ingest(JSON.stringify({ type: "intent.revised", stage: "plan", data: { revisions: [rev] } }))).not.toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("P12-07d: an older log without the new fields resumes clean and empty", () => {
    const r = resumePoint(killedAfterImplement());
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.intentRevisions).toEqual([]); expect(r.timeline).toEqual([]); }
  });
  test("kill after implement: resume skips intake, plan and wall and re-enters at verify", () => {
    const evs = killedAfterImplement();
    const r = resumePoint(evs, text(evs));
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.stage).toBe("verify"); expect(r.skip).toEqual(["intake", "plan", "wall", "implement"]); expect(r.checkpoints.map((c) => c.stage)).toEqual(["intake", "plan", "wall", "implement"]); }
  });
  test("checkpoints are deterministic and chain inputs to prior outputs", () => {
    const a = stageCheckpoints(killedAfterImplement()), b = stageCheckpoints(killedAfterImplement());
    expect(a).toEqual(b);
    expect(a[1]!.inputs_sha).not.toBe(a[0]!.inputs_sha);
  });
  test("torn mid-log line refuses", () => {
    const evs = killedAfterImplement(), lines = text(evs).split("\n");
    lines[2] = lines[2]!.slice(0, 20);
    expect(resumePoint(evs.filter((_, i) => i !== 2), lines.join("\n")).ok).toBe(false);
  });
  test("torn last line, seq gap, finished run, out-of-order stage, empty log all refuse", () => {
    const evs = killedAfterImplement();
    expect(resumePoint(evs, text(evs).trimEnd()).ok).toBe(false);
    expect(resumePoint(evs.map((e, i) => (i === 4 ? { ...e, seq: 9 } : e))).ok).toBe(false);
    expect(resumePoint([...evs, makeEvent(RID, evs.length, "run.completed", null, {})]).ok).toBe(false);
    expect(resumePoint(evs.filter((e) => e.stage !== "plan").map((e, i) => ({ ...e, seq: i }))).ok).toBe(false);
    expect(resumePoint([]).ok).toBe(false);
  });
  test("handoff names the stage a stopped run never settled", () => {
    const evs = killedAfterImplement();
    const h = (outcome: string): string => renderHandoff(composeHandoff({ repoDir: tmpdir(), runId: RID, events: evs, outcome, usd: null, elapsedS: null, notProven: [] }));
    expect(firstIncompleteStage(evs)).toBe("verify");
    expect(h("BUDGET_STOP")).toContain("Stopped before stage verify completed");
    expect(h("VERIFIED")).not.toContain("Stopped before stage");
  });
  test("resumeFlag: torn log exits 2 and never resumes; intact pre-publish log re-enters under the supervisor (P12-07i)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-p1207-"));
    const cwd = process.cwd();
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "i"], { cwd: dir });
      execFileSync("git", ["branch", `loki/${RID}`], { cwd: dir });
      mkdirSync(join(dir, ".loki", "runs", RID), { recursive: true });
      const p = join(dir, ".loki", "runs", RID, "events.jsonl");
      const evs = killedAfterImplement();
      const say: string[] = [], out = (s: string): void => { say.push(s); }, seen: { resume?: boolean; workerArgv: string[] }[] = [];
      const supervise = async (o: { resume?: boolean; workerArgv: string[] }): Promise<{ outcome: "VERIFIED" }> => { seen.push(o); return { outcome: "VERIFIED" }; };
      process.chdir(dir);
      writeFileSync(p, text(evs));
      expect(await resumeFlag(RID, true, { out, supervise: supervise as never })).toBe(0);
      expect(say.join("")).toContain("resume from stage verify");
      expect(seen.length).toBe(1);
      expect(seen[0]!.resume).toBe(true);
      expect(seen[0]!.workerArgv.slice(-5, -2)).toEqual(["worker", RID, "claude"]);
      expect(execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: dir, encoding: "utf8" }).trim()).toBe(`loki/${RID}`);
      writeFileSync(p, text(evs) + '{"v":1,"seq":5,"ty');
      say.length = 0;
      expect(await resumeFlag(RID, false, { out, supervise: supervise as never })).toBe(4);
      expect(say.join("")).toContain(`resume: run ${RID} cannot be resumed (its event log is torn`);
      expect(seen.length).toBe(1);
    } finally { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); }
  });
  test("P12-07i: resumeMachineOpts seeds ctx, runMachine runs only unsettled stages and later stages see restored outputs", async () => {
    const { ctx, events } = fakeCtx();
    const evs = withSteer();
    const ran: string[] = [];
    let seenIntake: unknown;
    const st = (n: StageName): Stage => ({ name: n, targetS: 1, limitS: 5, run: async (c) => { ran.push(n); if (n === "verify") seenIntake = c.outputs().intake?.["base_sha"]; return { status: "completed", data: {} }; } });
    const r = resumeMachineOpts(ctx as never, evs, text(evs), FLOW);
    if (!r.ok) throw new Error(r.reason);
    expect(ctx.intentRevisions).toEqual([rev]);
    expect(ctx.timeline?.[0]).toEqual({ stage: "wall", startMs: 1000, endMs: 1000 });
    await runMachine(ctx, { flow: r.flow as typeof FLOW, restored: r.restored as never, load: async (n) => st(n) });
    expect(ran).toEqual(["verify", "commit", "seal", "pr"]);
    expect(seenIntake).toBe("abc");
    expect(events.filter((e) => e.type === "stage.completed").map((e) => e.stage)).toEqual(["verify", "commit", "seal", "pr"]);
  });
  const satLog = (extra: Spec[]) => mk([["run.started", null], ["stage.completed", "intake", { base_sha: "abc", task: "t", already_satisfied: false }], ["stage.completed", "plan"], ["stage.completed", "wall"], ...extra, ["stage.completed", "implement"]]);
  const restoreIntake = (evs: ReturnType<typeof mk>): Record<string, unknown> | undefined => {
    const { ctx } = fakeCtx(); const r = resumeMachineOpts(ctx as never, evs, text(evs), FLOW);
    if (!r.ok) throw new Error(r.reason);
    return r.restored["intake"] as Record<string, unknown> | undefined;
  };
  const att = (data: Record<string, unknown> = { already_satisfied: true, evidence: ["src/a.ts has it"] }): Spec => ["already.attested", "intake", data];
  test("P12-07j (D61-04): a supervisor-attested deferred hit survives resume", () => {
    const d = restoreIntake(satLog([att()]));
    expect(d?.["already_satisfied"]).toBe(true);
    expect(d?.["evidence"]).toEqual(["src/a.ts has it"]);
    expect(d?.["base_sha"]).toBe("abc");
  });
  test("P12-07j: an old log without the event restores exactly as before (not satisfied)", () => {
    expect(restoreIntake(satLog([]))).toEqual({ base_sha: "abc", task: "t", already_satisfied: false });
  });
  test("P12-07j: a worker-written already.satisfied (unattested) is never restored", () => {
    expect(restoreIntake(satLog([["already.satisfied", "intake", { already_satisfied: true, evidence: ["x"], deferred: true }]]))?.["already_satisfied"]).toBe(false);
  });
  test("P12-07j: a malformed attested event is ignored (fail safe)", () => {
    for (const data of [{ evidence: ["x"] }, { already_satisfied: true }, { already_satisfied: true, evidence: [] }, { already_satisfied: true, evidence: [1] }, { already_satisfied: "true", evidence: ["x"] }])
      expect(restoreIntake(satLog([att(data)]))?.["already_satisfied"]).toBe(false);
  });
  test("P12-07j: an intent.revised after the hit drops the flag; one before it does not", () => {
    const r = { revisions: [rev] };
    expect(restoreIntake(satLog([att(), ["intent.revised", "implement", r]]))?.["already_satisfied"]).toBe(false);
    expect(restoreIntake(satLog([["intent.revised", "plan", r], att()]))?.["already_satisfied"]).toBe(true);
  });
  test("P12-07j: an attested event after implement settled is not restored", () => {
    const evs = mk([["run.started", null], ["stage.completed", "intake", { base_sha: "abc" }], ["stage.completed", "plan"], ["stage.completed", "wall"], ["stage.completed", "implement"], att()]);
    expect(restoreIntake(evs)?.["already_satisfied"]).toBeUndefined();
  });
  test("P12-07j: SupervisorLog.ingest drops a worker-written already.attested and attests only an in-flight well-formed deferred hit", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-forge-")), log = new SupervisorLog(join(dir, "events.jsonl"), RID), j = (type: string, stage: string, data: object) => JSON.stringify({ type, stage, data });
    const hit = { already_satisfied: true, evidence: ["src/a.ts has it"], deferred: true };
    try {
      expect(log.ingest(j("already.attested", "intake", { already_satisfied: true, evidence: ["x"] }))).toBeNull();
      log.ingest(j("already.satisfied", "intake", hit)); // implement not in flight
      log.ingest(j("stage.started", "implement", {}));
      log.ingest(j("already.satisfied", "intake", { ...hit, evidence: [] }));
      log.ingest(j("already.satisfied", "intake", { ...hit, deferred: false }));
      expect(readEvents(log.path).some((e) => e.type === "already.attested")).toBe(false);
      log.ingest(j("already.satisfied", "intake", hit));
      expect(readEvents(log.path).filter((e) => e.type === "already.attested").length).toBe(1);
      log.ingest(j("stage.completed", "implement", {}));
      log.ingest(j("already.satisfied", "intake", hit));
      expect(readEvents(log.path).filter((e) => e.type === "already.attested").length).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("P12-07j: a restored flag can never seal VERIFIED (verdictOf)", () => {
    const o = { intake: restoreIntake(satLog([att()])), implement: { exit: "done" } } as never;
    expect(verdictOf(o, [], false, false, false, true)).toBe("ALREADY_SATISFIED");
    expect(verdictOf(o, [], false, false, false, false)).toBe("PARTIAL");
  });
  const noPr = FLOW.filter((s) => s !== "pr");
  const rerun = async (evs: ReturnType<typeof mk>): Promise<{ ran: string[]; sealSaw: unknown }> => {
    const { ctx } = fakeCtx();
    const r = resumeMachineOpts(ctx as never, evs, text(evs), noPr);
    if (!r.ok) throw new Error(r.reason);
    const ran: string[] = []; let sealSaw: unknown;
    await runMachine(ctx, { flow: r.flow as typeof FLOW, restored: r.restored as never, load: async (n) => ({ name: n, targetS: 1, limitS: 5, run: async (c) => { ran.push(n); if (n === "seal") sealSaw = c.outputs().verify; return { status: "completed", data: {} }; } }) as Stage });
    return { ran, sealSaw };
  };
  const base5: Spec[] = [["run.started", null], ["stage.completed", "intake", { base_sha: "abc", task: "t" }], ["stage.completed", "plan"], ["stage.completed", "wall"], ["stage.completed", "implement"]];
  test("P12-07i review R1: a settled verify is never restored; the tree is re-verified before commit and seal", async () => {
    const r = await rerun(mk([...base5, ["stage.completed", "verify", { checks: [{ name: "t", result: "pass" }] }], ["stage.started", "commit"]]));
    expect(r.ran).toEqual(["verify", "commit", "seal", ]);
    expect((r.sealSaw as Record<string, unknown>)["checks"]).toBeUndefined();
  });
  test("P12-07i review R1b: interrupted mid fix-loop re-enters at verify, not past it", async () => {
    const r = await rerun(mk([...base5, ["stage.completed", "verify", { failures_grouped: [{ signature: "x" }] }], ["stage.completed", "fix"], ["stage.started", "verify"]]));
    expect(r.ran[0]).toBe("verify");
    expect(r.ran).toEqual(["verify", "commit", "seal"]);
  });
  const gitRepo = (dir: string) => (...a: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, encoding: "utf8" });
  test("P12-07i review R3: dirty user work blocks the resume checkout; the user's branch is handed to the supervisor to restore", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-r3-")), cwd = process.cwd();
    try {
      const g = gitRepo(dir);
      g("init", "-q", "-b", "main"); writeFileSync(join(dir, "a.txt"), "1\n"); g("add", "a.txt"); g("commit", "-q", "-m", "i"); g("branch", `loki/${RID}`);
      mkdirSync(join(dir, ".loki", "runs", RID), { recursive: true });
      writeFileSync(join(dir, ".loki", "runs", RID, "events.jsonl"), text(mk(base5)));
      writeFileSync(join(dir, "a.txt"), "WIP\n"); writeFileSync(join(dir, "secret.env"), "T=x\n");
      process.chdir(dir);
      const say: string[] = [], seen: { restoreBranch?: string | null }[] = [], supervise = (async (o: never) => { seen.push(o); return { outcome: "VERIFIED" }; }) as never;
      expect(await resumeFlag(RID, true, { out: (x) => { say.push(x); }, supervise })).toBe(2);
      expect(say.join("")).toContain("2 uncommitted");
      expect(g("symbolic-ref", "--short", "HEAD").trim()).toBe("main");
      expect(seen.length).toBe(0);
      g("checkout", "-q", "--", "a.txt"); rmSync(join(dir, "secret.env"));
      expect(await resumeFlag(RID, true, { out: () => {}, supervise })).toBe(0);
      expect(seen[0]!.restoreBranch).toBe("main");
    } finally { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); }
  });
  describe("exit 4 only for a measured property of the run (cw17b)", () => {
    const git = (dir: string) => (...a: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, encoding: "utf8" });
    const setup = (events: (sha: string) => Spec[], opts: { branch?: boolean } = {}): { dir: string; g: ReturnType<typeof git>; ev: string } => {
      const dir = mkdtempSync(join(tmpdir(), "loki-cw17b-")), g = git(dir);
      g("init", "-q", "-b", "main"); g("commit", "-q", "--allow-empty", "-m", "i");
      const sha = g("rev-parse", "HEAD").trim();
      if (opts.branch !== false) g("branch", `loki/${RID}`);
      mkdirSync(join(dir, ".loki", "runs", RID), { recursive: true });
      const ev = join(dir, ".loki", "runs", RID, "events.jsonl");
      writeFileSync(ev, text(mk(events(sha))));
      return { dir, g, ev };
    };
    const full = (sha: string, started: Record<string, unknown> = {}): Spec[] => [["run.started", null, { provider: "claude", model: "m", ...started }], ["stage.completed", "intake", { base_sha: sha, task: "t" }], ["stage.completed", "plan"], ["stage.completed", "wall"], ["stage.completed", "implement"]];
    const drive = async (dir: string, env: Record<string, string> = {}): Promise<{ rc: number; say: string; seen: number }> => {
      const cwd = process.cwd(), saved: Record<string, string | undefined> = {}, say: string[] = []; let seen = 0;
      for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
      try {
        process.chdir(dir);
        const rc = await resumeFlag(RID, true, { out: (x) => { say.push(x); }, supervise: (async () => { seen++; return { outcome: "VERIFIED" }; }) as never });
        return { rc, say: say.join(""), seen };
      } finally { process.chdir(cwd); for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
    };
    const msg = (reason: string): string => `resume: run ${RID} cannot be resumed (${reason}`;
    test("control: a healthy run resumes (rc 0)", async () => {
      const { dir } = setup((sha) => full(sha));
      try { const r = await drive(dir); expect(r.rc).toBe(0); expect(r.seen).toBe(1); } finally { rmSync(dir, { recursive: true, force: true }); }
    });
    test("the run branch is gone: exit 4 with the new-run action", async () => {
      const { dir, g } = setup((sha) => full(sha), { branch: false });
      try {
        expect(g("symbolic-ref", "--short", "HEAD").trim()).toBe("main");
        const r = await drive(dir);
        expect(r.rc).toBe(4); expect(r.seen).toBe(0);
        expect(r.say).toContain(msg(`run branch loki/${RID} is gone`));
        expect(r.say).toContain(`its work is on branch loki/${RID}. Start a new run: loki start <task>`);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
    test("the base commit is gone: exit 4", async () => {
      const { dir } = setup(() => full("1234567890abcdef1234567890abcdef12345678"));
      try { const r = await drive(dir); expect(r.rc).toBe(4); expect(r.seen).toBe(0); expect(r.say).toContain(msg("its base commit 1234567890ab is gone from this repo")); } finally { rmSync(dir, { recursive: true, force: true }); }
    });
    test("the event log is unreadable: exit 4", async () => {
      const { dir, ev } = setup((sha) => full(sha));
      try { writeFileSync(ev, readFileSync(ev, "utf8") + '{"v":1,"seq":5,"ty'); const r = await drive(dir); expect(r.rc).toBe(4); expect(r.seen).toBe(0); expect(r.say).toContain(msg("its event log is torn")); } finally { rmSync(dir, { recursive: true, force: true }); }
    });
    test("no stage had settled: exit 4", async () => {
      const { dir } = setup(() => [["run.started", null, { provider: "claude", model: "m" }], ["stage.started", "intake"]]);
      try { const r = await drive(dir); expect(r.rc).toBe(4); expect(r.seen).toBe(0); expect(r.say).toContain(msg("no stage had settled")); } finally { rmSync(dir, { recursive: true, force: true }); }
    });
    test("the provider changed since the kill: exit 4; the same provider still resumes", async () => {
      const { dir } = setup((sha) => full(sha));
      try {
        const r = await drive(dir, { LOKI_PROVIDER: "codex" });
        expect(r.rc).toBe(4); expect(r.seen).toBe(0); expect(r.say).toContain(msg("the provider changed since the kill: the run used claude, LOKI_PROVIDER is codex"));
        expect((await drive(dir, { LOKI_PROVIDER: "claude" })).rc).toBe(0);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
    test("the model changed since the kill: exit 4; an override the run already applied does not", async () => {
      const a = setup((sha) => full(sha)), b = setup((sha) => full(sha, { model_override_applied: true }));
      try {
        const r = await drive(a.dir, { LOKI_MODEL_OVERRIDE: "other-model" });
        expect(r.rc).toBe(4); expect(r.seen).toBe(0); expect(r.say).toContain(msg("the model changed since the kill: the run used m, LOKI_MODEL_OVERRIDE is other-model"));
        expect((await drive(b.dir, { LOKI_MODEL_OVERRIDE: "other-model" })).rc).toBe(0);
      } finally { rmSync(a.dir, { recursive: true, force: true }); rmSync(b.dir, { recursive: true, force: true }); }
    });
  });
  test("P12-07i review R5: resume refuses a run that hit its cap, and seeds prior spend and remaining time otherwise", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-r5-")), cwd = process.cwd();
    try {
      const g = gitRepo(dir);
      g("init", "-q"); g("commit", "-q", "--allow-empty", "-m", "i"); g("checkout", "-q", "-b", `loki/${RID}`);
      mkdirSync(join(dir, ".loki", "runs", RID), { recursive: true });
      const pre: Spec[] = [["run.started", null, { provider: "claude", model: "m", cap_s: 900, max_cost_usd: 5 }], ["stage.completed", "intake", { base_sha: "abc", task: "t" }], ["stage.completed", "plan"], ["stage.completed", "wall"], ["cost", "implement", { session_id: "s", usd: 3 }]];
      const evFile = join(dir, ".loki", "runs", RID, "events.jsonl");
      process.chdir(dir);
      const seen: { env: Record<string, string | undefined>; capS?: number }[] = [], supervise = (async (o: never) => { seen.push(o); return { outcome: "VERIFIED" }; }) as never, say: string[] = [];
      writeFileSync(evFile, text(mk([...pre, ["cap.hit", "implement", { elapsed_s: 1 }], ["stage.failed", "implement", { reason: "cap" }]])));
      expect(await resumeFlag(RID, true, { out: (x) => { say.push(x); }, supervise })).toBe(2);
      expect(say.join("")).toContain("hit its cost or time cap");
      expect(seen.length).toBe(0);
      writeFileSync(evFile, text(mk(pre)));
      expect(await resumeFlag(RID, true, { out: () => {}, supervise })).toBe(0);
      expect(seen[0]!.env["LOKI_E10_SPENT_USD"]).toBe("3");
      expect(seen[0]!.env["LOKI_E10_MAX_COST_USD"]).toBe("5");
      expect(seen[0]!.capS).toBeLessThanOrEqual(900);
      writeFileSync(evFile, text(mk([...pre.slice(0, 4), ["cost", "implement", { session_id: "s1", usd: 9 }], ["cost", "implement", { session_id: "s2", usd: null }]]))); // R6: one unmetered session must not null the metered spend
      expect(await resumeFlag(RID, true, { out: () => {}, supervise })).toBe(0);
      expect(seen[1]!.env["LOKI_E10_SPENT_USD"]).toBe("9");
    } finally { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); }
  });
  test("P12-07l: a long quiet stage counts in full toward active time; only a gap ending in run.resumed is downtime", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-p1207l-")), cwd = process.cwd();
    try {
      const g = gitRepo(dir);
      g("init", "-q"); g("commit", "-q", "--allow-empty", "-m", "i"); g("checkout", "-q", "-b", `loki/${RID}`);
      mkdirSync(join(dir, ".loki", "runs", RID), { recursive: true });
      const at = (i: number, sec: number, t: string, s: string | null, d: Record<string, unknown> = {}) => makeEvent(RID, i, t, s as never, d, new Date(Date.UTC(2026, 0, 1) + sec * 1000).toISOString());
      const evFile = join(dir, ".loki", "runs", RID, "events.jsonl");
      process.chdir(dir);
      const seen: { capS?: number; env: Record<string, string | undefined> }[] = [], supervise = (async (o: never) => { seen.push(o); return { outcome: "VERIFIED" }; }) as never;
      // verify runs 600s with no event in between, then the run is killed; a 5h gap then ends in run.resumed (downtime)
      const evs = [at(0, 0, "run.started", null, { provider: "claude", model: "m", cap_s: 900 }), at(1, 10, "stage.completed", "intake", { base_sha: "abc", task: "t" }), at(2, 20, "stage.completed", "plan"), at(3, 30, "stage.completed", "wall"), at(4, 40, "stage.completed", "implement"), at(5, 640, "stage.started", "verify"), at(6, 640 + 18000, "run.resumed", null)];
      writeFileSync(evFile, text(evs.slice(0, 6)));
      expect(await resumeFlag(RID, true, { out: () => {}, supervise })).toBe(0);
      expect(seen[0]!.capS).toBe(Math.floor(900 - 640)); // the 600s quiet gap before verify's first event counts
      expect(seen[0]!.env["LOKI_E10_CAP_S"]).toBe("260");
      writeFileSync(evFile, text(evs.slice(0, 5).concat([at(5, 100, "stage.started", "verify"), at(6, 100 + 18000, "run.resumed", null), at(7, 100 + 18010, "stage.started", "verify")])));
      expect(await resumeFlag(RID, true, { out: () => {}, supervise })).toBe(0);
      expect(seen[1]!.capS).toBe(900 - 110); // the 5h downtime gap is not counted
    } finally { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); }
  });
  test("P12-07n: a gap ending in run.resumed counts up to last_alive_ts as active; only the rest is downtime", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-p1207n-")), cwd = process.cwd();
    try {
      const g = gitRepo(dir);
      g("init", "-q"); g("commit", "-q", "--allow-empty", "-m", "i"); g("checkout", "-q", "-b", `loki/${RID}`);
      mkdirSync(join(dir, ".loki", "runs", RID), { recursive: true });
      const at = (i: number, sec: number, t: string, s: string | null, d: Record<string, unknown> = {}) => makeEvent(RID, i, t, s as never, d, new Date(Date.UTC(2026, 0, 1) + sec * 1000).toISOString());
      const iso = (sec: number): string => new Date(Date.UTC(2026, 0, 1) + sec * 1000).toISOString();
      const evFile = join(dir, ".loki", "runs", RID, "events.jsonl");
      process.chdir(dir);
      const seen: { capS?: number }[] = [], supervise = (async (o: never) => { seen.push(o); return { outcome: "VERIFIED" }; }) as never;
      // verify starts at 100, the process is killed mid-verify at 700 (last heartbeat, no event), resumed 5h later
      const evs = [at(0, 0, "run.started", null, { provider: "claude", model: "m", cap_s: 900 }), at(1, 10, "stage.completed", "intake", { base_sha: "abc", task: "t" }), at(2, 20, "stage.completed", "plan"), at(3, 30, "stage.completed", "wall"), at(4, 40, "stage.completed", "implement"), at(5, 100, "stage.started", "verify")];
      const resumed = (alive: Record<string, unknown>) => [at(6, 100 + 18000, "run.resumed", null, alive), at(7, 100 + 18010, "stage.started", "verify")];
      writeFileSync(evFile, text(evs.concat(resumed({ last_alive_ts: iso(700) }))));
      expect(await resumeFlag(RID, true, { out: () => {}, supervise })).toBe(0);
      expect(seen[0]!.capS).toBe(900 - (110 + 600)); // 100 + 10 normal gaps, plus 600s up to the heartbeat
      writeFileSync(evFile, text(evs.concat(resumed({}))));
      expect(await resumeFlag(RID, true, { out: () => {}, supervise })).toBe(0);
      expect(seen[1]!.capS).toBe(900 - 110); // no heartbeat recorded: the whole gap is downtime
    } finally { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); }
  });
  test("P12-07n: a resumed supervisor records the previous heartbeat in run.resumed and refreshes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-p1207n-s-"));
    try {
      const g = gitRepo(dir);
      g("init", "-q"); g("commit", "-q", "--allow-empty", "-m", "i");
      const runDir = join(dir, ".loki", "runs", RID); mkdirSync(runDir, { recursive: true });
      const old = Date.UTC(2026, 0, 1, 12);
      writeAliveBeat(runDir, old);
      await runSupervisor({ runId: RID, repoDir: dir, env: { ...process.env, LOKI_CLAUDE_CLI: "/usr/bin/true" }, capS: 600, resume: true, workerArgv: [process.execPath, "-e", "process.exit(0)"], started: {} });
      const resumedEv = readEvents(join(runDir, "events.jsonl")).find((e) => e.type === "run.resumed");
      expect(resumedEv?.data["last_alive_ts"]).toBe(new Date(old).toISOString());
      expect(readAliveBeat(runDir)).toBeGreaterThan(old);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("P12-07n: a garbage alive file is no heartbeat and never stops the resume", async () => {
    for (const junk of ["1e20", "-5", "abc", "", String(Date.now() + 3_600_000)]) {
      const dir = mkdtempSync(join(tmpdir(), "loki-p1207n-g-"));
      try {
        const g = gitRepo(dir);
        g("init", "-q"); g("commit", "-q", "--allow-empty", "-m", "i");
        const runDir = join(dir, ".loki", "runs", RID); mkdirSync(runDir, { recursive: true });
        writeFileSync(join(runDir, "alive"), junk + "\n");
        expect(readAliveBeat(runDir)).toBeNull();
        await runSupervisor({ runId: RID, repoDir: dir, env: { ...process.env, LOKI_CLAUDE_CLI: "/usr/bin/true" }, capS: 600, resume: true, workerArgv: [process.execPath, "-e", "process.exit(0)"], started: {} });
        const ev = readEvents(join(runDir, "events.jsonl")).find((e) => e.type === "run.resumed");
        expect(ev).toBeDefined();
        expect(ev!.data["last_alive_ts"]).toBeUndefined();
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  }, 60000); // five full resumes, each a git init plus a supervisor run; the 5000ms default fails under load (FC-FIXRESUME-LOOP-TEST-DEFAULT-TIMEOUT)
  test("P12-07l: the deep worker honors LOKI_E10_CAP_S (remaining cap on resume) and falls back to its full cap", () => {
    expect(workerCapS(true, { LOKI_E10_CAP_S: "260" })).toBe(260);
    expect(workerCapS(true, {})).toBe(DEEP_CAP_S);
    expect(workerCapS(false, { LOKI_E10_CAP_S: "260" })).toBe(260);
    expect(workerCapS(false, {})).toBe(DEFAULT_CAP_S);
  });
  test("P12-07m: Infinity and non-numeric LOKI_E10_CAP_S fall back to the default cap", () => {
    for (const bad of ["Infinity", "-Infinity", "abc", "", "0", "-5", "NaN"]) {
      expect(workerCapS(true, { LOKI_E10_CAP_S: bad })).toBe(DEEP_CAP_S);
      expect(workerCapS(false, { LOKI_E10_CAP_S: bad })).toBe(DEFAULT_CAP_S);
    }
  });
  test("P12-07m: a fresh --deep start with a stale parent LOKI_E10_CAP_S delivers DEEP_CAP_S to the worker env", () => {
    const env: NodeJS.ProcessEnv = { LOKI_E10_CAP_S: "Infinity", LOKI_E10_CAP_FIXED_S: "50" };
    applyCapEnv(env, DEEP_CAP_S, null);
    expect(env["LOKI_E10_CAP_S"]).toBe(String(DEEP_CAP_S));
    expect(workerCapS(true, env)).toBe(DEEP_CAP_S);
    const fast: NodeJS.ProcessEnv = { LOKI_E10_CAP_S: "5" };
    applyCapEnv(fast, 900, { fixedS: 700 });
    expect([fast["LOKI_E10_CAP_S"], fast["LOKI_E10_CAP_FIXED_S"]]).toEqual(["900", "700"]);
    applyCapEnv(fast, 900, {});
    expect(fast["LOKI_E10_CAP_FIXED_S"]).toBeUndefined();
  });
  test("P12-07m: main() on a fresh --deep start overrides a stale LOKI_E10_CAP_S in the worker env", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-p1207m-"));
    try {
      const repo = join(dir, "repo"), out = join(dir, "cap.json");
      execFileSync("git", ["init", "-q", "-b", "main", repo]);
      execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "i"]);
      // the driver is both the entry point and, when main() respawns process.argv[1] as `engine10 worker ...`, the fake worker
      writeFileSync(join(dir, "drive.ts"), `import { writeFileSync } from "node:fs";
if (process.argv[2] === "engine10") { writeFileSync(${JSON.stringify(out)}, JSON.stringify({ cap: process.env.LOKI_E10_CAP_S ?? null, argv: process.argv.slice(2) })); process.exit(0); }
const { main } = await import(${JSON.stringify(join(import.meta.dir, "../../src/engine10/supervisor.ts"))});
await main(["--deep", "--no-pr", "--quiet", "add a thing"]); process.exit(0);
`);
      const env = { ...process.env, LOKI_E10_CAP_S: "Infinity", LOKI_CLAUDE_CLI: "/usr/bin/true", LOKI_SPEED: "0", LOKI_CONTROL: "0", LOKI_NO_BROWSER: "1" };
      execFileSync(process.execPath, [join(dir, "drive.ts")], { cwd: repo, env, stdio: "ignore", timeout: 60000 });
      const seen = JSON.parse(readFileSync(out, "utf8")) as { cap: string | null; argv: string[] };
      expect(seen.argv).toContain("deep");
      expect(seen.cap).toBe(String(DEEP_CAP_S));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 70000);
  test("P12-07i: resumeMachineOpts fails closed on an invalid resume point and leaves ctx unseeded", () => {
    const { ctx } = fakeCtx();
    const evs = killedAfterImplement();
    const bad = resumeMachineOpts(ctx as never, evs, text(evs).trimEnd(), FLOW);
    expect(bad.ok).toBe(false);
    expect(ctx.intentRevisions).toBeUndefined();
    expect(ctx.timeline).toBeUndefined();
  });
});

describe("resume review fixes (P12-07)", () => {
  test("handoff does not count a cap-skipped stage as settled", () => {
    const evs = mk([["run.started", null], ["stage.completed", "intake", { base_sha: "a" }], ["stage.completed", "plan"], ["stage.completed", "wall"], ["stage.completed", "implement"], ["stage.skipped", "verify"]]);
    const h = renderHandoff(composeHandoff({ repoDir: tmpdir(), runId: RID, events: evs, outcome: "BUDGET_STOP", usd: null, elapsedS: null, notProven: [] }));
    expect(h).toContain("Stopped before stage verify completed");
    expect(h).toContain("in a new run: loki start");
  });
  test("P12-07b: handoff states what reruns and that only a sealed publish phase resumes", () => {
    const evs = killedAfterImplement();
    const h = renderHandoff(composeHandoff({ repoDir: tmpdir(), runId: RID, events: evs, outcome: "BUDGET_STOP", usd: null, elapsedS: null, notProven: [] }));
    expect(h).toContain("No stage is re-entered");
    expect(h).toContain("stage verify and every later stage rerun only in a new run");
    expect(h).toContain("reuses that receipt and reruns only the PR step");
    expect(h).toContain("loki resume or loki start --resume");
    expect(h).not.toContain("Resuming a stopped run is not available");
  });
  test("wall finishing before plan is accepted; resume re-enters at plan", () => {
    const evs = mk([["run.started", null], ["stage.completed", "intake", { base_sha: "a" }], ["stage.completed", "wall"]]);
    const r = resumePoint(evs, text(evs));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.stage).toBe("plan");
  });
  test("a log containing tamper.detected refuses", () => {
    const evs = mk([["run.started", null], ["stage.completed", "intake", { base_sha: "a" }], ["tamper.detected", null]]);
    expect(resumePoint(evs, text(evs)).ok).toBe(false);
  });
  test("--no-pr on a publish-phase run refuses and never publishes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-p1207b-"));
    const cwd = process.cwd();
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      mkdirSync(join(dir, ".loki", "runs", RID), { recursive: true });
      const evs = mk([["run.started", null], ["stage.completed", "intake", { base_sha: "a" }], ["stage.completed", "plan"], ["stage.completed", "wall"], ["stage.completed", "implement"], ["stage.completed", "verify"], ["stage.completed", "commit"], ["receipt.sealed", "seal", { verdict: "VERIFIED" }]]);
      writeFileSync(join(dir, ".loki", "runs", RID, "events.jsonl"), text(evs));
      process.chdir(dir);
      const say: string[] = [];
      let called = 0;
      const runPr = async (): Promise<never> => { called++; throw new Error("must not publish"); };
      expect(await resumeFlag(RID, true, { out: (s) => { say.push(s); }, runPr })).toBe(2);
      expect(called).toBe(0);
      expect(say.join("")).toContain("--no-pr");
    } finally { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("early session id (FC-IMPLEMENT-RESUME-STARTS-OVER)", () => {
  test("a SIGKILLed session leaves its provider session id in the heartbeat event", async () => {
    const iter = "r1-implement1", events: Record<string, unknown>[] = [];
    const stub = `mkdir -p .loki; printf '{"session_id":"sess-early"}' > .loki/e10-session-${iter}.json; sleep 30`;
    const ac = new AbortController();
    const runner = createSessionRunner({ provider: "claude", heartbeatMs: 100, childCommand: ["bash", ["-c", stub]], emit: (t: string, _s: unknown, d: Record<string, unknown>) => { if (t === "heartbeat" && d.provider_session_id) { events.push(d); ac.abort(); } } } as never);
    const r = await runner.run({ stage: "implement", brief: "x", tier: "dev", iterationId: iter, limitS: 30, signal: ac.signal, cwd: repo } as never);
    expect(r.killed).toBe(true);
    expect(events[0]?.provider_session_id).toBe("sess-early");
  });
  test("writeSessionId is idempotent for the same id", async () => {
    const { writeSessionId, readSessionId } = await import("../../src/runner/session_resume.ts");
    writeSessionId(repo, "i1", { sessionId: "a" }); writeSessionId(repo, "i1", { sessionId: "a" });
    expect(readSessionId(repo, "i1")).toBe("a");
  });
  test("consumeSdkStream reports the id at the first frame, before the stream ends", async () => {
    const { consumeSdkStream } = await import("../../src/runner/sdk_stream_parser.ts");
    const got: string[] = []; let atCall = false;
    async function* gen() { yield { type: "system", subtype: "init", session_id: "s-1" } as never; atCall = got.length === 1; yield { type: "system", session_id: "s-1" } as never; }
    await consumeSdkStream(gen(), { cwd: repo, iteration: "i", hookEventsEnabled: false, write: () => {}, onSessionId: (id) => got.push(id) });
    expect(got).toEqual(["s-1"]); expect(atCall).toBe(true);
  });
});

describe("interrupted stage resume (FC-IMPLEMENT-RESUME-STARTS-OVER)", () => {
  const runImpl = async (c: RunContext) => (await import("../../src/engine10/stages/implement.ts")).implementStage.run(c, new AbortController().signal);
  const outs = { intake: { task: "do it" } };
  test("implement rerun passes the recorded id to the provider with a short continue brief, one session", async () => {
    writeId("r1-impl", "sess-killed");
    const s = new Fake(() => ok);
    const r = await runImpl(ctxFor(s, outs));
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.resumeSessionId).toBe("sess-killed");
    expect(s.calls[0]!.brief).toContain("interrupted");
    expect(r.data.session_resume).toBe("resumed");
    expect(r.data.iteration_ids).toEqual(["r1-impl"]);
  });
  test("implement: missing id starts fresh and says so", async () => {
    const s = new Fake(() => ok);
    const r = await runImpl(ctxFor(s, outs));
    expect("resumeSessionId" in s.calls[0]!).toBe(false);
    expect(r.data.session_resume).toBe("fresh (no session id recorded)");
  });
  test("implement: rejected id reruns fresh with the full brief and says so", async () => {
    writeId("r1-impl", "sess-bad");
    const s = new Fake((_o, n) => (n === 1 ? { ...ok, exit: 1 } : ok));
    const r = await runImpl(ctxFor(s, outs));
    expect(s.calls).toHaveLength(2);
    expect("resumeSessionId" in s.calls[1]!).toBe(false);
    expect(s.calls[1]!.brief).toContain("do it");
    expect(r.data.session_resume).toBe("fallback (resume failed)");
  });
  test("implement: an id recorded under another iteration is never reused", async () => {
    writeId("r1-impl-other", "sess-x"); writeId("r0-impl", "sess-y"); writeId("r1-fix1", "sess-z");
    const s = new Fake(() => ok);
    await runImpl(ctxFor(s, outs));
    expect("resumeSessionId" in s.calls[0]!).toBe(false);
  });
  test("fix rerun resumes its own killed round session, even with the chain flag off", async () => {
    writeId("r1-fix1", "sess-fixkilled");
    const s = new Fake(() => ok);
    const r = await run(ctxFor(s, { intake: { task: "do it" }, verify: { failures_grouped: groups }, implement: impl }));
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.resumeSessionId).toBe("sess-fixkilled");
    expect(r.data.fix_resume).toBe("resumed (interrupted session)");
  });
  test("fix: rejected id falls back fresh with the full brief; another round's id is not reused", async () => {
    writeId("r1-fix1", "sess-bad"); writeId("r1-fix2", "sess-other");
    const s = new Fake((_o, n) => (n === 1 ? { ...ok, exit: 1 } : ok));
    const r = await run(ctxFor(s, { intake: { task: "do it" }, verify: { failures_grouped: groups }, implement: impl }));
    expect(s.calls).toHaveLength(2);
    expect("resumeSessionId" in s.calls[1]!).toBe(false);
    expect(String(r.data.fix_resume)).toContain("fallback");
    const s2 = new Fake(() => ok);
    rmSync(join(repo, ".loki", "e10-session-r1-fix1.json"));
    const r2 = await run(ctxFor(s2, { intake: { task: "do it" }, verify: { failures_grouped: groups }, implement: impl }));
    expect("resumeSessionId" in s2.calls[0]!).toBe(false);
    expect(r2.data.fix_resume).toBe("fresh");
  });
});

// PX-5: a provider session killed with a real SIGKILL (a pid this test spawned and recorded) leaves its id on disk, and the rerun resumes that session instead of starting over.
describe("SIGKILL of a live session then resume (PX-5)", () => {
  test("the killed implement session is resumed by its recorded id, one session, measured latency", async () => {
    mkdirSync(join(repo, ".loki"), { recursive: true });
    const file = join(repo, ".loki", "e10-session-r1-impl.json");
    const sessionSrc = join(import.meta.dir, "../../src/runner/session_resume.ts");
    const child = spawn(process.execPath, ["-e", `import { writeSessionId } from ${JSON.stringify(sessionSrc)}; writeSessionId(process.env.REPO, "r1-impl", { sessionId: "sess-sigkill" }); setInterval(() => {}, 1 << 30);`], { env: { ...process.env, REPO: repo }, stdio: "ignore" }); // the real writeSessionId runs in the child, which is then killed
    try {
      for (let i = 0; i < 100 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 50));
      expect(existsSync(file)).toBe(true);
      const exited = new Promise((r) => child.once("exit", r));
      process.kill(child.pid as number, "SIGKILL");
      await exited;
      expect(child.signalCode).toBe("SIGKILL");
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
    const s = new Fake(() => ok), t0 = performance.now();
    const r = await (await import("../../src/engine10/stages/implement.ts")).implementStage.run(ctxFor(s, { intake: { task: "do it" } }), new AbortController().signal);
    const ms = Math.round(performance.now() - t0);
    console.log(`PX5 session resume latency ms (measured, unbounded): ${ms}`);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.resumeSessionId).toBe("sess-sigkill");
    expect(s.calls[0]!.brief).toContain("interrupted");
    expect(r.data.session_resume).toBe("resumed");
    expect(r.data.iteration_ids).toEqual(["r1-impl"]);
  });
});
