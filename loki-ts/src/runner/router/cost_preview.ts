// 11.3.0 T1: cost preview. The estimate is read from the existing per-repo, per-shape run history
// (runner/router/history_store.ts); nothing here estimates from the task text or the repo's file
// names (Engine Law L0). No usable history prints "NOT AVAILABLE (<reason>)", never a number.
// Off with LOKI_COST_PREVIEW=0: no start-line text, no receipt block, no history append.
import { repoKey } from "../../engine10/cache.ts";
import { resolveModel } from "../../engine10/session.ts";
import { appendRunOutcome, readRunHistory, shapeKeyForRepo, WALL_KIND, type RunOutcome } from "./history.ts";
import { readOriginUrl } from "../../util/engine_origin.ts";

export const MIN_RUNS = 3;
const WINDOW = 20;
export const NOT_RECORDED = "NOT RECORDED";

export interface Estimate { shape: string; runs: number; usd: [number, number]; wall_s: [number, number] | null } // wall_s null = no prior run carries a reconciled total (old history is ignored for time)
export interface Prior { usd: [number, number]; tier: string; size_class: string }
export type EstimateResult = { ok: true; est: Estimate } | { ok: false; reason: string; prior?: Prior };
export type SizeClass = "unplanned" | "small" | "medium" | "large";
export type Env = Record<string, string | undefined>;

export const previewOn = (env: Env): boolean => env["LOKI_COST_PREVIEW"] !== "0";

export interface PriorOpts { model?: string; sizeClass?: SizeClass; env?: Env }

// First-run prior, used only when a shape has no usable history. Keyed by model tier and the plan's size class;
// the class is never read from task wording. Provenance, sonnet: measured Loki-arm cost per run (claude-sonnet-5-5
// implement, haiku-5-5 first Wall pass) from benchmark runs run10, run11 and run12 (scoreboard dirs 2026-10-29-run10,
// 2026-10-29-run11, 2026-10-30-run12; Loki 11.85.0, 11.87.0, 11.89.0; 72 rows, 8 tasks x 3 reps x 3 runs). Cost is the
// sum of each row's result-cost files, resumed sessions counted as the increment only. Min-max, rounded outward to
// cents, same as the history path: all 72 rows $0.0134-$0.1609 (median $0.0225) gives "unplanned", which is what
// the start line uses because no plan exists yet; the 54 rows with no plan stage (single-unit tasks) $0.0134-$0.0582
// (median $0.0210) gives "small". The 18 plan-stage rows ($0.0694-$0.1609) carry no recorded scope file count, so
// medium and large have no measured row and therefore no prior. Fixture: tests/runner/fixtures/cost_preview_run10_12_rows.json.
// haiku and opus were not run in run10 to run12 and keep their earlier bands.
// haiku: measured cost_usd per run of the Loki (v10) arm of the D50 small-tier baseline (docs/v10/METRICS.md,
// 2026-09-30, 9 measured runs, min-max).
// opus: no per-run min-max exists (the D50 baseline ran no opus arm). Its band is the two measured cost-per-
// completed-task means of the D30 small-tier report on claude-opus-5-5 (29 tasks): v10 lean $0.1616 to v10
// default knobs $0.3946 (docs/v10/METRICS.md, 2026-09-28).
const PRIOR_USD: Record<string, Partial<Record<SizeClass, [number, number]>>> = {
  haiku: { unplanned: [0.19, 0.63], small: [0.19, 0.63] },
  sonnet: { unplanned: [0.01, 0.17], small: [0.01, 0.06] },
  opus: { unplanned: [0.16, 0.39], small: [0.16, 0.39] },
};

/** Size class from the structured plan scope file list (same 3-file boundary run_cap uses); never from task text. */
export const sizeClassFromScope = (files: string[]): SizeClass => (files.length <= 3 ? "small" : files.length <= 10 ? "medium" : "large");

export function priorFor(model: string | undefined, sizeClass: SizeClass = "unplanned"): Prior | null {
  const tier = /haiku/i.test(model ?? "") ? "haiku" : /sonnet/i.test(model ?? "") ? "sonnet" : /opus/i.test(model ?? "") ? "opus" : null;
  const usd = tier ? PRIOR_USD[tier]?.[sizeClass] : undefined;
  return tier && usd ? { usd: [usd[0], usd[1]], tier, size_class: sizeClass } : null;
}

export function estimateFor(repoDir: string, cacheRoot?: string, opts?: PriorOpts): EstimateResult {
  return estimateFromHistory(shapeKeyForRepo(repoDir), repoKey(readOriginUrl(repoDir), repoDir), cacheRoot, opts);
}

export function estimateFromHistory(shape: string | null, key: string, cacheRoot?: string, opts?: PriorOpts): EstimateResult {
  const withPrior = (reason: string): EstimateResult => {
    const prior = opts?.env?.["LOKI_COST_PRIOR"] === "0" ? null : priorFor(opts?.model, opts?.sizeClass);
    return prior ? { ok: false, reason, prior } : { ok: false, reason };
  };
  if (shape === null) return withPrior("no project shape recorded for this repo");
  const runs = readRunHistory(key, cacheRoot).filter((r) => r.shape === shape && r.verdict === "pass").slice(-WINDOW);
  if (runs.length < MIN_RUNS) return withPrior(`${runs.length} prior verified run${runs.length === 1 ? "" : "s"} for shape ${shape}, need ${MIN_RUNS}`);
  const usd = runs.map((r) => r.usd), wall = runs.filter((r) => r.wallKind === WALL_KIND).map((r) => r.wallS);
  return { ok: true, est: { shape, runs: runs.length, usd: [Math.min(...usd), Math.max(...usd)], wall_s: wall.length > 0 ? [Math.min(...wall), Math.max(...wall)] : null } };
}

const mins = (s: number): string => (s < 90 ? `${Math.round(s)}s` : `${Math.round(s / 60)}m`);

export function startText(r: EstimateResult, capUsd = 0): string {
  const base = startBase(r), high = r.ok ? r.est.usd[1] : r.prior?.usd[1];
  return capUsd > 0 && high !== undefined && high > capUsd ? `${base}; WARNING estimate high $${high.toFixed(2)} exceeds cap $${capUsd.toFixed(2)}` : base;
}

function startBase(r: EstimateResult): string {
  if (!r.ok && r.prior) return `estimate: ~$${r.prior.usd[0].toFixed(2)}-$${r.prior.usd[1].toFixed(2)} (first run in this repo)`;
  if (!r.ok) return `estimate: NOT AVAILABLE (${r.reason})`;
  const { est: e } = r;
  return `estimate: $${e.usd[0].toFixed(2)}-$${e.usd[1].toFixed(2)}, ${e.wall_s ? `${mins(e.wall_s[0])}-${mins(e.wall_s[1])}` : "time NOT RECORDED"} (${e.runs} prior runs, shape ${e.shape})`;
}

/** The estimate as carried from the supervisor to the sealing worker, or null when the preview is off. */
export function encodeEstimate(env: Env, repoDir: string, cacheRoot?: string, model?: string): string | null {
  return previewOn(env) ? JSON.stringify(estimateFor(repoDir, cacheRoot, { model, env })) : null;
}

/** Receipt block: estimate (as printed at start) against actual. Missing actuals are NOT RECORDED, never 0. */
export function receiptBlock(env: Env, usd: number | null, unmetered: boolean, wallS: number | null): { cost_preview?: Record<string, unknown> } {
  if (!previewOn(env)) return {};
  let r: EstimateResult = { ok: false, reason: "no estimate carried from the run start" };
  try { const raw = env["LOKI_E10_COST_ESTIMATE"]; if (raw) r = JSON.parse(raw) as EstimateResult; } catch { /* keep the NOT AVAILABLE default */ }
  const source = r.ok === true ? "history" : r.prior ? "rough_prior" : null;
  return { cost_preview: {
    ...(source ? { estimate_source: source } : {}),
    estimate: !r.ok && r.prior ? { usd_low: r.prior.usd[0], usd_high: r.prior.usd[1], tier: r.prior.tier, size_class: r.prior.size_class } : r.ok === true ? { usd_low: r.est.usd[0], usd_high: r.est.usd[1], wall_low_s: r.est.wall_s?.[0] ?? NOT_RECORDED, wall_high_s: r.est.wall_s?.[1] ?? NOT_RECORDED, prior_runs: r.est.runs, shape: r.est.shape } : `NOT AVAILABLE (${r.reason ?? "unreadable estimate"})`,
    actual: { usd: usd === null || unmetered ? NOT_RECORDED : usd, wall_s: wallS === null || wallS <= 0 ? NOT_RECORDED : wallS },
  } };
}

/**
 * The history row for a sealed run, or null when none is recorded. VERIFIED is an accepted pass (the estimator reads only these).
 * FAILED is a code-owned loss (router evidence for expectedCost). PARTIAL, SPEC_CONFLICT and ALREADY_SATISFIED say nothing about the route and get no history row.
 */
export function outcomeFor(shape: string, model: string, verdict: string, usd: number, wallS: number): RunOutcome | null {
  const executor = /haiku/i.test(model) ? "haiku" : "sonnet";
  if (verdict === "VERIFIED") return { shape, executor, verdict: "pass", owner: null, escalated: false, usd, wallS, wallKind: WALL_KIND };
  if (verdict === "FAILED") return { shape, executor, verdict: "fail", owner: "code", escalated: false, usd, wallS, wallKind: WALL_KIND };
  return null;
}

/** The model the run ended on: the last fix round's model (the final rung), else implement's routed model, else its recorded model, else the run model. History is keyed on this, not the run model, so an escalated run records once under its final rung (reader/writer key contract). */
export function ranModel(implement: Record<string, unknown> | undefined, runModel: string, fix?: Record<string, unknown>): string {
  const f = fix?.["model"];
  const m = typeof f === "string" && f.length > 0 ? f : implement?.["route_model"] ?? implement?.["model"];
  return typeof m === "string" && m.length > 0 ? m : runModel;
}

/** Feed the history this estimator and the router read: a VERIFIED pass or a FAILED code-owned loss, with measured cost only. */
export function recordRun(env: Env, repoDir: string, model: string, verdict: string, usd: number | null, unmetered: boolean, wallS: number | null, cacheRoot?: string): boolean {
  if (!previewOn(env) || usd === null || unmetered || wallS === null || wallS <= 0) return false; // wallS null = the receipt time block did not reconcile: no history row
  const shape = shapeKeyForRepo(repoDir);
  if (shape === null) return false;
  const row = outcomeFor(shape, model, verdict, usd, wallS);
  return row !== null && appendRunOutcome(repoKey(readOriginUrl(repoDir), repoDir), row, cacheRoot);
}

export const ESTIMATE_HELP = `loki estimate - Show what a run is likely to cost

Usage: loki estimate [--model M] [--provider P] [--json]

Prints the same estimate line "loki start" prints before a run: the dollar and time
range of this repo's prior verified runs of the same project shape. With fewer than
${MIN_RUNS} such runs it prints a per-model first-run prior, or NOT AVAILABLE (reason).
It never estimates from task text and never prints a number it did not measure.

Options:
  --model M      Model whose first-run prior to use when there is no history (default: the start model)
  --provider P   Provider whose default model is used (default: LOKI_PROVIDER or claude)
  --json         Machine-readable output (the estimate result object)
  --help, -h     Show this help

Changed: --iterations is removed. The old iteration-based projection (tools/estimate-run.py)
is replaced by this single estimator. LOKI_COST_PREVIEW=0 turns the estimate off.

Examples:
  loki estimate
  loki estimate --json

See also: loki cost --detail (what a run ALREADY spent)
`;

// Same provider list as `loki start` (commands/start.ts imports it). Only claude has a closed model vocabulary; other providers take free-form model ids.
export const VALID_PROVIDERS: ReadonlySet<string> = new Set(["claude", "codex", "cline", "aider", "opencode"]);
const CLAUDE_MODEL_RE = /^(claude-[A-Za-z0-9._-]+|opus|sonnet|haiku|small|medium|high)$/i;

/** `loki estimate`: one estimator, the one `loki start` prints. resolve maps a provider to its start model. */
export function runEstimate(args: readonly string[], d: { repoDir: string; env: Env; resolve?: (provider: string) => string; cacheRoot?: string; out?: (s: string) => void; err?: (s: string) => void }): number {
  const out = d.out ?? ((s: string) => void process.stdout.write(s)), err = d.err ?? ((s: string) => void process.stderr.write(s));
  let json = false, model: string | undefined, provider = d.env["LOKI_PROVIDER"] || "claude";
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--help" || a === "-h") { out(ESTIMATE_HELP); return 0; }
    else if (a === "--json") json = true;
    else if (a === "--model" || a === "--provider") { const v = args[++i]; if (!v || v.startsWith("-")) { err(`loki estimate: ${a} needs a value\n`); return 1; } if (a === "--model") model = v; else provider = v; }
    else if (a.startsWith("--model=") || a.startsWith("--provider=")) {
      const name = a.startsWith("--model=") ? "--model" : "--provider", v = a.slice(name.length + 1);
      if (!v || v.startsWith("-")) { err(`loki estimate: ${name} needs a value\n`); return 1; }
      if (name === "--model") model = v; else provider = v;
    }
    else if (a === "--iterations" || a.startsWith("--iterations=")) { err("loki estimate: --iterations was removed; the estimate now comes from this repo's run history (same as 'loki start'). Run 'loki estimate --help'.\n"); return 1; }
    else { err(`Unknown option: ${a}\nRun 'loki estimate --help' for usage.\n`); return 1; }
  }
  if (!VALID_PROVIDERS.has(provider)) { err(`loki estimate: unknown --provider '${provider}' (use one of: ${[...VALID_PROVIDERS].join(", ")})\n`); return 1; }
  if (model !== undefined && provider === "claude" && !CLAUDE_MODEL_RE.test(model)) { err(`loki estimate: unknown --model '${model}' for provider claude (use a claude-* model id or opus, sonnet, haiku)\n`); return 1; }
  if (!previewOn(d.env)) { out(json ? '{"ok":false,"reason":"cost preview is off (LOKI_COST_PREVIEW=0)"}\n' : "estimate: OFF (LOKI_COST_PREVIEW=0)\n"); return 0; }
  const r = estimateFor(d.repoDir, d.cacheRoot, { model: model ?? (d.resolve ?? resolveModel)(provider), env: d.env });
  out(json ? `${JSON.stringify(r)}\n` : `${startText(r)}\n`);
  return 0;
}
