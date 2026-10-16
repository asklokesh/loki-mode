// loki-ts/src/engine10/modernize/coordinator.ts -- wave orchestration for `loki modernize` (docs/v10/MODERNIZE.md 3.4-3.7).
// New file because no existing file owns wave orchestration: cli.ts parses args; ship.ts, resume.ts, scheduler.ts and wave.ts each own one step.
// Per wave: schedule (or resumeSchedule after a crash), verifyWave (M-20), nextWaveGate, shipWave (M-21). Every dependency is injected.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClusterResult } from "./cluster.ts";
import { DEFAULT_NORMALIZERS } from "./oracle/seal.ts";
import { resumeSchedule } from "./resume.ts";
import { schedule } from "./scheduler.ts";
import type { AttemptRunner, MergeOps, SchedulerOpts, UnitOutcome, WorktreeOps } from "./scheduler.ts";
import { shipWave } from "./ship.ts";
import type { PushRunner, ShipUnit } from "./ship.ts";
import type { ModernizeLog } from "./log.ts";
import { readModernizeEvents } from "./log.ts";
import { modernizeRoot } from "./types.ts";
import type { ModernizeTarget } from "./types.ts";
import { runUnit } from "./unit.ts";
import { nextWaveGate, verifyWave } from "./wave.ts";
import type { StepCommand, StepRunner, WaveStep, WaveVerdict } from "./wave.ts";
import { makeUnitRunners } from "../../util/modernize_unit.ts";
import { makePytestBaseRunner, makePytestCollector } from "../../util/python.ts";
import { safeGit } from "../../util/safe_git.ts";
import type { NewCaseRunner } from "./equiv.ts";
import type { Implementer } from "./unit.ts";

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

/** The sealed oracle is the unit's evidence file; it is named in the PR body with its hash. A unit finished before a crash has no outcome and is PROVEN by its log record. */
function shipUnitOf(d: WaveDeps, unit: string, o: UnitOutcome | undefined): ShipUnit {
  const sealed = join(modernizeRoot(d.repoDir, d.mid), "oracle", unit, "sealed.json");
  const eq = o?.result?.equiv;
  return {
    unit, verdict: o ? (o.status === "PROVEN" ? "PROVEN" : o.status === "NOT_EQUAL" ? "NOT_EQUAL" : "NOT_PROVEN") : "PROVEN",
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
    costUsd: NaN, // unmetered here: the scheduler charges an unreported cost at the estimate, never as free
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
