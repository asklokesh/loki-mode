// M-17 wall: scheduler policy (cascade, best-of-2, workers, budget stop, id safety, single writer).
import { modelRank } from "../../../src/runner/model_rank.ts";
import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClusterResult, Unit } from "../../../src/engine10/modernize/cluster.ts";
import { ModernizeLog, readModernizeEvents } from "../../../src/engine10/modernize/log.ts";
import { clampWorkers, gitMergeOps, gitWorktrees, mergeOnce, schedule } from "../../../src/engine10/modernize/scheduler.ts";
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
    const conformance: UnitRunResult["conformance"] = { trust: "runner_reported", limit: "FC-24", tests: 3 };
    const run = (c: AttemptCtx): AttemptOutcome => ({ result: { ...res(c.unit.id, "PROVEN"), conformance }, costUsd: 0 });
    const r = await schedule(planOf([[u("a")]]), { ...f.base, run });
    expect(r.outcomes[0]!.result!.conformance).toEqual({ trust: "runner_reported", limit: "FC-24", tests: 3 });
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

  it("budget with no estimate: an unreported (NaN) cost fails closed and stops dispatch", async () => {
    const f = fixture();
    try {
      const ran: string[] = [];
      const run = (ctx: AttemptCtx): AttemptOutcome => { ran.push(ctx.unit.id); return { result: res(ctx.unit.id, "PROVEN"), costUsd: NaN }; };
      const r = await schedule(planOf([[u("a"), u("b"), u("c")]]), { ...f.base, run, workers: 1, budgetUsd: 1.5, unitEstimateUsd: null });
      expect(ran).toEqual(["a"]);
      expect(r.budgetHit).toBe(true);
    } finally { f.done(); }
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

  it("a nested unit id (legacy/calc.py) is accepted and its worktree name is one encoded path segment", async () => {
    const f = fixture();
    const run = (c: AttemptCtx): AttemptOutcome => ({ result: res(c.unit.id, "PROVEN"), costUsd: 0 });
    const r = await schedule(planOf([[u("legacy/calc.py"), u("/abs"), u("a//b"), u("a\\b"), u("a/../b"), u("a/")]]), { ...f.base, run });
    const by = Object.fromEntries(r.outcomes.map((o) => [o.unit, o]));
    expect(by["legacy/calc.py"]!.status).toBe("PROVEN");
    for (const bad of ["/abs", "a//b", "a\\b", "a/../b", "a/"]) expect(by[bad]!.attempts).toBe(0);
    expect(f.created).toHaveLength(1);
    expect(f.created[0]!.endsWith(join("wt", "legacy%2Fcalc.py"))).toBe(true);
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

  describe("gitMergeOps (M-27B)", () => {
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", env }).trim();
    function setup() {
      const repo = mkdtempSync(join(tmpdir(), "m27b-"));
      git(repo, "init", "-q");
      writeFileSync(join(repo, "f"), "base\n");
      git(repo, "add", "f");
      git(repo, "commit", "-q", "-m", "i", "--no-gpg-sign");
      const base = git(repo, "rev-parse", "HEAD");
      const wt = (name: string) => { const p = join(repo, "wt-" + name); gitWorktrees.create(repo, p, base); return p; };
      const log = new ModernizeLog(repo, MID);
      return { repo, wt, log, ops: gitMergeOps(repo, MID), done: () => rmSync(repo, { recursive: true, force: true }) };
    }

    it("lands a PROVEN unit on HEAD, isMerged true, second mergeOnce adopts", () => {
      const s = setup();
      try {
        const w = s.wt("a");
        writeFileSync(join(w, "g"), "new\n");
        expect(s.ops.isMerged("a")).toBe(false);
        expect(mergeOnce("a", s.ops, s.log, new Set(), w)).toBe("merged");
        expect(readFileSync(join(s.repo, "g"), "utf8")).toBe("new\n");
        expect(git(s.repo, "log", "-1", "--format=%B")).toContain(`Loki-Modernize-Unit: ${MID}/a`);
        expect(s.ops.isMerged("a")).toBe(true);
        expect(mergeOnce("a", s.ops, s.log, new Set(), w)).toBe("adopted");
      } finally { s.done(); }
    });

    it("records a no-op unit, and merging ab does not make a merged", () => {
      const s = setup();
      try {
        s.ops.merge("ab", s.wt("ab"));
        expect(s.ops.isMerged("ab")).toBe(true);
        expect(s.ops.isMerged("a")).toBe(false);
      } finally { s.done(); }
    });

    it("conflict throws, HEAD unchanged, no cherry-pick in progress; fails closed on bad inputs", () => {
      const s = setup();
      try {
        const w = s.wt("c");
        writeFileSync(join(w, "f"), "unit\n");
        writeFileSync(join(s.repo, "f"), "other\n");
        git(s.repo, "commit", "-aqm", "other", "--no-gpg-sign");
        const head = git(s.repo, "rev-parse", "HEAD");
        expect(() => s.ops.merge("c", w)).toThrow("merge refused on c");
        expect(git(s.repo, "rev-parse", "HEAD")).toBe(head);
        expect(existsSync(join(s.repo, ".git", "CHERRY_PICK_HEAD"))).toBe(false);
        expect(() => s.ops.merge("c")).toThrow();
        writeFileSync(join(s.repo, "f"), "dirty\n");
        expect(() => s.ops.merge("c", w)).toThrow("repo not clean");
        git(s.repo, "checkout", "-q", "--", "f");
        git(s.repo, "checkout", "-q", "--detach");
        expect(() => s.ops.merge("c", w)).toThrow("detached");
      } finally { s.done(); }
    });

    it("squashes earlier worktree commits and uncommitted files into one merge", () => {
      const s = setup();
      try {
        const w = s.wt("s");
        writeFileSync(join(w, "agent.py"), "1");
        git(w, "add", "agent.py");
        git(w, "commit", "-qm", "runner", "--no-gpg-sign");
        writeFileSync(join(w, "late.py"), "2");
        s.ops.merge("s", w);
        expect(readFileSync(join(s.repo, "agent.py"), "utf8")).toBe("1");
        expect(readFileSync(join(s.repo, "late.py"), "utf8")).toBe("2");
        expect(s.ops.isMerged("s")).toBe(true);
      } finally { s.done(); }
    });

    it("ignores repo trailer.separators config, and rejects unsafe unit or merge ids", () => {
      const s = setup();
      try {
        const w = s.wt("t");
        git(s.repo, "config", "trailer.separators", "#");
        s.ops.merge("t", w);
        expect(s.ops.isMerged("t")).toBe(true);
        expect(() => s.ops.merge("x\nLoki-Modernize-Unit: " + MID + "/y", w)).toThrow("unsafe");
        expect(() => s.ops.isMerged("../x")).toThrow("unsafe");
        expect(() => gitMergeOps(s.repo, "bad").isMerged("a")).toThrow("unsafe");
      } finally { s.done(); }
    });

    it("drops runner-committed excluded paths from the squash", () => {
      const s = setup();
      try {
        const w = s.wt("rc");
        mkdirSync(join(w, ".loki"), { recursive: true });
        mkdirSync(join(w, "pkg", "__pycache__"), { recursive: true });
        writeFileSync(join(w, ".loki", "state.json"), "{}");
        writeFileSync(join(w, "pkg", "__pycache__", "m.pyc"), "x");
        writeFileSync(join(w, "pkg", "m.py"), "1");
        git(w, "add", "-f", ".");
        git(w, "commit", "-qm", "runner", "--no-gpg-sign");
        s.ops.merge("rc", w);
        const files = git(s.repo, "ls-files");
        expect(files).toContain("pkg/m.py");
        expect(files).not.toContain(".loki");
        expect(files).not.toContain("__pycache__");
      } finally { s.done(); }
    });

    it("keeps the trailer under commit.cleanup=strip and core.commentChar=L", () => {
      const s = setup();
      try {
        git(s.repo, "config", "commit.cleanup", "strip");
        git(s.repo, "config", "core.commentChar", "L");
        const w = s.wt("cl");
        git(w, "config", "commit.cleanup", "strip");
        git(w, "config", "core.commentChar", "L");
        writeFileSync(join(w, "g"), "n");
        s.ops.merge("cl", w);
        expect(s.ops.isMerged("cl")).toBe(true);
      } finally { s.done(); }
    });

    it("excludes .loki and caches at any depth", () => {
      const s = setup();
      try {
        const w = s.wt("d");
        for (const d of ["pkg/.pytest_cache", "pkg/.loki"]) {
          mkdirSync(join(w, d), { recursive: true });
          writeFileSync(join(w, d, "x"), "1");
        }
        writeFileSync(join(w, "pkg", "ok.py"), "1");
        s.ops.merge("d", w);
        const files = git(s.repo, "ls-files");
        expect(files).toContain("pkg/ok.py");
        expect(files).not.toContain(".pytest_cache");
        expect(files).not.toContain(".loki");
      } finally { s.done(); }
    });

    it("never commits .loki or __pycache__", () => {
      const s = setup();
      try {
        const w = s.wt("p");
        mkdirSync(join(w, ".loki"));
        mkdirSync(join(w, "pkg", "__pycache__"), { recursive: true });
        mkdirSync(join(w, "__pycache__"));
        writeFileSync(join(w, "__pycache__", "t.pyc"), "1");
        writeFileSync(join(w, ".loki", "x"), "1");
        writeFileSync(join(w, "pkg", "__pycache__", "m.pyc"), "1");
        writeFileSync(join(w, "pkg", "m.py"), "1");
        s.ops.merge("p", w);
        const files = git(s.repo, "ls-files");
        expect(files).toContain("pkg/m.py");
        expect(files).not.toContain(".loki");
        expect(files).not.toContain("__pycache__");
      } finally { s.done(); }
    });

    it("keeps a base-tracked excluded path unchanged through the squash", () => {
      const s = setup();
      try {
        mkdirSync(join(s.repo, "pkg", "__pycache__"), { recursive: true });
        writeFileSync(join(s.repo, "pkg", "__pycache__", "old.pyc"), "old");
        git(s.repo, "add", "-f", "pkg/__pycache__/old.pyc");
        git(s.repo, "commit", "-qm", "legacy", "--no-gpg-sign");
        const base = git(s.repo, "rev-parse", "HEAD");
        const w = join(s.repo, "wt-leg");
        gitWorktrees.create(s.repo, w, base);
        writeFileSync(join(w, "n.py"), "1");
        s.ops.merge("leg", w);
        expect(git(s.repo, "diff", "--name-status", "-M", base, "HEAD")).toBe("A\tn.py");
        expect(git(s.repo, "ls-files")).toContain("pkg/__pycache__/old.pyc");
        expect(readFileSync(join(s.repo, "pkg", "__pycache__", "old.pyc"), "utf8")).toBe("old");
      } finally { s.done(); }
    });

    it("rolls back the commit when the trailer check fails after cherry-pick", () => {
      const s = setup();
      try {
        const w = s.wt("rb");
        writeFileSync(join(w, "g"), "1");
        const pre = git(s.repo, "rev-parse", "HEAD");
        const ops = gitMergeOps(s.repo, MID, { isMerged: () => false });
        expect(() => ops.merge("rb", w)).toThrow("trailer missing");
        expect(git(s.repo, "rev-parse", "HEAD")).toBe(pre);
        expect(existsSync(join(s.repo, "g"))).toBe(false);
      } finally { s.done(); }
    });

    it("does not run a hook planted in the common git dir", () => {
      const s = setup();
      try {
        const w = s.wt("h");
        const marker = join(s.repo, "HOOK_RAN");
        mkdirSync(join(s.repo, ".git", "hooks"), { recursive: true });
        for (const h of ["pre-commit", "commit-msg", "post-commit", "post-merge", "post-rewrite"]) {
          writeFileSync(join(s.repo, ".git", "hooks", h), `#!/bin/sh\necho x > "${marker}"\n`);
          chmodSync(join(s.repo, ".git", "hooks", h), 0o755);
        }
        writeFileSync(join(w, "g"), "1");
        s.ops.merge("h", w);
        expect(existsSync(marker)).toBe(false);
      } finally { s.done(); }
    });
  });
});

describe("NBR-G3 unit attempts never run below the run model", () => {
  it("every attempt of every unit floors at the run model; a sonnet run model keeps the cascade", async () => {
    for (const [runModel, first, next] of [["opus", "opus", "opus"], ["fable", "fable", "fable"], ["sonnet", "sonnet", "opus"], ["haiku", "sonnet", "opus"]] as const) {
      const f = fixture();
      const seen: Array<[string, string, number]> = [];
      const run = (c: AttemptCtx): AttemptOutcome => {
        seen.push([c.unit.id, c.model, c.variant]);
        return { result: res(c.unit.id, c.unit.id === "a" && c.variant === 0 ? "NOT_EQUAL" : "PROVEN"), costUsd: 1 };
      };
      await schedule(planOf([[u("a"), u("hot", true)]]), { ...f.base, run, workers: 1, runModel });
      expect(seen).toContainEqual(["a", first, 0]);
      expect(seen).toContainEqual(["a", next, 1]);
      expect(seen.every(([, m]) => modelRank(m) >= modelRank(runModel))).toBe(true);
      f.done();
    }
  });
});
