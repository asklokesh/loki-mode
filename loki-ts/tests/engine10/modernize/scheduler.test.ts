// M-17 wall: scheduler policy (cascade, best-of-2, workers, budget stop, id safety, single writer).
import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClusterResult, Unit } from "../../../src/engine10/modernize/cluster.ts";
import { ModernizeLog, readModernizeEvents } from "../../../src/engine10/modernize/log.ts";
import { clampWorkers, gitWorktrees, schedule } from "../../../src/engine10/modernize/scheduler.ts";
import type { AttemptCtx, AttemptOutcome, WorktreeOps } from "../../../src/engine10/modernize/scheduler.ts";
import type { UnitRunResult } from "../../../src/engine10/modernize/unit.ts";

const MID = "mod-20260101T000000Z-abcdef";
const u = (id: string, highRisk = false): Unit => ({ id, nodes: [id], lines: 1, highRisk });
const res = (unit: string, verdict: UnitRunResult["verdict"]): UnitRunResult => ({
  unit, verdict, oracle: null, wall: null, equiv: null, not_proven: [], conformance: null,
});
const planOf = (waves: Unit[][]): ClusterResult => ({ units: waves.flat(), waves: waves.map((w) => w.map((x) => x.id)) });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "m17-"));
  const created: string[] = [];
  const removed: string[] = [];
  const seq: string[] = [];
  const worktrees: WorktreeOps = {
    create: (_r, p) => { created.push(p); seq.push(`create ${p}`); },
    remove: (_r, p) => { removed.push(p); seq.push(`remove ${p}`); },
  };
  const log = new ModernizeLog(dir, MID);
  const base = { repoDir: dir, mid: MID, baseSha: "abc123", log, worktrees, unitEstimateUsd: null as number | null, budgetUsd: null as number | null, workers: 2 };
  return { dir, created, removed, seq, log, base, done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("scheduler", () => {
  it("clamps workers to 1..32 and defaults on NaN", () => {
    expect(clampWorkers(0)).toBe(1);
    expect(clampWorkers(99)).toBe(32);
    expect(clampWorkers(NaN)).toBe(4);
  });

  it("cascade: sonnet first, opus on failure; high-risk goes straight to opus", async () => {
    const f = fixture();
    const seen: Array<[string, string, number]> = [];
    const run = (c: AttemptCtx): AttemptOutcome => {
      seen.push([c.unit.id, c.model, c.variant]);
      return { result: res(c.unit.id, c.unit.id === "a" && c.model === "sonnet" ? "NOT_EQUAL" : "PROVEN"), costUsd: 1 };
    };
    const r = await schedule(planOf([[u("a"), u("hot", true)]]), { ...f.base, run, workers: 1 });
    expect(seen).toContainEqual(["a", "sonnet", 0]);
    expect(seen).toContainEqual(["a", "opus", 1]);
    expect(seen).toContainEqual(["hot", "opus", 0]);
    expect(seen.filter((s) => s[0] === "a").length).toBe(2);
    expect(r.outcomes.every((o) => o.status === "PROVEN")).toBe(true);
    f.done();
  });

  it("best-of-2: a fully failing unit needs reslice and is never forced", async () => {
    const f = fixture();
    const run = (c: AttemptCtx): AttemptOutcome => ({ result: res(c.unit.id, "NOT_EQUAL"), costUsd: 0.1 });
    const r = await schedule(planOf([[u("x")]]), { ...f.base, run });
    const o = r.outcomes[0]!;
    expect(o.attempts).toBe(3);
    expect(o.status).toBe("NOT_EQUAL");
    expect(o.needsReslice).toBe(true);
    expect(o.worktree).toBeNull();
    expect(f.created.length).toBe(3);
    const ev = readModernizeEvents(f.dir, MID);
    expect(ev.filter((e) => e.type === "unit.variant").length).toBe(2);
    f.done();
  });

  it("every attempt gets a fresh worktree; proven keeps its own, losers are removed", async () => {
    const f = fixture();
    const run = (c: AttemptCtx): AttemptOutcome => ({ result: res(c.unit.id, c.variant === 2 ? "PROVEN" : "NOT_PROVEN"), costUsd: 0 });
    const r = await schedule(planOf([[u("y")]]), { ...f.base, run });
    expect(new Set(f.created).size).toBe(3);
    expect(r.outcomes[0]!.worktree).toBe(f.created[2]!);
    expect(f.removed).toContain(f.created[0]!);
    // Each loser is removed after its run (a second remove after the create).
    for (const loser of [f.created[0]!, f.created[1]!]) {
      const idx = f.seq.map((s, i) => (s === `remove ${loser}` ? i : -1)).filter((i) => i >= 0);
      expect(idx.length).toBe(2);
      expect(f.seq[idx[0]! + 1]).toBe(`create ${loser}`);
      expect(idx[1]!).toBeGreaterThan(idx[0]! + 1);
    }
    expect(f.seq.filter((s) => s === `remove ${f.created[2]!}`).length).toBe(1);
    expect(f.created[0]!).toContain(join(".loki", "modernize", MID, "wt"));
    f.done();
  });

  it("a PROVEN result keeps its FC-24 runner_reported conformance unchanged", async () => {
    const f = fixture();
    const conformance = { trust: "runner_reported", limit: "FC-24" } as unknown as UnitRunResult["conformance"];
    const run = (c: AttemptCtx): AttemptOutcome => ({ result: { ...res(c.unit.id, "PROVEN"), conformance }, costUsd: 0 });
    const r = await schedule(planOf([[u("a")]]), { ...f.base, run });
    expect(r.outcomes[0]!.result!.conformance).toEqual({ trust: "runner_reported", limit: "FC-24" });
    f.done();
  });

  it("unit.started carries run_id when the option is set", async () => {
    const f = fixture();
    const run = (c: AttemptCtx): AttemptOutcome => ({ result: res(c.unit.id, "PROVEN"), costUsd: 0 });
    await schedule(planOf([[u("a")]]), { ...f.base, run, runId: "run-7" });
    const ev = readModernizeEvents(f.dir, MID).find((e) => e.type === "unit.started")!;
    expect(ev.data).toMatchObject({ run_id: "run-7" });
    f.done();
  });

  it("variant paths cannot collide: 'a.v1' at variant 0 differs from 'a' at variant 1", async () => {
    const f = fixture();
    const run = (c: AttemptCtx): AttemptOutcome => ({ result: res(c.unit.id, c.unit.id === "a" && c.variant < 1 ? "NOT_EQUAL" : "PROVEN"), costUsd: 0 });
    await schedule(planOf([[u("a"), u("a.v1")]]), { ...f.base, run, workers: 1 });
    expect(new Set(f.created).size).toBe(f.created.length);
    expect(f.created.length).toBe(3);
    f.done();
  });

  it("cascade stop does not double-count the current unit in flight", async () => {
    const f = fixture();
    // budget 3, estimate 1, one unit failing twice at cost 1: spent 1 + inFlight(1) = 2 <= 3, so attempt 2 runs.
    const run = (c: AttemptCtx): AttemptOutcome => ({ result: res(c.unit.id, c.variant < 2 ? "NOT_EQUAL" : "PROVEN"), costUsd: 1 });
    const r = await schedule(planOf([[u("a")]]), { ...f.base, run, workers: 1, budgetUsd: 3, unitEstimateUsd: 1 });
    expect(r.outcomes[0]!.attempts).toBe(3);
    expect(r.outcomes[0]!.status).toBe("PROVEN");
    f.done();
  });

  it("budget with no estimate: stops dispatch once spent exceeds it, budget.hit once", async () => {
    const f = fixture();
    const run = (c: AttemptCtx): AttemptOutcome => ({ result: res(c.unit.id, "PROVEN"), costUsd: 1 });
    const r = await schedule(planOf([[u("a"), u("b"), u("c"), u("d")]]), { ...f.base, run, workers: 1, budgetUsd: 1.5, unitEstimateUsd: null });
    expect(r.outcomes.filter((o) => o.status === "PROVEN").length).toBe(2);
    expect(r.outcomes.filter((o) => o.status === "SKIPPED_BUDGET").length).toBe(2);
    expect(readModernizeEvents(f.dir, MID).filter((e) => e.type === "budget.hit").length).toBe(1);
    f.done();
  });

  it("never runs more than N units at once and waves are sequential", async () => {
    const f = fixture();
    let live = 0, peak = 0;
    const order: string[] = [];
    const run = async (c: AttemptCtx): Promise<AttemptOutcome> => {
      live++; peak = Math.max(peak, live); order.push(c.unit.id);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return { result: res(c.unit.id, "PROVEN"), costUsd: 0 };
    };
    await schedule(planOf([[u("a"), u("b"), u("c"), u("d")], [u("e")]]), { ...f.base, run, workers: 2 });
    expect(peak).toBe(2);
    expect(order[4]).toBe("e");
    f.done();
  });

  it("budget stop: emits budget.hit once, finishes in-flight, skips the rest", async () => {
    const f = fixture();
    const run = async (c: AttemptCtx): Promise<AttemptOutcome> => {
      await new Promise((r) => setTimeout(r, 5));
      return { result: res(c.unit.id, "PROVEN"), costUsd: 1 };
    };
    const r = await schedule(planOf([[u("a"), u("b"), u("c"), u("d")]]), { ...f.base, run, workers: 2, budgetUsd: 2.5, unitEstimateUsd: 1 });
    expect(r.outcomes.filter((o) => o.status === "PROVEN").length).toBe(2);
    expect(r.outcomes.filter((o) => o.status === "SKIPPED_BUDGET").length).toBe(2);
    expect(r.budgetHit).toBe(true);
    expect(r.spentUsd).toBe(2);
    expect(readModernizeEvents(f.dir, MID).filter((e) => e.type === "budget.hit").length).toBe(1);
    f.done();
  });

  it("a runner cannot hide spend: a negative cost is charged at the estimate", async () => {
    const f = fixture();
    const run = (c: AttemptCtx): AttemptOutcome => ({ result: res(c.unit.id, "PROVEN"), costUsd: -50 });
    const r = await schedule(planOf([[u("a"), u("b")]]), { ...f.base, run, workers: 1, unitEstimateUsd: 2 });
    expect(r.spentUsd).toBe(4);
    f.done();
  });

  it("per-unit cost cap (estimate x 3) stops further attempts for that unit", async () => {
    const f = fixture();
    const run = (c: AttemptCtx): AttemptOutcome => ({ result: res(c.unit.id, "NOT_EQUAL"), costUsd: 3 });
    const r = await schedule(planOf([[u("a")]]), { ...f.base, run, unitEstimateUsd: 1 });
    expect(r.outcomes[0]!.attempts).toBe(1);
    expect(r.outcomes[0]!.reason).toBe("per-unit cost cap reached");
    expect(r.outcomes[0]!.needsReslice).toBe(false);
    f.done();
  });

  it("a throwing runner is NOT_PROVEN, not a crash; unsafe unit ids never reach a worktree", async () => {
    const f = fixture();
    const run = (c: AttemptCtx): AttemptOutcome => {
      if (c.unit.id === "boom") throw new Error("kaboom");
      return { result: res(c.unit.id, "PROVEN"), costUsd: 0 };
    };
    const r = await schedule(planOf([[u("boom"), u("../evil"), u("ok")]]), { ...f.base, run });
    const by = Object.fromEntries(r.outcomes.map((o) => [o.unit, o]));
    expect(by["boom"]!.status).toBe("NOT_PROVEN");
    expect(by["../evil"]!.attempts).toBe(0);
    expect(by["ok"]!.status).toBe("PROVEN");
    expect(f.created.some((p) => p.includes(".."))).toBe(false);
    f.done();
  });

  it("coordinator is the single log writer: unit.started carries model and worker", async () => {
    const f = fixture();
    const run = (c: AttemptCtx): AttemptOutcome => ({ result: res(c.unit.id, "PROVEN"), costUsd: 0 });
    await schedule(planOf([[u("a")]]), { ...f.base, run, workers: 1 });
    const ev = readModernizeEvents(f.dir, MID);
    expect(ev.map((e) => e.type)).toEqual(["wave.started", "unit.started"]);
    expect(ev[1]!.data).toMatchObject({ unit: "a", model: "sonnet", worker: 1 });
    f.done();
  });

  it("gitWorktrees.create does not run a hook planted in the common git dir, and withholds the token (FC-25)", () => {
    const repo = mkdtempSync(join(tmpdir(), "m17-git-"));
    const marker = join(repo, "HOOK_RAN");
    const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    g("init", "-q");
    writeFileSync(join(repo, "f"), "x");
    g("add", "f");
    g("commit", "-q", "-m", "i", "--no-gpg-sign");
    const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
    const hook = join(repo, ".git", "hooks", "post-checkout");
    writeFileSync(hook, `#!/bin/sh\necho "$GH_TOKEN" > "${marker}"\n`);
    chmodSync(hook, 0o755);
    const prev = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "secret-token-value";
    try {
      gitWorktrees.create(repo, join(repo, "wt2"), sha);
      expect(existsSync(join(repo, "wt2", "f"))).toBe(true);
      expect(existsSync(marker)).toBe(false);
      gitWorktrees.remove(repo, join(repo, "wt2"));
    } finally {
      if (prev === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = prev;
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
