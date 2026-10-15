// loki-ts/src/engine10/modernize/scheduler.ts -- M-17: the local unit scheduler (docs/v10/MODERNIZE.md
// section 3.4, D30). N workers under one coordinator. The coordinator is the modernize log's only
// writer: workers return values, they never touch the log. Per unit: model cascade (sonnet first,
// opus on a failed check or for a high-risk unit), best-of-2 after one failure, a fresh worktree per
// attempt, and a budget stop that finishes in-flight units. The unit run itself (runUnit, M-15) and
// the git calls are injected, so the policy here is tested without a model or a repo.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { ClusterResult, Unit } from "./cluster.ts";
import { budgetExceeded } from "./estimate.ts";
import type { ModernizeLog } from "./log.ts";
import { modernizeRoot } from "./types.ts";
import type { UnitRunResult } from "./unit.ts";

export type Model = "sonnet" | "opus";
export const MAX_LOCAL_WORKERS = 32;
export const DEFAULT_WORKERS = 4;
/** Section 3.4: per-unit cost cap is the estimate x 3. */
export const UNIT_COST_CAP_FACTOR = 3;

const UNIT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export interface AttemptCtx {
  unit: Unit;
  model: Model;
  /** 0 = first attempt, 1 and 2 = the best-of-2 variants. */
  variant: 0 | 1 | 2;
  worker: number;
  worktree: string;
  baseSha: string;
}
export interface AttemptOutcome {
  result: UnitRunResult;
  costUsd: number;
}
/** Runs one attempt inside ctx.worktree. MAY throw or reject: that attempt is NOT_PROVEN, never a crash. */
export type AttemptRunner = (ctx: AttemptCtx) => AttemptOutcome | Promise<AttemptOutcome>;

export interface WorktreeOps {
  create(repoDir: string, path: string, baseSha: string): void;
  remove(repoDir: string, path: string): void;
}

/** Real git worktrees. Argument arrays only (no shell), detached at the recorded base. */
export const gitWorktrees: WorktreeOps = {
  create(repoDir, path, baseSha) {
    execFileSync("git", ["-C", repoDir, "worktree", "add", "--detach", "--force", path, baseSha], { stdio: "ignore" });
  },
  remove(repoDir, path) {
    try {
      execFileSync("git", ["-C", repoDir, "worktree", "remove", "--force", path], { stdio: "ignore" });
    } catch { /* already gone */ }
  },
};

export interface SchedulerOpts {
  repoDir: string;
  mid: string;
  baseSha: string;
  workers: number;
  budgetUsd: number | null;
  /** Per-unit estimate from estimate.json; null = unmeasured (no budget stop, no per-unit cap). */
  unitEstimateUsd: number | null;
  log: ModernizeLog;
  run: AttemptRunner;
  worktrees?: WorktreeOps;
}

export type UnitStatus = "PROVEN" | "NOT_EQUAL" | "NOT_PROVEN" | "SKIPPED_BUDGET";
export interface UnitOutcome {
  unit: string;
  status: UnitStatus;
  attempts: number;
  costUsd: number;
  result: UnitRunResult | null;
  /** Kept only for a PROVEN unit; every other attempt worktree is removed. */
  worktree: string | null;
  /** True when the unit failed best-of-2: the caller re-slices it (M-18), it is never force-passed. */
  needsReslice: boolean;
  reason?: string;
}
export interface ScheduleReport {
  outcomes: UnitOutcome[];
  spentUsd: number;
  budgetHit: boolean;
}

export function clampWorkers(n: number): number {
  return Number.isFinite(n) ? Math.min(MAX_LOCAL_WORKERS, Math.max(1, Math.floor(n))) : DEFAULT_WORKERS;
}

/** First attempt's model: top legacy-risk units go straight to opus, everything else sonnet. */
export function firstModel(unit: Unit): Model {
  return unit.highRisk ? "opus" : "sonnet";
}

/** Runs the plan wave by wave (a wave's units are independent; the next wave needs this one). */
export async function schedule(plan: ClusterResult, opts: SchedulerOpts): Promise<ScheduleReport> {
  const wt = opts.worktrees ?? gitWorktrees;
  const workers = clampWorkers(opts.workers);
  const byId = new Map(plan.units.map((u) => [u.id, u]));
  const est = opts.unitEstimateUsd;
  const cap = est == null ? null : est * UNIT_COST_CAP_FACTOR;
  const outcomes: UnitOutcome[] = [];
  let spent = 0;
  let inFlight = 0;
  let hit = false;

  const stopped = (): boolean => {
    if (hit) return true;
    // Dispatch gate: what is spent plus what is already running plus this one must fit the budget.
    if (budgetExceeded(spent, est == null ? null : (inFlight + 1) * est, opts.budgetUsd)) {
      hit = true;
      opts.log.append("budget.hit", { budget_usd: opts.budgetUsd, spent_usd: spent, in_flight: inFlight });
    }
    return hit;
  };

  const skipped = (unit: string, reason: string): UnitOutcome => ({
    unit, status: "SKIPPED_BUDGET", attempts: 0, costUsd: 0, result: null, worktree: null, needsReslice: false, reason,
  });

  async function runUnitCascade(unit: Unit, worker: number): Promise<UnitOutcome> {
    if (!UNIT_ID_RE.test(unit.id)) {
      return { unit: unit.id, status: "NOT_PROVEN", attempts: 0, costUsd: 0, result: null, worktree: null, needsReslice: false, reason: "unit id is not a safe path segment" };
    }
    let unitCost = 0;
    let attempts = 0;
    let last: UnitRunResult | null = null;
    let reason: string | undefined;
    // Cascade: attempt 0 on the routed model; after a failed check, both best-of-2 variants on opus.
    const steps: Array<[0 | 1 | 2, Model]> = [[0, firstModel(unit)], [1, "opus"], [2, "opus"]];
    for (const [variant, model] of steps) {
      if (attempts > 0 && (stopped() || (cap != null && unitCost >= cap))) {
        reason = hit ? "budget stop" : "per-unit cost cap reached";
        break;
      }
      const path = join(modernizeRoot(opts.repoDir, opts.mid), "wt", variant === 0 ? unit.id : `${unit.id}.v${variant}`);
      let outcome: AttemptOutcome;
      attempts++;
      opts.log.append("unit.started", { unit: unit.id, model, worker, variant });
      if (variant > 0) opts.log.append("unit.variant", { unit: unit.id, variant, model });
      try {
        wt.remove(opts.repoDir, path);
        wt.create(opts.repoDir, path, opts.baseSha);
        outcome = await opts.run({ unit, model, variant, worker, worktree: path, baseSha: opts.baseSha });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        outcome = {
          result: { unit: unit.id, verdict: "NOT_PROVEN", oracle: null, wall: null, equiv: null, not_proven: [`attempt failed: ${msg}`], conformance: null },
          costUsd: NaN,
        };
      }
      // A runner cannot hide spend: a missing, negative or non-finite cost is charged at the estimate.
      const c = Number.isFinite(outcome.costUsd) && outcome.costUsd >= 0 ? outcome.costUsd : (est ?? 0);
      unitCost += c;
      spent += c;
      last = outcome.result;
      if (last.verdict === "PROVEN") {
        return { unit: unit.id, status: "PROVEN", attempts, costUsd: unitCost, result: last, worktree: path, needsReslice: false };
      }
      wt.remove(opts.repoDir, path);
    }
    return {
      unit: unit.id, status: last ? last.verdict : "SKIPPED_BUDGET", attempts, costUsd: unitCost,
      result: last, worktree: null, needsReslice: reason === undefined && last !== null, reason,
    };
  }

  for (const ids of plan.waves) {
    opts.log.append("wave.started", { units: ids.length });
    const queue = ids.map((id) => byId.get(id)).filter((u): u is Unit => u !== undefined);
    let next = 0;
    const pool = Array.from({ length: Math.min(workers, queue.length) }, async (_, i) => {
      while (next < queue.length) {
        const unit = queue[next++]!;
        if (stopped()) { outcomes.push(skipped(unit.id, "budget stop")); continue; }
        inFlight++;
        try {
          outcomes.push(await runUnitCascade(unit, i + 1));
        } finally {
          inFlight--;
        }
      }
    });
    await Promise.all(pool);
  }
  return { outcomes, spentUsd: spent, budgetHit: hit };
}
