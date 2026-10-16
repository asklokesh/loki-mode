// M-22 wall: unit-level resume after a coordinator crash (docs/v10/MODERNIZE.md sections 3.7 and 5).
import { describe, expect, it } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClusterResult, Unit } from "../../../src/engine10/modernize/cluster.ts";
import { ModernizeLog, readModernizeEvents } from "../../../src/engine10/modernize/log.ts";
import { loadResumeState, mergeOnce, planResume, resumeSchedule } from "../../../src/engine10/modernize/resume.ts";
import type { MergeOps } from "../../../src/engine10/modernize/resume.ts";
import { schedule } from "../../../src/engine10/modernize/scheduler.ts";
import type { AttemptCtx, AttemptOutcome, WorktreeOps } from "../../../src/engine10/modernize/scheduler.ts";
import type { UnitRunResult } from "../../../src/engine10/modernize/unit.ts";
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
