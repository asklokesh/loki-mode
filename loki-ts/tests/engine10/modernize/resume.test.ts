// M-22 wall: unit-level resume after a coordinator crash (docs/v10/MODERNIZE.md sections 3.7 and 5).
import { describe, expect, it } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClusterResult, Unit } from "../../../src/engine10/modernize/cluster.ts";
import { ModernizeLog, readModernizeEvents } from "../../../src/engine10/modernize/log.ts";
import { loadResumeState, mergeOnce, planResume, resumeSchedule } from "../../../src/engine10/modernize/resume.ts";
import type { MergeOps } from "../../../src/engine10/modernize/resume.ts";
import { gitWorktrees, schedule } from "../../../src/engine10/modernize/scheduler.ts";
import { buildInventory } from "../../../src/engine10/modernize/inventory.ts";
import { safeGit } from "../../../src/util/safe_git.ts";
import type { runUnit } from "../../../src/engine10/modernize/unit.ts";
import type { AttemptCtx, AttemptOutcome, WorktreeOps } from "../../../src/engine10/modernize/scheduler.ts";
import type { UnitRunResult } from "../../../src/engine10/modernize/unit.ts";
import { makeAttemptRunner, makeProposeSession, makeUnitPrep, productionWaveDeps, runWaves } from "../../../src/util/modernize_coordinator.ts";
import type { WaveDeps } from "../../../src/util/modernize_coordinator.ts";
import type { StepRunner } from "../../../src/engine10/modernize/wave.ts";
import { makeUnitRunners } from "../../../src/util/modernize_unit.ts";
import { modernizeEventsPath, planPath } from "../../../src/engine10/modernize/types.ts";

const MID = "mod-20260101T000000Z-abcdef";
const u = (id: string): Unit => ({ id, nodes: [id], lines: 1, highRisk: false });
const planOf = (waves: Unit[][]): ClusterResult => ({ units: waves.flat(), waves: waves.map((w) => w.map((x) => x.id)) });
const proven = (unit: string): UnitRunResult => ({ unit, verdict: "PROVEN", oracle: null, wall: null, equiv: null, not_proven: [], conformance: null });

function fx() {
  const dir = mkdtempSync(join(tmpdir(), "m22-"));
  const log = new ModernizeLog(dir, MID);
  const worktrees: WorktreeOps = { create: () => {}, remove: () => {} };
  return { dir, log, worktrees, done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("loadResumeState", () => {
  it("folds completed, not_proven, in-flight and records run ids", () => {
    const f = fx();
    f.log.append("unit.started", { unit: "a", model: "sonnet", variant: 0 });
    f.log.append("unit.completed", { unit: "a" });
    f.log.append("unit.started", { unit: "b", model: "sonnet", variant: 0 });
    f.log.append("unit.not_proven", { unit: "b", reasons: ["x"] });
    f.log.append("unit.started", { unit: "c", model: "opus", variant: 1, run_id: "run-1" });
    const s = loadResumeState(f.dir, MID);
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect([...s.state.completed]).toEqual(["a"]);
    expect([...s.state.notProven]).toEqual(["b"]);
    expect([...s.state.inFlight.keys()]).toEqual(["c"]);
    expect(s.state.inFlight.get("c")?.runId).toBe("run-1");
    f.done();
  });

  it("tolerates a torn last line", () => {
    const f = fx();
    f.log.append("unit.completed", { unit: "a" });
    appendFileSync(modernizeEventsPath(f.dir, MID), '{"v":1,"seq":1,"ts":"2026');
    const s = loadResumeState(f.dir, MID);
    expect(s.ok).toBe(true);
    f.done();
  });

  it("resumes a torn-tail log even after the writer constructor newline-terminated the tail", async () => {
    const f = fx();
    f.log.append("unit.completed", { unit: "a" });
    appendFileSync(modernizeEventsPath(f.dir, MID), '{"v":1,"seq":1,"ty');
    const log2 = new ModernizeLog(f.dir, MID); // terminates the torn line, as the real flow does
    expect(loadResumeState(f.dir, MID).ok).toBe(true);
    const r = await resumeSchedule(planOf([[u("a"), u("b")]]), {
      repoDir: f.dir, mid: MID, baseSha: "x", workers: 1, budgetUsd: null, unitEstimateUsd: null, worktrees: f.worktrees,
      log: log2, run: async (c) => ({ result: proven(c.unit.id), costUsd: 0 }),
    });
    expect(r.ok).toBe(true);
    f.done();
  });

  it("a double crash leaves no torn line mid-log (constructor truncates the torn tail)", () => {
    const f = fx();
    f.log.append("unit.completed", { unit: "a" });
    appendFileSync(modernizeEventsPath(f.dir, MID), '{"v":1,"seq":1,"ty');
    const log2 = new ModernizeLog(f.dir, MID);
    log2.append("unit.completed", { unit: "b" });
    const s = loadResumeState(f.dir, MID);
    expect(s.ok).toBe(true);
    if (s.ok) expect([...s.state.completed].sort()).toEqual(["a", "b"]);
    f.done();
  });

  it("fails closed on a corrupt middle line", () => {
    const f = fx();
    f.log.append("unit.completed", { unit: "a" });
    appendFileSync(modernizeEventsPath(f.dir, MID), "garbage\n");
    f.log.append("unit.completed", { unit: "b" });
    const s = loadResumeState(f.dir, MID);
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.reason).toMatch(/line 2/);
    f.done();
  });

  it("fails closed on a non-increasing seq, a foreign run id, and a missing log", () => {
    const f = fx();
    f.log.append("unit.completed", { unit: "a" });
    const p = modernizeEventsPath(f.dir, MID);
    const line = readFileSync(p, "utf8");
    appendFileSync(p, line);
    const dup = loadResumeState(f.dir, MID);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.reason).toMatch(/seq/);
    writeFileSync(p, line.replace(MID, "mod-other"));
    const foreign = loadResumeState(f.dir, MID);
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.reason).toMatch(/run/);
    rmSync(p);
    const missing = loadResumeState(f.dir, MID);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toMatch(/no modernize log/);
    f.done();
  });

  it("fails closed on a corrupt plan.json when one is present", () => {
    const f = fx();
    f.log.append("modernize.started", {});
    writeFileSync(planPath(f.dir, MID), '{"units":[');
    const s = loadResumeState(f.dir, MID);
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.reason).toMatch(/plan\.json/);
    f.done();
  });
});

describe("planResume", () => {
  it("skips terminal units, resumes started-with-run-id, restarts started-without, dispatches fresh", () => {
    const f = fx();
    f.log.append("unit.completed", { unit: "a" });
    f.log.append("unit.started", { unit: "b", model: "sonnet", variant: 0, run_id: "r9" });
    f.log.append("unit.started", { unit: "c", model: "sonnet", variant: 0 });
    const s = loadResumeState(f.dir, MID);
    if (!s.ok) throw new Error(s.reason);
    const p = planResume(planOf([[u("a"), u("b")], [u("c"), u("d")]]), s.state);
    expect(p.skipped).toEqual(["a"]);
    expect(p.actions).toEqual([
      { unit: "b", action: "resume", runId: "r9" },
      { unit: "c", action: "restart" },
      { unit: "d", action: "fresh" },
    ]);
    expect(p.plan.waves).toEqual([["b"], ["c", "d"]]);
    f.done();
  });
});

describe("mergeOnce", () => {
  it("merges once, records unit.completed, and never merges twice", () => {
    const f = fx();
    const merged = new Set<string>();
    let calls = 0;
    const ops: MergeOps = { isMerged: (x) => merged.has(x), merge: (x) => { calls++; merged.add(x); } };
    expect(mergeOnce("a", ops, f.log, new Set())).toBe("merged");
    expect(mergeOnce("a", ops, f.log, new Set(["a"]))).toBe("already_completed");
    expect(calls).toBe(1);
    f.done();
  });

  it("crash between merge and state write: restart adopts the merge, no second merge", () => {
    const f = fx();
    const merged = new Set<string>();
    let calls = 0;
    const ops: MergeOps = { isMerged: (x) => merged.has(x), merge: (x) => { calls++; merged.add(x); } };
    f.log.append("unit.started", { unit: "a", model: "sonnet", variant: 0 });
    ops.merge("a"); // merge landed, coordinator died before unit.completed
    calls = 0;
    const s = loadResumeState(f.dir, MID);
    if (!s.ok) throw new Error(s.reason);
    expect(s.state.completed.has("a")).toBe(false);
    const log2 = new ModernizeLog(f.dir, MID);
    expect(mergeOnce("a", ops, log2, s.state.completed)).toBe("adopted");
    expect(calls).toBe(0);
    const evs = readModernizeEvents(f.dir, MID);
    expect(evs.filter((e) => e.type === "unit.completed").length).toBe(1);
    const seqs = evs.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs.every((x, i) => i === 0 || x > seqs[i - 1]!)).toBe(true);
    f.done();
  });
});

describe("resumeSchedule", () => {
  it("kills mid-wave then resumes: no unit runs twice to completion, seq keeps increasing", async () => {
    const f = fx();
    const plan = planOf([[u("a"), u("b")], [u("c")]]);
    const ran: string[] = [];
    const run = async (c: AttemptCtx): Promise<AttemptOutcome> => { ran.push(c.unit.id); return { result: proven(c.unit.id), costUsd: 0 }; };
    const base = { repoDir: f.dir, mid: MID, baseSha: "x", workers: 1, budgetUsd: null, unitEstimateUsd: null, worktrees: f.worktrees };
    f.log.append("wave.started", { units: 2 });
    f.log.append("unit.started", { unit: "a", model: "sonnet", worker: 1, variant: 0 });
    f.log.append("unit.completed", { unit: "a" });
    f.log.append("unit.started", { unit: "b", model: "sonnet", worker: 1, variant: 0 });
    const before = readModernizeEvents(f.dir, MID).length;
    const r = await resumeSchedule(plan, { ...base, log: new ModernizeLog(f.dir, MID), run });
    expect(r.ok).toBe(true);
    expect(ran).toEqual(["b", "c"]);
    const evs = readModernizeEvents(f.dir, MID);
    expect(evs.length).toBeGreaterThan(before);
    const seqs = evs.map((e) => e.seq);
    expect(seqs.every((x, i) => i === 0 || x > seqs[i - 1]!)).toBe(true);
    for (const id of ["b", "c"]) new ModernizeLog(f.dir, MID).append("unit.completed", { unit: id });
    ran.length = 0;
    const r2 = await resumeSchedule(plan, { ...base, log: new ModernizeLog(f.dir, MID), run });
    expect(r2.ok).toBe(true);
    expect(ran).toEqual([]);
    f.done();
  });

  it("refuses to run anything on corrupt state", async () => {
    const f = fx();
    f.log.append("unit.completed", { unit: "a" });
    appendFileSync(modernizeEventsPath(f.dir, MID), "garbage\n");
    f.log.append("unit.completed", { unit: "b" });
    let ran = 0;
    const r = await resumeSchedule(planOf([[u("c")]]), {
      repoDir: f.dir, mid: MID, baseSha: "x", workers: 1, budgetUsd: null, unitEstimateUsd: null, worktrees: f.worktrees,
      log: new ModernizeLog(f.dir, MID), run: async (c) => { ran++; return { result: proven(c.unit.id), costUsd: 0 }; },
    });
    expect(r.ok).toBe(false);
    expect(ran).toBe(0);
    expect(existsSync(f.dir)).toBe(true);
    f.done();
  });

  it("fails closed when isMerged throws: no unit.completed appended, runner never invoked", async () => {
    const f = fx();
    f.log.append("unit.started", { unit: "a", model: "sonnet", variant: 0 });
    let ran = 0;
    const merge: MergeOps = { isMerged: () => { throw new Error("git down"); }, merge: () => {} };
    await expect(resumeSchedule(planOf([[u("a")]]), {
      repoDir: f.dir, mid: MID, baseSha: "x", workers: 1, budgetUsd: null, unitEstimateUsd: null, worktrees: f.worktrees, merge,
      log: new ModernizeLog(f.dir, MID), run: async (c) => { ran++; return { result: proven(c.unit.id), costUsd: 0 }; },
    })).rejects.toThrow(/git down/);
    expect(readModernizeEvents(f.dir, MID).filter((e) => e.type === "unit.completed").length).toBe(0);
    expect(ran).toBe(0);
    f.done();
  });
});

describe("scheduler merge path end to end", () => {
  it("crash after a merge and before its log write: resume adopts it, never re-merges, runs the rest", async () => {
    const f = fx();
    const plan = planOf([[u("a"), u("b")], [u("c")]]);
    const merged = new Set<string>();
    const mergeCalls: string[] = [];
    const merge: MergeOps = { isMerged: (x) => merged.has(x), merge: (x) => { mergeCalls.push(x); merged.add(x); } };
    const ran: string[] = [];
    const run = async (c: AttemptCtx): Promise<AttemptOutcome> => { ran.push(c.unit.id); return { result: proven(c.unit.id), costUsd: 0 }; };
    const base = { repoDir: f.dir, mid: MID, baseSha: "x", workers: 1, budgetUsd: null, unitEstimateUsd: null, worktrees: f.worktrees, merge, run };
    const first = await schedule(plan, { ...base, log: f.log });
    expect(first.outcomes.every((o) => o.status === "PROVEN")).toBe(true);
    expect(mergeCalls).toEqual(["a", "b", "c"]);
    expect(readModernizeEvents(f.dir, MID).filter((e) => e.type === "unit.completed").map((e) => e.data.unit)).toEqual(["a", "b", "c"]);

    // Crash: b's merge landed, but unit.completed for b (and everything after) never reached the log.
    const p = modernizeEventsPath(f.dir, MID);
    const lines = readFileSync(p, "utf8").split("\n").filter((l) => l !== "");
    const cut = lines.findIndex((l) => l.includes('"unit.completed"') && l.includes('"unit":"b"'));
    writeFileSync(p, lines.slice(0, cut).join("\n") + "\n");
    merged.delete("c");
    mergeCalls.length = 0;
    ran.length = 0;

    const r = await resumeSchedule(plan, { ...base, log: new ModernizeLog(f.dir, MID) });
    expect(r.ok).toBe(true);
    expect(mergeCalls).toEqual(["c"]);
    expect(ran).toEqual(["c"]);
    const evs = readModernizeEvents(f.dir, MID);
    expect(evs.filter((e) => e.type === "unit.completed").map((e) => e.data.unit)).toEqual(["a", "b", "c"]);
    const seqs = evs.map((e) => e.seq);
    expect(seqs.every((x, i) => i === 0 || x > seqs[i - 1]!)).toBe(true);
    f.done();
  });

  it("a crash with an unmerged in-flight unit never merges or completes it outside the verify path", async () => {
    const f = fx();
    const plan = planOf([[u("a")]]);
    f.log.append("unit.started", { unit: "a", run_id: "r-a", model: "sonnet", variant: 0 });
    const mergeCalls: string[] = [];
    const merge: MergeOps = { isMerged: () => false, merge: (x) => { mergeCalls.push(x); } };
    const run = async (): Promise<AttemptOutcome> => ({ result: { ...proven("a"), verdict: "NOT_PROVEN" }, costUsd: 0 });
    const log2 = new ModernizeLog(f.dir, MID);
    const r = await resumeSchedule(plan, { repoDir: f.dir, mid: MID, baseSha: "x", workers: 1, budgetUsd: null, unitEstimateUsd: null, worktrees: f.worktrees, merge, run, log: log2 });
    expect(r.ok).toBe(true);
    expect(mergeCalls).toEqual([]);
    expect(readModernizeEvents(f.dir, MID).filter((e) => e.type === "unit.completed")).toEqual([]);
    f.done();
  });

  it("a merge that landed but whose log append failed says so", async () => {
    const f = fx();
    const merged = new Set<string>();
    const merge: MergeOps = { isMerged: (x) => merged.has(x), merge: (x) => { merged.add(x); } };
    const badLog = { append: (t: string, d: Record<string, unknown>) => { if (t === "unit.completed") throw new Error("disk full"); return f.log.append(t, d); } } as unknown as ModernizeLog;
    const r = await schedule(planOf([[u("a")]]), {
      repoDir: f.dir, mid: MID, baseSha: "x", workers: 1, budgetUsd: null, unitEstimateUsd: null, worktrees: f.worktrees, merge,
      log: badLog, run: async (c) => ({ result: proven(c.unit.id), costUsd: 0 }),
    });
    expect(r.outcomes[0]!.status).toBe("NOT_PROVEN");
    expect(r.outcomes[0]!.reason).toMatch(/merge landed, log append failed: disk full/);
    f.done();
  });

  it("a merge that throws marks the unit NOT_PROVEN with a reason", async () => {
    const f = fx();
    const merge: MergeOps = { isMerged: () => false, merge: () => { throw new Error("conflict"); } };
    const r = await schedule(planOf([[u("a")]]), {
      repoDir: f.dir, mid: MID, baseSha: "x", workers: 1, budgetUsd: null, unitEstimateUsd: null, worktrees: f.worktrees, merge,
      log: f.log, run: async (c) => ({ result: proven(c.unit.id), costUsd: 0 }),
    });
    expect(r.outcomes[0]!.status).toBe("NOT_PROVEN");
    expect(r.outcomes[0]!.reason).toMatch(/merge failed: conflict/);
    f.done();
  });
});

describe("resume of an in-flight unit", () => {
  const setup = (reusable: boolean | undefined) => {
    const f = fx();
    f.log.append("unit.started", { unit: "a", model: "sonnet", worker: 1, variant: 0, run_id: "run-77" });
    const created: string[] = [];
    const worktrees: WorktreeOps = { create: (_r, p) => { created.push(p); }, remove: () => {}, ...(reusable === undefined ? {} : { reusable: () => reusable }) };
    const ctxs: AttemptCtx[] = [];
    const opts = {
      repoDir: f.dir, mid: MID, baseSha: "x", workers: 1, budgetUsd: null, unitEstimateUsd: null, worktrees,
      log: new ModernizeLog(f.dir, MID), run: async (c: AttemptCtx): Promise<AttemptOutcome> => { ctxs.push(c); return { result: proven(c.unit.id), costUsd: 0 }; },
    };
    return { f, created, ctxs, opts };
  };

  it("reattaches the worktree and passes the recorded run id to the runner", async () => {
    const { f, created, ctxs, opts } = setup(true);
    const r = await resumeSchedule(planOf([[u("a")]]), opts);
    expect(r.ok).toBe(true);
    expect(ctxs[0]!.resumeRunId).toBe("run-77");
    expect(created).toEqual([]);
    f.done();
  });

  it("falls back to a clean restart and logs the reason when the worktree is not reusable", async () => {
    for (const reusable of [false, undefined]) {
      const { f, created, ctxs, opts } = setup(reusable);
      await resumeSchedule(planOf([[u("a")]]), opts);
      expect(ctxs[0]!.resumeRunId).toBeUndefined();
      expect(created.length).toBe(1);
      const fb = readModernizeEvents(f.dir, MID).filter((e) => e.type === "unit.resume_fallback");
      expect(fb.length).toBe(1);
      expect(String(fb[0]!.data.reason)).toMatch(/restarted cleanly/);
      f.done();
    }
  });
});

describe("runWaves (coordinator): verify, ship, resume", () => {
  const cmd = { argv: ["true"] };
  const okStep: StepRunner = () => ({ status: 0, timedOut: false, error: null, tail: "" });
  const mk = (f: ReturnType<typeof fx>, over: Partial<WaveDeps> & { ran?: string[]; merged?: Set<string> } = {}): WaveDeps => {
    const merged = over.merged ?? new Set<string>();
    return {
      repoDir: f.dir, mid: MID, baseSha: "base", workers: 2, budgetUsd: null, unitEstimateUsd: null, log: f.log,
      run: (ctx: AttemptCtx): AttemptOutcome => { over.ran?.push(ctx.unit.id); return { result: proven(ctx.unit.id), costUsd: 0 }; },
      merge: { isMerged: (x) => merged.has(x), merge: (x) => { merged.add(x); } },
      worktrees: f.worktrees, resume: false, waveCommands: { build: cmd, integration: cmd, original_suite: cmd }, stepRunner: okStep,
      ship: true, pinnedOrigin: "https://example.invalid/r.git", push: () => ({ ok: true, url: "https://example.invalid/pr/1", existing: false } as never),
      ...over,
    };
  };

  it("a verified wave invokes shipWave (non-draft PR) and records wave.shipped; a failed verify ships a draft and blocks the next wave", async () => {
    const f = fx();
    try {
      const pushes: Array<{ draft: boolean }> = [];
      const push = ((a: { draft: boolean }) => { pushes.push(a); return { ok: true, url: "https://example.invalid/pr/1", existing: false }; }) as never;
      const r = await runWaves(planOf([[u("a")], [u("b")]]), mk(f, { push }));
      expect(r.ok).toBe(true);
      expect(pushes.map((p) => p.draft)).toEqual([false, false]);
      expect(readModernizeEvents(f.dir, MID).filter((e) => e.type === "wave.shipped" && e.data["draft"] === false).length).toBe(2);

      const f2 = fx();
      try {
        const bad: StepRunner = (step) => ({ status: step === "build" ? 1 : 0, timedOut: false, error: null, tail: "" });
        const p2: Array<{ draft: boolean }> = [];
        const r2 = await runWaves(planOf([[u("a")], [u("b")]]), mk(f2, { stepRunner: bad, push: ((a: { draft: boolean }) => { p2.push(a); return { ok: true, url: "u", existing: false }; }) as never }));
        expect(r2.ok).toBe(false);
        expect(r2.blocked).toContain("wave 1 blocked: build");
        expect(p2.map((p) => p.draft)).toEqual([true]);
        expect(r2.waves.length).toBe(1);
      } finally { f2.done(); }
    } finally { f.done(); }
  });

  it("crash then restart: finished units are skipped, an unlogged-but-landed merge is adopted, only the rest run", async () => {
    const f = fx();
    try {
      // Pre-crash log: a completed, b merged but unit.completed never written, c never started.
      f.log.append("unit.started", { unit: "a", model: "sonnet", variant: 0 });
      f.log.append("unit.completed", { unit: "a" });
      f.log.append("unit.started", { unit: "b", model: "sonnet", variant: 0 });
      const ran: string[] = [];
      const merged = new Set(["a", "b"]);
      const restarted = new ModernizeLog(f.dir, MID);
      const r = await runWaves(planOf([[u("a"), u("b"), u("c")]]), mk(f, { log: restarted, ran, merged, resume: true, ship: false }));
      expect(r.ok).toBe(true);
      expect(ran).toEqual(["c"]);
      const done = readModernizeEvents(f.dir, MID).filter((e) => e.type === "unit.completed").map((e) => e.data["unit"]);
      expect(done.sort()).toEqual(["a", "b", "c"]);
    } finally { f.done(); }
  });

  it("resume: prepare (oracle capture) is NOT called for units already logged completed or not_proven", async () => {
    const f = fx();
    try {
      f.log.append("unit.started", { unit: "a", model: "sonnet", variant: 0 });
      f.log.append("unit.completed", { unit: "a" });
      f.log.append("unit.not_proven", { unit: "b", reasons: ["old"] });
      const prepared: string[] = [];
      const restarted = new ModernizeLog(f.dir, MID);
      await runWaves(planOf([[u("a"), u("b"), u("c")]]), mk(f, { log: restarted, resume: true, ship: false, prepare: (x) => { prepared.push(x.id); return null; } }));
      expect(prepared).toEqual(["c"]);
    } finally { f.done(); }
  });

  it("resume: a logged NOT_PROVEN unit is never shipped PROVEN and blocks the next wave", async () => {
    const f = fx();
    try {
      f.log.append("unit.started", { unit: "a", model: "sonnet", variant: 0 });
      f.log.append("unit.not_proven", { unit: "a" });
      const ran: string[] = [];
      const pushes: Array<{ draft: boolean; body?: string }> = [];
      const push = ((a: { draft: boolean }) => { pushes.push(a); return { ok: true, url: "u", existing: false }; }) as never;
      const restarted = new ModernizeLog(f.dir, MID);
      const r = await runWaves(planOf([[u("a")], [u("b")]]), mk(f, { log: restarted, ran, resume: true, push }));
      expect(r.ok).toBe(false);
      expect(r.blocked).toContain("unit a NOT_PROVEN");
      expect(ran).not.toContain("b");
      expect(r.waves.length).toBe(1);
      expect(pushes.map((p) => p.draft)).toEqual([true]);
      expect(JSON.stringify(pushes)).not.toContain("| a | PROVEN |");
    } finally { f.done(); }
  });

  it("a non-PROVEN unit blocks the wave: the next wave never runs", async () => {
    const f = fx();
    try {
      const ran: string[] = [];
      const run = (ctx: AttemptCtx): AttemptOutcome => { ran.push(ctx.unit.id); return { result: { ...proven(ctx.unit.id), verdict: "NOT_PROVEN" }, costUsd: 0 }; };
      const r = await runWaves(planOf([[u("a")], [u("b")]]), mk(f, { run, ship: false }));
      expect(r.ok).toBe(false);
      expect(r.blocked).toContain("unit a");
      expect(ran).not.toContain("b");
    } finally { f.done(); }
  });

  it("makeUnitRunners: the implement env carries no GitHub token", () => {
    const saved = { g: process.env["GH_TOKEN"], h: process.env["GITHUB_TOKEN"] };
    process.env["GH_TOKEN"] = "ghp_secret_one"; process.env["GITHUB_TOKEN"] = "ghp_secret_two";
    try {
      let seen: NodeJS.ProcessEnv = {};
      const r = makeUnitRunners({ target: "python3", session: (_b, _c, env) => { seen = env; return { status: 0 }; } });
      r.implement({ unit: "u", repoDir: tmpdir(), mid: MID, target: "python3", normalizers: { float_tolerance: 0, unordered_fields: [], skip_fields: [] } });
      // Boolean only: a failing toContain on the env would print every variable (secrets) into the log.
      expect(Object.values(seen ?? {}).some((v) => String(v).includes("ghp_secret"))).toBe(false);
      expect(seen["GH_TOKEN"]).not.toBe("ghp_secret_one");
      expect(seen["GITHUB_TOKEN"]).not.toBe("ghp_secret_two");
    } finally {
      if (saved.g === undefined) delete process.env["GH_TOKEN"]; else process.env["GH_TOKEN"] = saved.g;
      if (saved.h === undefined) delete process.env["GITHUB_TOKEN"]; else process.env["GITHUB_TOKEN"] = saved.h;
    }
  });

  it("makeUnitRunners: implement runs the session and a nonzero exit throws; an unknown target fails closed", () => {
    const calls: string[] = [];
    const ok = makeUnitRunners({ target: "python3", session: (brief) => { calls.push(brief); return { status: 0 }; } });
    ok.implement({ unit: "u", repoDir: tmpdir(), mid: MID, target: "python3", normalizers: { float_tolerance: 0, unordered_fields: [], skip_fields: [] } });
    expect(calls[0]).toContain("Modernize unit u to python3");
    const bad = makeUnitRunners({ target: "java21", session: () => ({ status: 3 }) });
    expect(() => bad.implement({ unit: "u", repoDir: tmpdir(), mid: MID, target: "java21", normalizers: { float_tolerance: 0, unordered_fields: [], skip_fields: [] } })).toThrow("exited 3");
    expect(() => bad.runNew("u", tmpdir(), {} as never)).toThrow("no new-tree runner for target java21");
  });
});

describe("M-27E coordinator wiring", () => {
  const ST: StepRunner = () => ({ status: 0, timedOut: false, error: null, tail: "" });
  const gitRepo = (files: string[]): string => {
    const dir = mkdtempSync(join(tmpdir(), "m27e-"));
    safeGit(dir, ["init", "-q", "-b", "main"]);
    for (const f of files) writeFileSync(join(dir, f), "x = 1\n");
    safeGit(dir, ["add", "."]);
    safeGit(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
    return dir;
  };
  const unit1 = (id: string, nodes: string[]): Unit => ({ id, nodes, lines: 1, highRisk: false });

  it("makeAttemptRunner: runUnit gets the base repo, the worktree as newTreeDir, the unit files and a stub runner", () => {
    const f = fx();
    const calls: unknown[][] = [];
    const fake = ((...a: unknown[]) => { calls.push(a); return proven("u-1"); }) as unknown as typeof runUnit;
    const runners = makeUnitRunners({ target: "python3", session: () => ({ status: 0 }) });
    const unit = unit1("u-1", ["pkg/a.py"]);
    const run = makeAttemptRunner({ mid: MID, target: "python3", log: f.log, repoDir: "/base/repo", units: [unit], runners, runUnit: fake });
    run({ unit, model: "sonnet", variant: 0, worker: 1, worktree: "/wt/u-1", baseSha: "abc123" });
    const card = calls[0]![0] as Record<string, unknown>;
    expect(card["repoDir"]).toBe("/base/repo");
    expect(card["newTreeDir"]).toBe("/wt/u-1");
    expect(card["baseSha"]).toBe("abc123");
    expect(card["files"]).toEqual(["pkg/a.py"]);
    expect(typeof calls[0]![5]).toBe("function");
    expect(calls[0]![5]).toBe(runners.runStub);
    f.done();
  });

  it("two waves with real merge ops: wave 2 worktree is based on HEAD after wave 1's merge", async () => {
    const repo = gitRepo(["a.py", "b.py"]);
    const f = fx();
    try {
      const plan = planOf([[unit1("a.py", ["a.py"])], [unit1("b.py", ["b.py"])]]);
      const built = productionWaveDeps({ repoDir: repo, mid: MID, target: "python3", workers: 1, budgetUsd: null, resume: false, noPr: true, inv: buildInventory(repo), plan, log: f.log });
      if (!built.ok) throw new Error(built.reason);
      const seen: Array<{ unit: string; base: string; head: string; sawA: boolean }> = [];
      const run = (ctx: AttemptCtx): AttemptOutcome => {
        seen.push({ unit: ctx.unit.id, base: ctx.baseSha, head: safeGit(ctx.worktree, ["rev-parse", "HEAD"]).trim(), sawA: readFileSync(join(ctx.worktree, "a.py"), "utf8").includes("changed") });
        writeFileSync(join(ctx.worktree, ctx.unit.id), "x = 1  # changed\n");
        return { result: proven(ctx.unit.id), costUsd: 0 };
      };
      const r = await runWaves(plan, { ...built.deps, run, prepare: () => null, stepRunner: ST, waveCommands: { build: { argv: ["true"] }, integration: { argv: ["true"] }, original_suite: { argv: ["true"] } }, worktrees: gitWorktrees });
      expect(r.blocked).toBeNull();
      const headAfterOne = safeGit(repo, ["log", "--format=%H", "-n", "2"]).trim().split("\n")[1]!;
      expect(seen[1]!.base).toBe(headAfterOne);
      expect(seen[1]!.base).not.toBe(seen[0]!.base);
      expect(seen[1]!.head).toBe(headAfterOne);
      expect(seen[1]!.sawA).toBe(true);
    } finally { f.done(); rmSync(repo, { recursive: true, force: true }); }
  });

  it("a unit whose capture fails is NOT_PROVEN with that reason and never reaches the runner", async () => {
    const f = fx();
    try {
      const ran: string[] = [];
      const merged = new Set<string>();
      const deps: WaveDeps = {
        repoDir: f.dir, mid: MID, baseSha: "base", workers: 1, budgetUsd: null, unitEstimateUsd: null, log: f.log,
        run: (c) => { ran.push(c.unit.id); return { result: proven(c.unit.id), costUsd: 0 }; },
        merge: { isMerged: (x) => merged.has(x), merge: (x) => { merged.add(x); } },
        worktrees: f.worktrees, resume: false, waveCommands: { build: { argv: ["true"] } }, stepRunner: ST, ship: false, pinnedOrigin: "",
        prepare: (x) => (x.id === "a" ? "old runtime unavailable" : null),
      };
      const r = await runWaves(planOf([[u("a"), u("b")]]), deps);
      expect(ran).toEqual(["b"]);
      expect(r.ok).toBe(false);
      expect(r.blocked).toContain("unit a NOT_PROVEN");
      expect(r.blocked).toContain("old runtime unavailable");
      const ev = readModernizeEvents(f.dir, MID).find((e) => e.type === "unit.not_proven" && e.data["unit"] === "a");
      expect(JSON.stringify(ev?.data)).toContain("old runtime unavailable");
    } finally { f.done(); }
  });

  it("a 2-node unit is NOT_PROVEN as multi-file and capture is never attempted", () => {
    const f = fx();
    try {
      let called = 0;
      const prep = makeUnitPrep({ repoDir: f.dir, mid: MID, propose: () => [], runtimeOk: () => true, capture: (() => { called++; return { ok: true }; }) as never });
      expect(prep(unit1("u-1", ["a.py", "b.py"]))).toContain("multi-file unit");
      expect(prep(unit1("u-2", ["Main.java"]))).toContain("multi-file unit");
      expect(called).toBe(0);
      expect(prep(unit1("u-3", ["a.py"]))).toBeNull();
      expect(called).toBe(1);
      const failing = makeUnitPrep({ repoDir: f.dir, mid: MID, propose: () => [], runtimeOk: () => true, capture: (() => ({ ok: false, reason: "no cases captured" })) as never });
      expect(failing(unit1("u-4", ["a.py"]))).toBe("no cases captured");
      const noRuntime = makeUnitPrep({ repoDir: f.dir, mid: MID, propose: () => [], runtimeOk: () => false, capture: (() => { called++; return { ok: true }; }) as never });
      expect(noRuntime(unit1("u-5", ["a.py"]))).toBe("old runtime unavailable");
      expect(noRuntime(unit1("u-6", ["a.py", "b.py"]))).toBe("old runtime unavailable");
    } finally { f.done(); }
  });

  it("productionWaveDeps reads build files from the repo dir (F7: not the target string)", () => {
    const repo = gitRepo(["tox.ini", "a.py"]);
    writeFileSync(join(repo, "tox.ini"), "[tox]\n[testenv:integration]\ncommands = true\n");
    const f = fx();
    try {
      const plan = planOf([[unit1("a.py", ["a.py"])]]);
      const built = productionWaveDeps({ repoDir: repo, mid: MID, target: "python3", workers: 1, budgetUsd: null, resume: false, noPr: true, inv: buildInventory(repo), plan, log: f.log });
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      expect(built.deps.waveCommands.build).not.toBeNull();
      expect(built.deps.waveCommands.integration).not.toBeNull();
      expect(built.deps.optionalSteps).toEqual([]);
    } finally { f.done(); rmSync(repo, { recursive: true, force: true }); }
  });

  it("productionWaveDeps on a tmp repo with --no-pr is ok and merges through gitMergeOps without a seam", () => {
    const repo = gitRepo(["a.py"]);
    const f = fx();
    try {
      const plan = planOf([[unit1("a.py", ["a.py"])]]);
      const built = productionWaveDeps({ repoDir: repo, mid: MID, target: "python3", workers: 2, budgetUsd: null, resume: false, noPr: true, inv: buildInventory(repo), plan, log: f.log });
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      expect(built.deps.ship).toBe(false);
      expect(built.deps.merge.isMerged("a.py")).toBe(false);
      expect(built.deps.optionalSteps).toEqual(["integration"]);
      expect(built.deps.baseSha).toBe(safeGit(repo, ["rev-parse", "HEAD"]).trim());
      const src = readFileSync(join(import.meta.dir, "..", "..", "..", "src", "util", "modernize_coordinator.ts"), "utf8");
      expect(src).toContain("gitMergeOps(o.repoDir, o.mid)");
      expect(src).not.toMatch(/gitMergeOps\([^)]*isMerged/);
      const noRepo = productionWaveDeps({ repoDir: f.dir, mid: MID, target: "python3", workers: 2, budgetUsd: null, resume: false, noPr: true, inv: buildInventory(f.dir), plan, log: f.log });
      expect(noRepo.ok).toBe(false);
    } finally { f.done(); rmSync(repo, { recursive: true, force: true }); }
  });

  it("scopes the python build step to the wave's changed .py files and keeps the excludes (M-27F)", async () => {
    const f = fx();
    try {
      writeFileSync(join(f.dir, "a.py"), "x = 1\n"); writeFileSync(join(f.dir, "b.py"), "y = 2\n");
      const build = { argv: ["python3", "-m", "compileall", "-q", "-x", "/(\\.loki|\\.venv|venv|node_modules|\\.tox|\\.git)/", "."] };
      const seen: string[][] = [];
      const spy: StepRunner = (step, c) => { if (step === "build") seen.push(c.argv); return { status: 0, timedOut: false, error: null, tail: "" }; };
      const mkd = { repoDir: f.dir, mid: MID, baseSha: "base", workers: 1, budgetUsd: null, unitEstimateUsd: null, log: f.log, run: (ctx: AttemptCtx): AttemptOutcome => ({ result: proven(ctx.unit.id), costUsd: 0 }), merge: { isMerged: () => false, merge: () => {} }, worktrees: f.worktrees, resume: false, waveCommands: { build, integration: { argv: ["true"] }, original_suite: { argv: ["true"] } }, stepRunner: spy, ship: false, pinnedOrigin: "" } as WaveDeps;
      await runWaves(planOf([[u("a.py")], [u("b.py"), u("gone.py")]]), mkd);
      expect(seen).toEqual([
        [...build.argv.slice(0, 6), "a.py"],
        [...build.argv.slice(0, 6), "b.py"],
      ]);
    } finally { f.done(); }
  });

  it("makeProposeSession runs the injected session in a.cwd with a token-free env and throws on a nonzero exit (M-27F)", () => {
    const calls: { brief: string; cwd: string; env: NodeJS.ProcessEnv }[] = [];
    let status = 0;
    const session = ((brief: string, cwd: string, env: NodeJS.ProcessEnv) => { calls.push({ brief, cwd, env }); return { status }; }) as never;
    const prev = process.env["GITHUB_TOKEN"];
    process.env["GITHUB_TOKEN"] = "ghp_secret";
    try {
      const propose = makeProposeSession({ mid: MID, provider: "claude", session });
      const a = { cwd: "/work/dir", env: {}, unitFile: "/work/dir/u.py", missing: [{ line: 3, outcome: "true" as const }], round: 2 };
      propose(a);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.cwd).toBe("/work/dir");
      expect(calls[0]!.brief).toContain("/work/dir/u.py");
      expect(calls[0]!.brief).toContain("round 2");
      expect(calls[0]!.brief).toContain('"line":3');
      expect(JSON.stringify(calls[0]!.env)).not.toContain("ghp_secret");
      status = 3;
      expect(() => propose(a)).toThrow("propose session exited 3");
    } finally {
      if (prev === undefined) delete process.env["GITHUB_TOKEN"]; else process.env["GITHUB_TOKEN"] = prev;
    }
  });
});
