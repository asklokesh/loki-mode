// CPE24-P1: the per-checkout cost ledger, ported from dashboard/server.py (/api/cost, /api/cost/timeline). Same on-disk sources:
// <repo>/.loki/metrics/efficiency/iteration-*.json, metrics/budget.json, context/tracking.json, proofs/<run>/proof.json, pricing.json.
// Honest data: a present record is not a measurement. Anything not measured is null, never a summed 0.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { probeAllowed, type RouteCtx } from "./index.ts";

type Rec = Record<string, unknown>;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

export const MEASURED_FIELDS = ["cost_usd", "input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens"] as const;
export const BUDGET_WARN_FRACTION = 0.8;
export const NOT_MEASURED = "not measured";

export function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

/** One record carries an observed (non-zero numeric) value in at least one measured field; mirrors autonomy/lib/efficiency_cost.py record_is_measured. */
export function recordIsMeasured(rec: unknown, skip?: string): boolean {
  if (!isObj(rec)) return false;
  return MEASURED_FIELDS.some((k) => k !== skip && isNum(rec[k]) && rec[k] !== 0);
}

const DEFAULT_PRICING: Record<string, Rec> = {
  fable: { input: 10, output: 50 }, "claude-fable-5": { input: 10, output: 50 },
  opus: { input: 5, output: 25 }, sonnet: { input: 2, output: 10 }, haiku: { input: 1, output: 5 },
  "gpt-5.3-codex": { input: 1.5, output: 12 },
  "gpt-5.6-sol": { input: 2.5, output: 20 }, "gpt-5.6-terra": { input: 1.5, output: 12 }, "gpt-5.6-luna": { input: 0.5, output: 4 },
};

function pricing(lokiDir: string): Record<string, Rec> {
  const d = readJson(join(lokiDir, "pricing.json"));
  const models = isObj(d) && isObj(d.models) ? (d.models as Record<string, Rec>) : {};
  return { ...DEFAULT_PRICING, ...models };
}

/** Token-priced USD with cache tiers; an unpriced cache tier falls back to the input rate (over-state, never under-count). */
export function modelCost(table: Record<string, Rec>, model: string, inp: number, out: number, cr = 0, cw = 0): number {
  const p = table[model.toLowerCase()] ?? table.sonnet ?? {};
  const ir = isNum(p.input) ? p.input : 3;
  const or = isNum(p.output) ? p.output : 15;
  const crr = isNum(p.cache_read) ? p.cache_read : ir * 0.1;
  const cwr = isNum(p.cache_write) ? p.cache_write : ir * 1.25;
  return r6((inp * ir + out * or + cr * crr + cw * cwr) / 1e6);
}

/** Parsed iteration-*.json records in filename order (the file set the budget breaker reads). */
export function iterationRecords(lokiDir: string): Rec[] {
  const dir = join(lokiDir, "metrics", "efficiency");
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => /^iteration-.*\.json$/.test(n)).sort(); } catch { return []; }
  const out: Rec[] = [];
  for (const n of names) { const d = readJson(join(dir, n)); if (isObj(d)) out.push(d); }
  return out;
}

const num0 = (v: unknown) => (isNum(v) ? v : 0);
const priced = (table: Record<string, Rec>, d: Rec) =>
  d.cost_usd === null || d.cost_usd === undefined
    ? modelCost(table, String(d.model ?? "sonnet").toLowerCase(), num0(d.input_tokens), num0(d.output_tokens), num0(d.cache_read_tokens), num0(d.cache_creation_tokens))
    : num0(d.cost_usd);

interface Bucket { input_tokens: number; output_tokens: number; cost_usd: number; measured: boolean; tokens_measured: boolean }

export function costSnapshot(lokiDir: string) {
  const table = pricing(lokiDir);
  let tIn = 0, tOut = 0, tCr = 0, tCw = 0, est = 0;
  let recorded = false, unknownUsd = false;
  const byPhase: Record<string, Bucket> = {}, byModel: Record<string, Bucket> = {};
  for (const d of iterationRecords(lokiDir)) {
    const measured = recordIsMeasured(d);
    if (measured) recorded = true;
    const tokMeasured = recordIsMeasured(d, "cost_usd");
    const inp = num0(d.input_tokens), out = num0(d.output_tokens), cr = num0(d.cache_read_tokens), cw = num0(d.cache_creation_tokens);
    const model = String(d.model ?? "sonnet").toLowerCase();
    const phase = String(d.phase ?? "unknown");
    tIn += inp; tOut += out; tCr += cr; tCw += cw;
    const cost = priced(table, d);
    est += cost;
    for (const [bucket, name] of [[byPhase, phase], [byModel, model]] as const) {
      const b = (bucket[name] ??= { input_tokens: 0, output_tokens: 0, cost_usd: 0, measured: false, tokens_measured: false });
      b.input_tokens += inp; b.output_tokens += out; b.cost_usd += cost;
      b.measured ||= measured; b.tokens_measured ||= tokMeasured;
    }
  }
  if (tIn === 0 && tOut === 0) {
    const ctx = readJson(join(lokiDir, "context", "tracking.json"));
    const totals = isObj(ctx) && isObj(ctx.totals) ? ctx.totals : {};
    tIn = num0(totals.total_input); tOut = num0(totals.total_output);
    if (tIn > 0 || tOut > 0) {
      recorded = true;
      if (isNum(totals.total_cost_usd)) est = totals.total_cost_usd; else unknownUsd = true;
      const model = String((isObj(ctx) && ctx.provider) || "unknown").toLowerCase();
      const per = isObj(ctx) && Array.isArray(ctx.per_iteration) ? ctx.per_iteration : [];
      for (const it of per) {
        if (!isObj(it)) continue;
        const b = (byModel[model] ??= { input_tokens: 0, output_tokens: 0, cost_usd: 0, measured: false, tokens_measured: true });
        b.input_tokens += num0(it.input_tokens); b.output_tokens += num0(it.output_tokens);
        if (isNum(it.cost_usd)) { b.cost_usd += it.cost_usd; b.measured = true; }
      }
    }
  }
  let limit: number | null = null, used: number | null = null, remaining: number | null = null;
  const bd = readJson(join(lokiDir, "metrics", "budget.json"));
  if (isObj(bd) && isNum(bd.limit)) {
    limit = bd.limit;
    if (recorded && !unknownUsd) { used = est; remaining = Math.max(0, limit - used); }
  }
  const readIn = tIn + tCr;
  const fmt = (m: Record<string, Bucket>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, {
    input_tokens: v.tokens_measured ? v.input_tokens : null, output_tokens: v.tokens_measured ? v.output_tokens : null,
    cost_usd: v.measured ? r6(v.cost_usd) : null,
  }]));
  return {
    total_input_tokens: recorded ? tIn : null, total_output_tokens: recorded ? tOut : null,
    total_cache_read_tokens: recorded ? tCr : null, total_cache_creation_tokens: recorded ? tCw : null,
    total_tokens: recorded ? tIn + tOut + tCr + tCw : null,
    cache_hit_ratio: readIn > 0 ? Math.round((tCr / readIn) * 1e4) / 1e4 : null,
    estimated_cost_usd: recorded && !unknownUsd ? r6(est) : null,
    cost_recorded: recorded,
    by_phase: fmt(byPhase), by_model: fmt(byModel),
    budget_limit: limit, budget_used: limit !== null && used !== null ? r6(used) : null, budget_remaining: remaining !== null ? r6(remaining) : null,
    ...(recorded ? {} : { not_measured: NOT_MEASURED }),
  };
}

export function budgetStatus(used: number | null, limit: number | null): "none" | "unknown" | "ok" | "warn" | "exceeded" {
  if (limit === null || limit <= 0) return "none";
  if (used === null) return "unknown";
  if (used >= limit) return "exceeded";
  return used >= BUDGET_WARN_FRACTION * limit ? "warn" : "ok";
}

export function budgetSnapshot(lokiDir: string) {
  const table = pricing(lokiDir);
  let total = 0, recorded = false, unmeasured = 0;
  for (const d of iterationRecords(lokiDir)) {
    if (recordIsMeasured(d)) recorded = true; else unmeasured++;
    total += priced(table, d);
  }
  let limit: number | null = null;
  const bd = readJson(join(lokiDir, "metrics", "budget.json"));
  if (isObj(bd)) { const l = bd.limit || bd.budget_limit; limit = isNum(l) ? l : null; }
  if (limit === null && process.env.LOKI_BUDGET_LIMIT) { const e = Number(process.env.LOKI_BUDGET_LIMIT); if (Number.isFinite(e)) limit = e; }
  const used = recorded ? r6(total) : null;
  const ok = limit !== null && limit > 0 && used !== null;
  const status = budgetStatus(used, limit);
  return {
    limit, used, remaining: ok ? r6(Math.max(0, limit! - used!)) : null, percent_used: ok ? Math.round((used! / limit!) * 1e4) / 100 : null,
    status, warn_threshold_percent: Math.round(BUDGET_WARN_FRACTION * 100), exceeded: status === "exceeded", partial: recorded && unmeasured > 0,
  };
}

export function costTimeline(lokiDir: string) {
  const table = pricing(lokiDir);
  const recs = iterationRecords(lokiDir).map((d, i) => ({ d, i }))
    .sort((a, b) => (num0(Number(a.d.iteration)) - num0(Number(b.d.iteration))) || a.i - b.i).map((x) => x.d);
  const iterations: Rec[] = [];
  let cum = 0, recorded = false, unmeasured = 0;
  for (const d of recs) {
    const measured = recordIsMeasured(d);
    if (measured) recorded = true; else unmeasured++;
    const model = String(d.model ?? "sonnet").toLowerCase();
    cum += priced(table, d);
    iterations.push({
      iteration: d.iteration ?? null, timestamp: d.timestamp ?? null, model: d.model ? model : null, phase: d.phase ?? "unknown", provider: d.provider ?? null,
      input_tokens: measured ? num0(d.input_tokens) : null, output_tokens: measured ? num0(d.output_tokens) : null,
      cost_usd: measured ? r6(priced(table, d)) : null, cumulative_usd: measured ? r6(cum) : null,
    });
  }
  const runs: Rec[] = [];
  let projectTotal = 0, runsMeasured = 0;
  const proofs = join(lokiDir, "proofs");
  let entries: string[] = [];
  try { entries = readdirSync(proofs).sort(); } catch { /* none */ }
  for (const e of entries) {
    try { if (!statSync(join(proofs, e)).isDirectory()) continue; } catch { continue; }
    const p = readJson(join(proofs, e, "proof.json"));
    if (!isObj(p)) continue;
    const cost = isObj(p.cost) ? p.cost : {};
    const usd = isNum(cost.usd) ? cost.usd : null;
    if (usd !== null) { projectTotal += usd; runsMeasured++; }
    runs.push({
      run_id: p.run_id ?? e, generated_at: p.generated_at ?? null, model: isObj(p.provider) ? (p.provider.model ?? null) : null,
      cost_usd: usd !== null ? r6(usd) : null, cost_partial: cost.cost_partial === true,
      files_changed: isObj(p.files_changed) ? (p.files_changed.count ?? null) : null, final_verdict: isObj(p.council) ? (p.council.final_verdict ?? null) : null,
    });
  }
  runs.sort((a, b) => String(b.generated_at ?? "").localeCompare(String(a.generated_at ?? "")));
  return {
    current_run: { iterations, total_usd: recorded ? r6(cum) : null, cost_recorded: recorded, partial: recorded && unmeasured > 0, unmeasured_iterations: unmeasured },
    runs, runs_count: runs.length,
    project_total_usd: runsMeasured ? r6(projectTotal) : null, project_total_partial: runsMeasured > 0 && runsMeasured < runs.length,
    budget: budgetSnapshot(lokiDir),
    ...(recorded || runsMeasured ? {} : { not_measured: NOT_MEASURED }),
  };
}

export const lokiDirOf = (repoDir: string) => join(repoDir, ".loki");
export const lokiDirExists = (repoDir: string) => existsSync(lokiDirOf(repoDir));

export function mount(ctx: RouteCtx): void {
  // Disk-reading routes: with a token the bearer (tokenGuard) is the gate; without one they are loopback-only, like the probe routes.
  const deny = { error: "loopback only without a token" };
  ctx.app.get("/v1/cost/snapshot", (c) => (probeAllowed(ctx, c) ? c.json(costSnapshot(lokiDirOf(ctx.repoDir))) : c.json(deny, 403)));
  ctx.app.get("/v1/cost/timeline", (c) => (probeAllowed(ctx, c) ? c.json(costTimeline(lokiDirOf(ctx.repoDir))) : c.json(deny, 403)));
}
