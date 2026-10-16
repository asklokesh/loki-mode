// loki-ts/src/util/modernize_coordinator.ts -- wave orchestration for `loki modernize` (docs/v10/MODERNIZE.md 3.4-3.7).
// Lives in util/ because engine10/modernize/ is at its D33 line cap (like modernize_unit.ts). No existing file owns wave orchestration: cli.ts parses args; ship.ts, resume.ts, scheduler.ts and wave.ts each own one step.
// Per wave: schedule (or resumeSchedule after a crash), verifyWave (M-20), nextWaveGate, shipWave (M-21). Every dependency is injected.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClusterResult } from "../engine10/modernize/cluster.ts";
import { DEFAULT_NORMALIZERS } from "../engine10/modernize/oracle/seal.ts";
import { loadResumeState, resumeSchedule } from "../engine10/modernize/resume.ts";
import { schedule } from "../engine10/modernize/scheduler.ts";
import type { AttemptRunner, MergeOps, SchedulerOpts, UnitOutcome, WorktreeOps } from "../engine10/modernize/scheduler.ts";
import { shipWave } from "../engine10/modernize/ship.ts";
import type { PushRunner, ShipUnit } from "../engine10/modernize/ship.ts";
import type { ModernizeLog } from "../engine10/modernize/log.ts";
import { readModernizeEvents } from "../engine10/modernize/log.ts";
import { modernizeRoot } from "../engine10/modernize/types.ts";
import type { ModernizeTarget } from "../engine10/modernize/types.ts";
import { runUnit } from "../engine10/modernize/unit.ts";
import { nextWaveGate, verifyWave } from "../engine10/modernize/wave.ts";
import type { StepCommand, StepRunner, WaveStep, WaveVerdict } from "../engine10/modernize/wave.ts";
import { makeUnitRunners } from "./modernize_unit.ts";
import { makePytestBaseRunner, makePytestCollector } from "./python.ts";
import { safeGit } from "./safe_git.ts";
import type { NewCaseRunner } from "../engine10/modernize/equiv.ts";
import type { Implementer } from "../engine10/modernize/unit.ts";

export interface WaveDeps {
  repoDir: string;
  mid: string;
  baseSha: string;
  workers: number;
  budgetUsd: number | null;
  unitEstimateUsd: number | null;
  log: ModernizeLog;
  run: AttemptRunner;
  merge: MergeOps;
  worktrees?: WorktreeOps;
  /** True after a crash: finished units are skipped and merged through mergeOnce (M-22). */
  resume: boolean;
  waveCommands: Partial<Record<WaveStep, StepCommand | null>>;
  stepRunner?: StepRunner;
  /** False skips shipWave (--no-pr). */
  ship: boolean;
  pinnedOrigin: string;
  branchFor?: (wave: number) => string;
  push?: PushRunner;
}
export interface WaveReport { wave: number; verdict: WaveVerdict; shipped: boolean; url: string | null; reason: string | null }
export type WavesResult = { ok: boolean; waves: WaveReport[]; blocked: string | null; spentUsd: number };

const sha256 = (p: string): string => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "n/a");

/** The sealed oracle is the unit's evidence file; it is named in the PR body with its hash. A unit with no outcome is NOT_PROVEN; resume fills in logged outcomes explicitly (runWaves). */
function shipUnitOf(d: WaveDeps, unit: string, o: UnitOutcome | undefined): ShipUnit {
  const sealed = join(modernizeRoot(d.repoDir, d.mid), "oracle", unit, "sealed.json");
  const eq = o?.result?.equiv;
  return {
    unit, verdict: o?.status === "PROVEN" ? "PROVEN" : o?.status === "NOT_EQUAL" ? "NOT_EQUAL" : "NOT_PROVEN",
    not_proven: o?.result?.not_proven ?? (o && o.reason ? [o.reason] : []),
    receiptPath: sealed, receiptSha256: sha256(sealed), runId: d.mid,
    rate: eq ? eq.rate : null, branchPct: eq ? eq.branch_pct : null,
  };
}

export async function runWaves(plan: ClusterResult, d: WaveDeps): Promise<WavesResult> {
  const waves: WaveReport[] = [];
  const verdicts: WaveVerdict[] = [];
  let spent = 0;
  const shipped = new Set(readModernizeEvents(d.repoDir, d.mid).filter((e) => e.type === "wave.shipped").map((e) => e.data["wave"]));
  for (let i = 0; i < plan.waves.length; i++) {
    const n = i + 1;
    const gate = nextWaveGate(verdicts);
    if (!gate.allowed) return { ok: false, waves, blocked: gate.reason, spentUsd: spent };
    const ids = plan.waves[i]!;
    const sub: ClusterResult = { units: plan.units.filter((u) => ids.includes(u.id)), waves: [ids] };
    const opts: SchedulerOpts = {
      repoDir: d.repoDir, mid: d.mid, baseSha: d.baseSha, workers: d.workers, budgetUsd: d.budgetUsd,
      unitEstimateUsd: d.unitEstimateUsd, log: d.log, run: d.run, merge: d.merge, ...(d.worktrees ? { worktrees: d.worktrees } : {}),
    };
    let outcomes: UnitOutcome[];
    if (d.resume) {
      const r = await resumeSchedule(sub, opts);
      if (!r.ok) return { ok: false, waves, blocked: `resume refused: ${r.reason}`, spentUsd: spent };
      outcomes = r.report.outcomes; spent += r.report.spentUsd;
      // Units skipped on resume have no outcome: carry them from the log. Logged unit.not_proven stays NOT_PROVEN; only a logged unit.completed is PROVEN.
      const st = loadResumeState(d.repoDir, d.mid);
      for (const id of ids) {
        if (outcomes.some((o) => o.unit === id)) continue;
        const done = st.ok && st.state.completed.has(id) && !st.state.notProven.has(id);
        outcomes.push({ unit: id, status: done ? "PROVEN" : "NOT_PROVEN", attempts: 0, costUsd: 0, result: null, worktree: null, needsReslice: false, ...(done ? {} : { reason: "logged not proven, or no outcome" }) });
      }
    } else {
      const r = await schedule(sub, opts);
      outcomes = r.outcomes; spent += r.spentUsd;
    }
    const byUnit = new Map(outcomes.map((o) => [o.unit, o]));
    const verdict = verifyWave({ repoDir: d.repoDir, wave: n, commands: d.waveCommands, log: d.log, ...(d.stepRunner ? { run: d.stepRunner } : {}) });
    verdicts.push(verdict);
    let url: string | null = null, reason: string | null = null, didShip = false;
    if (d.ship && !shipped.has(n)) {
      const r = shipWave({
        repoDir: d.repoDir, mid: d.mid, wave: n, branch: (d.branchFor ?? ((w) => `loki/modernize-${d.mid}-wave-${w}`))(n),
        pinnedOrigin: d.pinnedOrigin, verdict, units: ids.map((id) => shipUnitOf(d, id, byUnit.get(id))), log: d.log, ...(d.push ? { push: d.push } : {}),
      });
      didShip = r.shipped; url = r.url; reason = r.reason;
    }
    waves.push({ wave: n, verdict, shipped: didShip, url, reason });
    const bad = outcomes.find((o) => o.status !== "PROVEN");
    if (bad) return { ok: false, waves, blocked: `wave ${n} blocked: unit ${bad.unit} ${bad.status}`, spentUsd: spent };
  }
  return { ok: waves.every((w) => w.verdict.verified), waves, blocked: null, spentUsd: spent };
}

export interface ProductionWaveOpts { repoDir: string; mid: string; target: ModernizeTarget; workers: number; budgetUsd: number | null; resume: boolean; noPr: boolean }

/** The real per-attempt runner: runUnit (M-15) in the attempt worktree with the shared implementer and new-tree runner (makeUnitRunners). */
export function makeAttemptRunner(o: { mid: string; target: ModernizeTarget; log: ModernizeLog; runners?: { implement: Implementer; runNew: NewCaseRunner } }): AttemptRunner {
  const runners = o.runners ?? makeUnitRunners({ target: o.target });
  return (ctx) => ({
    result: runUnit({ unit: ctx.unit.id, repoDir: ctx.worktree, mid: o.mid, target: o.target, normalizers: DEFAULT_NORMALIZERS, baseSha: ctx.baseSha },
      o.log, makePytestBaseRunner(), runners.implement, runners.runNew, undefined, makePytestCollector()),
    costUsd: NaN, // unmetered here: the scheduler treats a non-finite cost as budget-unknown (charged at the estimate, or stops under --budget)
  });
}

/** Builds the real dependencies, or names every piece that does not exist yet. Never substitutes a fake. */
export function productionWaveDeps(o: ProductionWaveOpts): { ok: true; deps: WaveDeps } | { ok: false; reason: string } {
  let pinnedOrigin = "";
  try { safeGit(o.repoDir, ["rev-parse", "HEAD"]); } catch { return { ok: false, reason: "modernize: cannot read the base commit (HEAD) of the repo" }; }
  try { pinnedOrigin = safeGit(o.repoDir, ["config", "--get", "remote.origin.url"]).trim(); } catch { /* empty: refused below */ }
  if (!o.noPr && pinnedOrigin === "") return { ok: false, reason: "modernize: no remote.origin.url to pin for the wave PR (use --no-pr to skip shipping)" };
  const missing = [
    "oracle capture (nothing produces a unit's cases.jsonl)",
    "unit merge ops (no MergeOps implementation)",
    "ablation stub runner (runUnit cannot return PROVEN without one)",
    "wave verify commands (no build, integration or original-suite detection)",
  ];
  return { ok: false, reason: `modernize: cannot run units yet, not built: ${missing.join("; ")}` };
}
