// 11.3.0 T1: cost preview. The estimate is read from the existing per-repo, per-shape run history
// (runner/router/history_store.ts); nothing here estimates from the task text or the repo's file
// names (Engine Law L0). No usable history prints "NOT AVAILABLE (<reason>)", never a number.
// Off with LOKI_COST_PREVIEW=0: no start-line text, no receipt block, no history append.
import { repoKey } from "../../engine10/cache.ts";
import { resolveModel } from "../../engine10/session.ts";
import { appendRunOutcome, readRunHistory, shapeKeyForRepo, WALL_KIND, type RunOutcome } from "./history.ts";
import { readOriginUrl } from "../../util/engine_origin.ts";
import { resolveRunProvider } from "../state.ts";
import { REMOVED_PROVIDERS, VALID_PROVIDERS, unsupportedProviderMessage } from "../types.ts";
import { PROVIDER_DEFAULT_MODEL } from "../../util/claude_model.ts";
import { presetExecutor, routerPreset } from "./flag.ts";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MIN_RUNS = 3;
const WINDOW = 20;
export const NOT_RECORDED = "NOT RECORDED";

export interface Estimate { shape: string; runs: number; usd: [number, number]; usd_mid?: number; wall_s: [number, number] | null; wall_mid_s?: number | null } // wall_s null = no prior run carries a reconciled total (old history is ignored for time)
export interface Prior { usd: [number, number]; usd_mid: number; wall_s: [number, number]; wall_mid_s: number; tier: string; size_class: string }
export type EstimateResult = { ok: true; est: Estimate } | { ok: false; reason: string; prior?: Prior };
export type Env = Record<string, string | undefined>;

export const previewOn = (env: Env): boolean => env["LOKI_COST_PREVIEW"] !== "0";

export interface PriorOpts { model?: string; env?: Env }

// First-run prior, used only when a shape has no usable history. Keyed by the h2h config the run most resembles; the
// class is never read from task wording. Every number is the nearest-rank p10 / p50 / p90 (sorted[round(p*(n-1))]) of
// cost_usd and seconds over the rows of that config in the committed citable benchmark files below (every outcome
// counted, cost_usd and seconds > 0). tests/min/outcome-metrics.sh recomputes them from these exact files.
export const PRIOR_SOURCES: Record<string, string[]> = {
  "loki-default": ["2026-11-01-e13f3dd72-hard.json"],
  "loki-haiku": ["2026-11-01-e13f3dd72-hard.json", "2026-11-02-0aed07b0f.json", "2026-11-02-4713c5e5b.json", "2026-11-02-5063feb95-replay.json", "2026-11-02-5063feb95.json", "2026-11-02-52904268a-replay.json", "2026-11-02-52904268a.json", "2026-11-02-78fa98c9f.json", "2026-11-02-adf20d7ff.json", "2026-11-04-0972a4f97.json"],
  "loki-haiku-flag": ["2026-11-02-haiku-wall-916ddc95a.json", "2026-11-03-haiku-wall-ae30e6efb.json"],
  "loki-sonnet": ["2026-11-01-e13f3dd72-hard.json"],
  "loki-opus": ["2026-11-01-e13f3dd72-hard.json"],
};
export const PRIOR: Record<"loki-default" | "loki-haiku" | "loki-haiku-flag" | "loki-sonnet" | "loki-opus", { usd: [number, number]; usd_mid: number; wall_s: [number, number]; wall_mid_s: number; n: number }> = {
  "loki-default": { usd: [0.119, 0.394], usd_mid: 0.194, wall_s: [55, 308], wall_mid_s: 82, n: 24 },
  "loki-haiku": { usd: [0.003, 0.032], usd_mid: 0.007, wall_s: [17, 169], wall_mid_s: 31, n: 368 },
  "loki-haiku-flag": { usd: [0.002, 0.035], usd_mid: 0.006, wall_s: [15, 157], wall_mid_s: 26, n: 96 },
  "loki-sonnet": { usd: [0.07, 0.222], usd_mid: 0.149, wall_s: [37, 288], wall_mid_s: 64, n: 24 },
  "loki-opus": { usd: [0.126, 0.411], usd_mid: 0.209, wall_s: [55, 363], wall_mid_s: 84, n: 24 },
};

/** The benchmark config a run is quoted against: the router preset executor, else the provider-default model, else the model family; null when none applies. */
export function quoteConfig(model: string | undefined, env: Env): keyof typeof PRIOR | null {
  if (routerPreset(env) && /haiku/i.test(presetExecutor(env).model)) return "loki-haiku-flag";
  if (model === PROVIDER_DEFAULT_MODEL) return "loki-default";
  return /haiku/i.test(model ?? "") ? "loki-haiku" : /sonnet/i.test(model ?? "") ? "loki-sonnet" : /opus/i.test(model ?? "") ? "loki-opus" : null;
}

export function priorFor(model: string | undefined, env: Env = {}): Prior | null {
  const config = quoteConfig(model, env);
  if (!config) return null;
  const p = PRIOR[config];
  return { usd: [p.usd[0], p.usd[1]], usd_mid: p.usd_mid, wall_s: [p.wall_s[0], p.wall_s[1]], wall_mid_s: p.wall_mid_s, tier: config, size_class: "unplanned" };
}

export function estimateFor(repoDir: string, cacheRoot?: string, opts?: PriorOpts): EstimateResult {
  return estimateFromHistory(shapeKeyForRepo(repoDir), repoKey(readOriginUrl(repoDir), repoDir), cacheRoot, opts);
}

export function estimateFromHistory(shape: string | null, key: string, cacheRoot?: string, opts?: PriorOpts): EstimateResult {
  const withPrior = (reason: string): EstimateResult => {
    const prior = opts?.env?.["LOKI_COST_PRIOR"] === "0" ? null : priorFor(opts?.model, opts?.env ?? {});
    return prior ? { ok: false, reason, prior } : { ok: false, reason };
  };
  if (shape === null) return withPrior("no project shape recorded for this repo");
  const runs = readRunHistory(key, cacheRoot).filter((r) => r.shape === shape && r.verdict === "pass").slice(-WINDOW);
  if (runs.length < MIN_RUNS) return withPrior(`${runs.length} prior verified run${runs.length === 1 ? "" : "s"} for shape ${shape}, need ${MIN_RUNS}`);
  const usd = runs.map((r) => r.usd), wall = runs.filter((r) => r.wallKind === WALL_KIND).map((r) => r.wallS);
  return { ok: true, est: { shape, runs: runs.length, usd: [Math.min(...usd), Math.max(...usd)], usd_mid: median(usd), wall_s: wall.length > 0 ? [Math.min(...wall), Math.max(...wall)] : null, wall_mid_s: wall.length > 0 ? median(wall) : null } };
}

const median = (v: number[]): number => { const a = [...v].sort((x, y) => x - y), m = a.length >> 1; return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2; };
const fmtUsd = (v: number): string => (v < 0.005 ? "<$0.01" : `$${v.toFixed(2)}`);
const minOf = (s: number): number => Math.max(1, Math.round(s / 60));
const timeClause = (mid: number, lo: number, hi: number): string => `about ${minOf(mid)} min (range ${minOf(lo)}-${minOf(hi)} min)`;

export function startText(r: EstimateResult, capUsd = 0): string {
  const base = startBase(r), high = r.ok ? r.est.usd[1] : r.prior?.usd[1];
  return capUsd > 0 && high !== undefined && high > capUsd ? `${base}; WARNING estimate high $${high.toFixed(2)} exceeds cap $${capUsd.toFixed(2)}` : base;
}

function startBase(r: EstimateResult): string {
  if (!r.ok && r.prior) { const p = r.prior; return `estimate: about ${fmtUsd(p.usd_mid)} (range ${fmtUsd(p.usd[0])}-${fmtUsd(p.usd[1])}), ${timeClause(p.wall_mid_s, p.wall_s[0], p.wall_s[1])}, first run in this repo (benchmark prior, ${p.tier})`; }
  if (!r.ok) return `estimate: NOT AVAILABLE (${r.reason})`;
  const { est: e } = r, mid = e.usd_mid ?? (e.usd[0] + e.usd[1]) / 2;
  const time = e.wall_s ? timeClause(e.wall_mid_s ?? (e.wall_s[0] + e.wall_s[1]) / 2, e.wall_s[0], e.wall_s[1]) : "time NOT RECORDED";
  return `estimate: about ${fmtUsd(mid)} (range ${fmtUsd(e.usd[0])}-${fmtUsd(e.usd[1])}), ${time}, from ${e.runs} prior runs of shape ${e.shape}`;
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
    estimate: !r.ok && r.prior ? { usd_low: r.prior.usd[0], usd_high: r.prior.usd[1], usd_mid: r.prior.usd_mid, wall_low_s: r.prior.wall_s[0], wall_high_s: r.prior.wall_s[1], wall_mid_s: r.prior.wall_mid_s, tier: r.prior.tier, size_class: r.prior.size_class } : r.ok === true ? { usd_low: r.est.usd[0], usd_high: r.est.usd[1], ...(r.est.usd_mid !== undefined ? { usd_mid: r.est.usd_mid } : {}), ...(r.est.wall_mid_s != null ? { wall_mid_s: r.est.wall_mid_s } : {}), wall_low_s: r.est.wall_s?.[0] ?? NOT_RECORDED, wall_high_s: r.est.wall_s?.[1] ?? NOT_RECORDED, prior_runs: r.est.runs, shape: r.est.shape } : `NOT AVAILABLE (${r.reason ?? "unreadable estimate"})`,
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

export interface QuoteAccuracy { n: number; within_range: number; median_abs_pct_error: number | null; by_source: { history: number; rough_prior: number } }

/** How accurate the start quote was over the newest `last` sealed runs (receipt.json cost_preview). Receipts with no numeric estimate or no metered actual are skipped, never counted as 0. Capped runs have no receipt and are not covered. */
export function quoteAccuracy(runsDir: string, last = 50): QuoteAccuracy {
  const res: QuoteAccuracy = { n: 0, within_range: 0, median_abs_pct_error: null, by_source: { history: 0, rough_prior: 0 } };
  let ids: string[];
  try { ids = readdirSync(runsDir).sort().slice(-last); } catch { return res; }
  const errs: number[] = [];
  for (const id of ids) {
    let cp: Record<string, unknown> | undefined;
    try { cp = (JSON.parse(readFileSync(join(runsDir, id, "receipt.json"), "utf8")) as { cost_preview?: Record<string, unknown> }).cost_preview; } catch { continue; }
    const est = cp?.["estimate"] as Record<string, unknown> | undefined, actual = (cp?.["actual"] as Record<string, unknown> | undefined)?.["usd"];
    if (!est || typeof est !== "object") continue;
    const lo = est["usd_low"], hi = est["usd_high"], mid = typeof est["usd_mid"] === "number" ? est["usd_mid"] : null;
    if (typeof lo !== "number" || typeof hi !== "number" || typeof actual !== "number" || !(actual > 0)) continue;
    res.n++;
    if (lo <= actual && actual <= hi) res.within_range++;
    errs.push(Math.abs(actual - (mid ?? (lo + hi) / 2)) / actual);
    if (cp?.["estimate_source"] === "history") res.by_source.history++; else if (cp?.["estimate_source"] === "rough_prior") res.by_source.rough_prior++;
  }
  if (errs.length > 0) res.median_abs_pct_error = median(errs);
  return res;
}

export const ESTIMATE_HELP = `loki estimate - Show what a run is likely to cost

Usage: loki estimate [--model M] [--provider P] [--json]

Prints the same quote "loki start" prints before a run: "about $X (range $lo-$hi),
about N min (range a-b min)" from this repo's prior verified runs of the same project
shape. With fewer than ${MIN_RUNS} such runs it prints the benchmark prior for the model
(measured p10 / p50 / p90 of citable runs in benchmarks/h2h/results, files listed in
PRIOR_SOURCES in runner/router/cost_preview.ts), or NOT AVAILABLE (reason) when the
model has no benchmark row (for example an opencode model). LOKI_ROUTER=auto and
"loki start --haiku" quote the haiku-flag band. LOKI_COST_PRIOR=0 drops the first-run
prior. It never estimates from task text. "loki stats --outcomes" reports how accurate
the quote was over the last 50 sealed runs.

Options:
  --model M      Model whose first-run prior to use when there is no history (default: the start model, or the provider default)
  --provider P   Provider whose default model is used (default: LOKI_PROVIDER or claude)
  --json         Machine-readable output (the estimate result object)
  --help, -h     Show this help

Changed: --iterations is removed. The old iteration-based projection (tools/estimate-run.py)
is replaced by this single estimator. LOKI_COST_PREVIEW=0 turns the estimate off.
The time range is the benchmark or history wall time, in whole minutes (minimum 1).

Examples:
  loki estimate
  loki estimate --json

See also: loki cost --detail (what a run ALREADY spent)
`;

// Provider list: runner/types.ts (shared with `loki start` and the control plane). Only claude has a closed model vocabulary; opencode takes free-form provider/model ids.
const CLAUDE_MODEL_RE = /^(claude-[A-Za-z0-9._-]+|opus|sonnet|haiku|small|medium|high)$/i;

/** `loki estimate`: one estimator, the one `loki start` prints. resolve maps a provider to its start model. */
export function runEstimate(args: readonly string[], d: { repoDir: string; env: Env; resolve?: (provider: string) => string; cacheRoot?: string; out?: (s: string) => void; err?: (s: string) => void }): number {
  const out = d.out ?? ((s: string) => void process.stdout.write(s)), err = d.err ?? ((s: string) => void process.stderr.write(s));
  let json = false, model: string | undefined, provider: string | undefined;
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
  const rp = resolveRunProvider(provider, d.env, d.repoDir); provider = rp.provider; // flag, LOKI_PROVIDER, the saved project choice, else claude
  if (rp.refusal) { err(rp.refusal); return 2; }
  if (!VALID_PROVIDERS.has(provider)) { err(unsupportedProviderMessage("loki estimate", "--provider", provider)); return REMOVED_PROVIDERS.has(provider) ? 2 : 1; }
  if (model !== undefined && provider === "claude" && !CLAUDE_MODEL_RE.test(model)) { err(`loki estimate: unknown --model '${model}' for provider claude (use a claude-* model id or opus, sonnet, haiku)\n`); return 1; }
  if (!previewOn(d.env)) { out(json ? '{"ok":false,"reason":"cost preview is off (LOKI_COST_PREVIEW=0)"}\n' : "estimate: OFF (LOKI_COST_PREVIEW=0)\n"); return 0; }
  const r = estimateFor(d.repoDir, d.cacheRoot, { model: model ?? (d.resolve ?? resolveModel)(provider), env: d.env });
  out(json ? `${JSON.stringify(r)}\n` : `${startText(r)}\n`);
  return 0;
}
