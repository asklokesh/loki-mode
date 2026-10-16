// loki-ts/src/engine10/modernize/scheduler.ts -- M-17: the local unit scheduler (docs/v10/MODERNIZE.md
// section 3.4, D30). N workers under one coordinator. The coordinator is the modernize log's only
// writer: workers return values, they never touch the log. Per unit: model cascade (sonnet first,
// opus on a failed check or for a high-risk unit), best-of-2 after one failure, a fresh worktree per
// attempt, and a budget stop that finishes in-flight units. The unit run itself (runUnit, M-15) and
// the git calls are injected, so the policy here is tested without a model or a repo.
import { join } from "node:path";
import type { ClusterResult, Unit } from "./cluster.ts";
import { budgetExceeded } from "./estimate.ts";
import type { ModernizeLog } from "./log.ts";
import { safeGit } from "../../util/safe_git.ts";
import { modernizeRoot } from "./types.ts";
import type { UnitRunResult } from "./unit.ts";

export type Model = "sonnet" | "opus";
export const MAX_LOCAL_WORKERS = 32;
export const DEFAULT_WORKERS = 4;
/** Section 3.4: per-unit cost cap is the estimate x 3. */
export const UNIT_COST_CAP_FACTOR = 3;

// No "~" in the class: the variant suffix "~v<n>" can never be part of a unit id, so paths cannot collide.
const UNIT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const VARIANT_SEP = "~v";

export interface AttemptCtx {
  unit: Unit;
  model: Model;
  /** 0 = first attempt, 1 and 2 = the best-of-2 variants. */
  variant: 0 | 1 | 2;
  worker: number;
  worktree: string;
  baseSha: string;
  /** Set on a resumed unit (M-22): the recorded engine10 run id, to be continued through the E-39 resume path
   *  (`loki --resume <run-id>`) inside the reattached worktree rather than started over. */
  resumeRunId?: string;
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
  /** True when path is an existing worktree whose HEAD is baseSha (MODERNIZE.md section 5). Absent = never reusable. */
  reusable?(repoDir: string, path: string, baseSha: string): boolean;
}

/** The unit merge, injected. isMerged must read the repo, not memory. */
export interface MergeOps {
  isMerged(unit: string): boolean;
  merge(unit: string, worktree?: string): void;
}
export type MergeResult = "merged" | "already_completed" | "adopted";

/** Idempotent merge. The merge and the unit.completed write are not atomic, so a crash can land between
 *  them: on restart the repo says merged but the log does not say completed. That case is adopted (the
 *  completion is recorded) and the merge is never repeated. */
export function mergeOnce(unit: string, ops: MergeOps, log: ModernizeLog, completed: ReadonlySet<string>, worktree?: string): MergeResult {
  if (completed.has(unit)) return "already_completed";
  if (ops.isMerged(unit)) {
    log.append("unit.completed", { unit, adopted: true });
    return "adopted";
  }
  ops.merge(unit, worktree);
  log.append("unit.completed", { unit });
  return "merged";
}

/** Real git worktrees. Argument arrays only (no shell), detached at the recorded base. Routed through safeGit (FC-25): a unit agent
 *  can plant hooks or config in the shared common git dir, so hooks and fsmonitor are off and the token is withheld. */
export const gitWorktrees: WorktreeOps = {
  create(repoDir, path, baseSha) {
    safeGit(repoDir, ["worktree", "add", "--detach", "--force", path, baseSha]);
  },
  remove(repoDir, path) {
    try {
      safeGit(repoDir, ["worktree", "remove", "--force", path]);
    } catch { /* already gone */ }
  },
  reusable(_repoDir, path, baseSha) {
    try {
      return safeGit(path, ["rev-parse", "HEAD"]).trim() === baseSha;
    } catch {
      return false;
    }
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
  /** Stamped on unit.started events when set. */
  runId?: string;
  worktrees?: WorktreeOps;
  /** When set, a PROVEN unit is merged through mergeOnce, which emits unit.completed (M-22). */
  merge?: MergeOps;
  /** Units the log already marks completed; mergeOnce never merges these again. */
  completed?: ReadonlySet<string>;
  /** unit id -> recorded run id for units resumed after a crash (M-22). */
  resumeRuns?: ReadonlyMap<string, string>;
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

  // running = units counted in inFlight before this check. At dispatch the candidate is not yet in inFlight (add 1);
  // inside the cascade the current unit already is (add 0).
  const stopped = (candidates: 0 | 1): boolean => {
    if (hit) return true;
    const over = est == null
      ? opts.budgetUsd != null && spent > opts.budgetUsd
      : budgetExceeded(spent, (inFlight + candidates) * est, opts.budgetUsd);
    if (over) {
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
      if (attempts > 0 && (stopped(0) || (cap != null && unitCost >= cap))) {
        reason = hit ? "budget stop" : "per-unit cost cap reached";
        break;
      }
      const path = join(modernizeRoot(opts.repoDir, opts.mid), "wt", variant === 0 ? unit.id : `${unit.id}${VARIANT_SEP}${variant}`);
      let outcome: AttemptOutcome;
      attempts++;
      // Resume (M-22): reattach the recorded worktree and hand the run id to the E-39 path. If the worktree cannot be
      // reattached at the recorded base, restart cleanly and say why in the log.
      let resumeRunId: string | undefined;
      const wantRun = variant === 0 ? opts.resumeRuns?.get(unit.id) : undefined;
      if (wantRun !== undefined) {
        if (wt.reusable?.(opts.repoDir, path, opts.baseSha)) resumeRunId = wantRun;
        else opts.log.append("unit.resume_fallback", { unit: unit.id, run_id: wantRun, reason: wt.reusable ? "worktree missing or HEAD differs from the recorded base; restarted cleanly" : "worktree reattach not supported; restarted cleanly" });
      }
      const stampRun = resumeRunId ?? opts.runId;
      opts.log.append("unit.started", { unit: unit.id, model, worker, variant, ...(stampRun ? { run_id: stampRun } : {}) });
      if (variant > 0) opts.log.append("unit.variant", { unit: unit.id, variant, model });
      try {
        if (resumeRunId === undefined) {
          wt.remove(opts.repoDir, path);
          wt.create(opts.repoDir, path, opts.baseSha);
        }
        outcome = await opts.run({ unit, model, variant, worker, worktree: path, baseSha: opts.baseSha, ...(resumeRunId ? { resumeRunId } : {}) });
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
        if (opts.merge) {
          try {
            mergeOnce(unit.id, opts.merge, opts.log, opts.completed ?? new Set(), path);
          } catch (e) {
            wt.remove(opts.repoDir, path);
            const msg = e instanceof Error ? e.message : String(e);
            return { unit: unit.id, status: "NOT_PROVEN", attempts, costUsd: unitCost, result: last, worktree: null, needsReslice: false, reason: `merge failed: ${msg}` };
          }
        }
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
        if (stopped(1)) { outcomes.push(skipped(unit.id, "budget stop")); continue; }
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
