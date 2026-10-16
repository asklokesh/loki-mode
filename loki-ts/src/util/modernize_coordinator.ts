// loki-ts/src/util/modernize_coordinator.ts -- wave orchestration for `loki modernize` (docs/v10/MODERNIZE.md 3.4-3.7).
// Lives in util/ because engine10/modernize/ is at its D33 line cap (like modernize_unit.ts). No existing file owns wave orchestration: cli.ts parses args; ship.ts, resume.ts, scheduler.ts and wave.ts each own one step.
// Per wave: schedule (or resumeSchedule after a crash), verifyWave (M-20), nextWaveGate, shipWave (M-21). Every dependency is injected.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClusterResult, Unit } from "../engine10/modernize/cluster.ts";
import type { InventoryResult } from "../engine10/modernize/inventory.ts";
import { captureUnitOracle, makeProposeInputs, realCaptureRunner } from "../engine10/modernize/oracle/search.ts";
import type { ProposeInputs } from "../engine10/modernize/oracle/search.ts";
import { alreadySealedInLog, DEFAULT_NORMALIZERS } from "../engine10/modernize/oracle/seal.ts";
import { loadResumeState, resumeSchedule } from "../engine10/modernize/resume.ts";
import { gitMergeOps, schedule } from "../engine10/modernize/scheduler.ts";
import type { AttemptRunner, MergeOps, SchedulerOpts, UnitOutcome, WorktreeOps } from "../engine10/modernize/scheduler.ts";
import { shipWave } from "../engine10/modernize/ship.ts";
import type { PushRunner, ShipUnit } from "../engine10/modernize/ship.ts";
import type { ModernizeLog } from "../engine10/modernize/log.ts";
import { readModernizeEvents } from "../engine10/modernize/log.ts";
import { isSafeUnitId, oracleDir } from "../engine10/modernize/types.ts";
import type { ModernizeTarget } from "../engine10/modernize/types.ts";
import { runUnit } from "../engine10/modernize/unit.ts";
import { detectWaveCommands, nextWaveGate, verifyWave } from "../engine10/modernize/wave.ts";
import type { StepCommand, StepRunner, WaveStep, WaveVerdict } from "../engine10/modernize/wave.ts";
import { childEnv } from "../engine10/session.ts";
import { defaultUnitFile, makeSessionRunner, makeUnitRunners } from "./modernize_unit.ts";
import { makePytestBaseRunner, makePytestCollector } from "./python.ts";
import { safeGit, tokenFreeEnv } from "./safe_git.ts";

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
  /** Current base commit of repoDir; runWaves re-reads it after each wave's merges so the next wave starts from the merged tree (F4). */
  headSha?: () => string;
  /** Before wave 1, once per unit: returns a NOT_PROVEN reason (the unit is then never scheduled) or null when the oracle is ready (F8). */
  prepare?: (unit: Unit) => string | null;
  /** Steps whose missing command warns instead of blocking (D2). */
  optionalSteps?: readonly WaveStep[];
}
export interface WaveReport { wave: number; verdict: WaveVerdict; shipped: boolean; url: string | null; reason: string | null }
export type WavesResult = { ok: boolean; waves: WaveReport[]; blocked: string | null; spentUsd: number };

const sha256 = (p: string): string => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "n/a");

/** The sealed oracle is the unit's evidence file; it is named in the PR body with its hash. A unit with no outcome is NOT_PROVEN; resume fills in logged outcomes explicitly (runWaves). */
function shipUnitOf(d: WaveDeps, unit: string, o: UnitOutcome | undefined): ShipUnit {
  const sealed = join(oracleDir(d.repoDir, d.mid, unit), "sealed.json");
  const eq = o?.result?.equiv;
  return {
    unit, verdict: o?.status === "PROVEN" ? "PROVEN" : o?.status === "NOT_EQUAL" ? "NOT_EQUAL" : "NOT_PROVEN",
    not_proven: o?.result?.not_proven ?? (o && o.reason ? [o.reason] : []),
    receiptPath: sealed, receiptSha256: sha256(sealed), runId: d.mid,
    rate: eq ? eq.rate : null, branchPct: eq ? eq.branch_pct : null,
  };
}

/** M-27F: a python compileall build step compiles only this wave's existing .py files (the whole repo fails multi-wave py2 repos); the -x excludes stay. Any other command, or a wave with no .py file, is unchanged. */
export function scopeBuildToWave(cmd: StepCommand | null | undefined, repoDir: string, units: readonly Unit[]): StepCommand | null | undefined {
  const x = cmd?.argv.indexOf("-x") ?? -1;
  if (!cmd || !cmd.argv.includes("compileall") || x < 0) return cmd;
  const files = [...new Set(units.flatMap((u) => u.nodes))].filter((n) => n.endsWith(".py") && isSafeUnitId(n) && existsSync(join(repoDir, n)));
  return files.length ? { ...cmd, argv: [...cmd.argv.slice(0, x + 2), ...files] } : cmd;
}

export async function runWaves(plan: ClusterResult, d: WaveDeps): Promise<WavesResult> {
  const waves: WaveReport[] = [];
  const verdicts: WaveVerdict[] = [];
  let spent = 0;
  const shipped = new Set(readModernizeEvents(d.repoDir, d.mid).filter((e) => e.type === "wave.shipped").map((e) => e.data["wave"]));
  const unready = new Map<string, string>();
  // F8: on resume a unit already settled in the log is never re-captured (the tree has changed since).
  const settled = new Set<string>();
  if (d.resume) { const st = loadResumeState(d.repoDir, d.mid); if (st.ok) for (const id of [...st.state.completed, ...st.state.notProven]) settled.add(id); }
  for (const u of plan.units) {
    if (settled.has(u.id)) continue;
    const why = d.prepare?.(u) ?? null;
    if (why === null) continue;
    unready.set(u.id, why);
    d.log.append("unit.not_proven", { unit: u.id, reasons: [why] });
  }
  let baseSha = d.baseSha;
  for (let i = 0; i < plan.waves.length; i++) {
    const n = i + 1;
    const gate = nextWaveGate(verdicts);
    if (!gate.allowed) return { ok: false, waves, blocked: gate.reason, spentUsd: spent };
    if (i > 0 && d.headSha) baseSha = d.headSha();
    const ids = plan.waves[i]!;
    const sub: ClusterResult = { units: plan.units.filter((u) => ids.includes(u.id) && !unready.has(u.id)), waves: [ids.filter((id) => !unready.has(id))] };
    const opts: SchedulerOpts = {
      repoDir: d.repoDir, mid: d.mid, baseSha, workers: d.workers, budgetUsd: d.budgetUsd,
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
        if (outcomes.some((o) => o.unit === id) || unready.has(id)) continue;
        const done = st.ok && st.state.completed.has(id) && !st.state.notProven.has(id);
        outcomes.push({ unit: id, status: done ? "PROVEN" : "NOT_PROVEN", attempts: 0, costUsd: 0, result: null, worktree: null, needsReslice: false, ...(done ? {} : { reason: "logged not proven, or no outcome" }) });
      }
    } else {
      const r = await schedule(sub, opts);
      outcomes = r.outcomes; spent += r.spentUsd;
    }
    for (const id of ids) if (unready.has(id)) outcomes.push({ unit: id, status: "NOT_PROVEN", attempts: 0, costUsd: 0, result: null, worktree: null, needsReslice: false, reason: unready.get(id)! });
    const byUnit = new Map(outcomes.map((o) => [o.unit, o]));
    const verdict = verifyWave({ repoDir: d.repoDir, wave: n, commands: { ...d.waveCommands, build: scopeBuildToWave(d.waveCommands.build, d.repoDir, sub.units) }, log: d.log, ...(d.optionalSteps ? { optional: d.optionalSteps } : {}), ...(d.stepRunner ? { run: d.stepRunner } : {}) });
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
    if (bad) return { ok: false, waves, blocked: `wave ${n} blocked: unit ${bad.unit} ${bad.status}${bad.reason ? ` (${bad.reason})` : ""}`, spentUsd: spent };
  }
  return { ok: waves.every((w) => w.verdict.verified), waves, blocked: null, spentUsd: spent };
}

export interface ProductionWaveOpts {
  repoDir: string; mid: string; target: ModernizeTarget; workers: number; budgetUsd: number | null; resume: boolean; noPr: boolean;
  inv: InventoryResult; plan: ClusterResult; log: ModernizeLog;
}

/** The real per-attempt runner: runUnit (M-15) in the attempt worktree with the shared implementer and new-tree runner (makeUnitRunners).
 *  The oracle and log live in the base tree (repoDir); only the implement session and the new-tree replay see the worktree (newTreeDir). */
export function makeAttemptRunner(o: { mid: string; target: ModernizeTarget; log: ModernizeLog; repoDir: string; units: readonly Unit[]; runners?: ReturnType<typeof makeUnitRunners>; runUnit?: typeof runUnit }): AttemptRunner {
  const nodesOf = new Map(o.units.map((u) => [u.id, u.nodes]));
  // Unit ids are "u-N", not paths: a single-file unit is located by its one node; a multi-file unit has no single source (NOT_PROVEN, D1).
  const unitFile = (id: string, tree: string): string | null => { const n = nodesOf.get(id); return n && n.length === 1 ? defaultUnitFile(n[0]!, tree) : null; };
  const runners = o.runners ?? makeUnitRunners({ target: o.target, unitFile });
  const run = o.runUnit ?? runUnit;
  return (ctx) => ({
    result: run({ unit: ctx.unit.id, repoDir: o.repoDir, newTreeDir: ctx.worktree, mid: o.mid, target: o.target, normalizers: DEFAULT_NORMALIZERS, baseSha: ctx.baseSha, files: ctx.unit.nodes },
      o.log, makePytestBaseRunner(), runners.implement, runners.runNew, runners.runStub, makePytestCollector()),
    costUsd: NaN, // unmetered here: the scheduler treats a non-finite cost as budget-unknown (charged at the estimate, or stops under --budget)
  });
}

/** Founder default D1: capture reads one .py file. Anything else is NOT_PROVEN, never guessed at. */
export const MULTI_FILE_REASON = "multi-file unit: capture not supported (founder default)";

/** Oracle capture for one unit (F8): null when the oracle exists or was captured, else the NOT_PROVEN reason. Captures once, never retried on a changed tree. */
export function makeUnitPrep(o: { repoDir: string; mid: string; propose: ProposeInputs; capture?: typeof captureUnitOracle; runtimeOk?: () => boolean }): (unit: Unit) => string | null {
  // Probe the old runtime once: realCaptureRunner reports "old runtime unavailable" before it reads the unit, so every unit gets the same honest reason.
  const runtimeOk = o.runtimeOk ?? ((): boolean => {
    // Probe a path inside a fresh temp dir, never a file in the user's repo.
    const dir = mkdtempSync(join(tmpdir(), "loki-probe-"));
    try { return realCaptureRunner(join(dir, "probe.py"), []).error !== "old runtime unavailable"; } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  let runtime: boolean | null = null;
  return (unit) => {
    if (existsSync(join(oracleDir(o.repoDir, o.mid, unit.id), "cases.jsonl")) || alreadySealedInLog(o.repoDir, o.mid, unit.id)) return null;
    runtime ??= runtimeOk();
    if (!runtime) return "old runtime unavailable";
    const node = unit.nodes.length === 1 ? unit.nodes[0]! : "";
    if (!node.endsWith(".py") || !isSafeUnitId(node)) return MULTI_FILE_REASON;
    const r = (o.capture ?? captureUnitOracle)({ repoDir: o.repoDir, mid: o.mid, unit: unit.id, unitPath: join(o.repoDir, node), propose: o.propose });
    return r.ok ? null : r.reason;
  };
}

/** Read-only model session for case proposals: the implement session's env (token-free), cwd = the temp dir holding a copy of the unit. Never runs in repoDir. */
export function makeProposeSession(o: { mid: string; provider?: string; session?: Parameters<typeof makeSessionRunner>[0]["session"] }): NonNullable<Parameters<typeof makeProposeInputs>[0]> {
  const provider = o.provider ?? process.env["LOKI_E10_PROVIDER"] ?? "claude";
  const session = makeSessionRunner({ ...(o.session ? { session: o.session } : {}) });
  return (a) => {
    const brief = [
      `Read ${a.unitFile} (legacy code, round ${a.round}). Propose test inputs that reach its uncovered branches.`,
      `Uncovered: ${JSON.stringify(a.missing)}`,
      'Write proposals.jsonl in this directory: one JSON object per line, {"entry": <function name>, "args": [...], "kwargs": {...}}.',
      "Write only proposals.jsonl. Do not edit the unit file.",
    ].join("\n");
    const env = tokenFreeEnv(childEnv({ stage: "implement", brief, tier: "development", iterationId: `modernize-${o.mid}-capture-${a.round}`, limitS: 600, signal: new AbortController().signal, cwd: a.cwd }, { provider }));
    const r = session(brief, a.cwd, env);
    if (r.status !== 0) throw new Error(`propose session exited ${r.status}`);
  };
}

/** Builds the real dependencies. Fails closed (exit 2 upstream) when the repo has no readable HEAD, or no origin to pin without --no-pr. Never substitutes a fake. */
export function productionWaveDeps(o: ProductionWaveOpts): { ok: true; deps: WaveDeps } | { ok: false; reason: string } {
  let pinnedOrigin = "";
  let baseSha = "";
  const head = (): string => safeGit(o.repoDir, ["rev-parse", "HEAD"]).trim();
  try { baseSha = head(); } catch { return { ok: false, reason: "modernize: cannot read the base commit (HEAD) of the repo" }; }
  try { pinnedOrigin = safeGit(o.repoDir, ["config", "--get", "remote.origin.url"]).trim(); } catch { /* empty: refused below */ }
  if (!o.noPr && pinnedOrigin === "") return { ok: false, reason: "modernize: no remote.origin.url to pin for the wave PR (use --no-pr to skip shipping)" };
  // detectWaveCommands' second parameter is named `target` but is read as a directory: pass the repo dir, never the ModernizeTarget string.
  const waveCommands = detectWaveCommands(o.inv, o.repoDir);
  return {
    ok: true,
    deps: {
      repoDir: o.repoDir, mid: o.mid, baseSha, workers: o.workers, budgetUsd: o.budgetUsd, unitEstimateUsd: null, log: o.log,
      run: makeAttemptRunner({ mid: o.mid, target: o.target, log: o.log, repoDir: o.repoDir, units: o.plan.units }),
      merge: gitMergeOps(o.repoDir, o.mid), resume: o.resume, waveCommands,
      optionalSteps: waveCommands.integration === null ? ["integration"] : [],
      ship: !o.noPr, pinnedOrigin, headSha: head,
      prepare: makeUnitPrep({ repoDir: o.repoDir, mid: o.mid, propose: makeProposeInputs(makeProposeSession({ mid: o.mid })) }),
    },
  };
}
