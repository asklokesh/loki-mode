// Budget tracking and rate-limit detection for the autonomous loop.
// Mirrors bash autonomy/run.sh:
//   - check_budget_limit
//   - is_rate_limited
//   - parse_retry_after
//   - calculate_rate_limit_backoff
// Spec: loki-ts/docs/phase4-research/checkpoint_budget.md sections 6-9.
//
// State file format (.loki/metrics/budget.json) is byte-identical to bash:
// the JSON object is written via cat-heredoc with no JSON encoder, but the
// fields and ordering here match the heredoc layout in run.sh check_budget_limit()
// (the BUDGET_EOF heredocs).

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pricingJson from "../../data/model-pricing.json" with { type: "json" };
import { atomicWriteText } from "../util/atomic.ts";
import { inferenceGeoMultiplier } from "../providers/model_routes.ts";
import { lokiDir } from "../util/paths.ts";
import { type CostResult, type EfficiencySessionInfo, num, writeEfficiencyRecord } from "../engine10/cost.ts";

// LM-002: the default per-run cap (default_max_cost_usd) lives in loki-ts/data/model-pricing.json, also read by autonomy/run.sh and autonomy/loki.
// The data dir is ../../data from src/runner (this file) and ../data from the bundled dist; the literal is only the last-resort fallback, and a test pins it to the file.
const DEFAULT_FALLBACK_USD = 100;
let pricingFallbackWarned = false;
export function resetPricingFallbackWarning(): void { pricingFallbackWarned = false; }
export function loadDefaultMaxCostUsd(dataDirs: string[][] = [["..", "..", "data"], ["..", "data"]]): number {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of dataDirs) {
    try {
      const j = JSON.parse(readFileSync(resolve(here, ...rel, "model-pricing.json"), "utf8")) as { default_max_cost_usd?: unknown };
      if (typeof j.default_max_cost_usd === "number" && Number.isFinite(j.default_max_cost_usd) && j.default_max_cost_usd > 0) return j.default_max_cost_usd;
    } catch { /* try the next location */ }
  }
  if (!pricingFallbackWarned) {
    pricingFallbackWarned = true;
    process.stderr.write(`loki: warning: model-pricing.json is missing or unreadable (looked in ${dataDirs.map((r) => resolve(here, ...r)).join(", ")}); using fallback default max cost $${DEFAULT_FALLBACK_USD}\n`);
  }
  return DEFAULT_FALLBACK_USD;
}

// The one price table: loki-ts/data/model-pricing.json, imported so the bundle carries it. A runtime read
// resolved ../../data from dist/loki.js, a path that does not exist, so every shipped build priced from a
// hand-copied fallback table that had drifted from the JSON (no gpt-5.6 or claude-fable-5 rows).
// autonomy/run.sh, the dashboard and the Python tools read the same file at run time.
type PricingEntry = {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
  // Explicit write tiers (cache_write stays the 5m rate for legacy readers).
  cache_write_5m?: number;
  cache_write_1h?: number;
  // Rates for a prompt over 100,000 tokens (Haiku 5.5 only). Carried so
  // callers that know per-request size can price the tier; the aggregate
  // record paths cannot see request size and use the base rates.
  over_100k?: { input: number; output: number; cache_read?: number; cache_write?: number; cache_write_5m?: number; cache_write_1h?: number };
};
type PricingMap = Record<string, PricingEntry>;

// Carry the cache tiers through: copying only input/output made the `?? p.input` fallback in the cost loop
// charge cache reads at the full input rate, a 10x overcharge on the term that dominates real traffic.
function pricingFromJson(pricing: Record<string, unknown>): PricingMap {
  const out: PricingMap = {};
  for (const [key, value] of Object.entries(pricing)) {
    const e = value as PricingEntry | null;
    if (e === null || typeof e !== "object" || typeof e.input !== "number" || typeof e.output !== "number") continue;
    out[key] = {
      input: e.input,
      output: e.output,
      ...(typeof e.cache_read === "number" ? { cache_read: e.cache_read } : {}),
      ...(typeof e.cache_write === "number" ? { cache_write: e.cache_write } : {}),
      ...(typeof e.cache_write_5m === "number" ? { cache_write_5m: e.cache_write_5m } : {}),
      ...(typeof e.cache_write_1h === "number" ? { cache_write_1h: e.cache_write_1h } : {}),
      ...(e.over_100k && typeof e.over_100k.input === "number" && typeof e.over_100k.output === "number" ? { over_100k: e.over_100k } : {}),
    };
  }
  return out;
}

export const PRICING: Readonly<Record<string, PricingEntry>> = Object.freeze(pricingFromJson(pricingJson.pricing));

const DEFAULT_PRICING_KEY = "sonnet";

// .loki/metrics/budget.json schema. exceeded_at only present when exceeded=true.
export interface BudgetState {
  limit: number;
  budget_limit: number;
  budget_used: number;
  exceeded: boolean;
  exceeded_at?: string;
  created_at?: string;
}

// Per-iteration efficiency record produced elsewhere (run.sh track_iteration_complete()).
// Either cost_usd is present (use directly) or input/output_tokens + model.
export interface EfficiencyRecord {
  cost_usd?: number;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  // Cache tiers. Writers have emitted these since v6.82.0 (run.sh check_budget_limit() cost calc) and
  // they dominate real traffic -- a measured iteration shows 797,496 cache-read
  // against 10,272 plain input tokens. Omitting them from this type is what
  // made the fallback price them at zero.
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
}

export interface CheckBudgetResult {
  exceeded: boolean;
  // R3 anti-surprise warn: true when spend is in [80%, 100%) of the cap, OR
  // (S-131) when a cap is set but spend could not be measured at all (no
  // efficiency records found). The orchestrator logs this without pausing;
  // the hard stop is `exceeded`.
  warn: boolean;
  current_cost: number;
  limit: number | null;
  // S-131: false when no efficiency records exist, so current_cost is an
  // unmeasured $0 rather than a confirmed zero spend. A cap must never be
  // silently treated as satisfied by an absence of data.
  measured: boolean;
}

// Budget warn threshold: warn at 80% of the cap, before the hard stop at 100%.
// Mirrors run.sh check_budget_limit() and dashboard _BUDGET_WARN_FRACTION.
const BUDGET_WARN_FRACTION = 0.8;

export interface CheckBudgetOptions {
  budgetLimit?: number | string | null;
  iteration?: number;
  efficiencyDir?: string;
  budgetFile?: string;
  pauseFile?: string;
  signalsDir?: string;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Cost calculation
// ---------------------------------------------------------------------------

// Round to 4 decimals (matches Python `round(total, 4)` at run.sh check_budget_limit()).
// Uses Number.EPSILON-style rounding via toFixed for consistency.
function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

// Resolve pricing for a model name, defaulting to sonnet (run.sh check_budget_limit()).
function pricingFor(model: string | undefined): {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
} {
  const key = (model ?? DEFAULT_PRICING_KEY).toLowerCase();
  return PRICING[key] ?? PRICING[exactIdKey(key) ?? ""] ?? PRICING[DEFAULT_PRICING_KEY]!;
}

// Exact model-id key lookup: the key itself, or the longest versioned id key
// (a claude-* key containing a digit, e.g. claude-haiku-5-5) that prefixes a
// dated id like claude-haiku-5-5-20261006. Family aliases (haiku, sonnet) are
// not matched here; they keep the existing substring path.
function exactIdKey(m: string): string | undefined {
  if (m in PRICING) return m;
  let best: string | undefined;
  for (const k of Object.keys(PRICING)) {
    if (!/\d/.test(k) || !k.startsWith("claude-")) continue;
    if (m.startsWith(k + "-") && (!best || k.length > best.length)) best = k;
  }
  return best;
}

// Calculate total cost from a list of efficiency records.
// Mirrors the run.sh check_budget_limit() Python block.
export function calculateCostFromRecords(records: readonly EfficiencyRecord[], env: Record<string, string | undefined> = process.env): number {
  let total = 0;
  // LOKI_INFERENCE_GEO=us bills 1.1x. Applies to token-priced records only; a recorded cost_usd is the provider's own figure.
  const geo = inferenceGeoMultiplier(env);
  for (const d of records) {
    if (typeof d.cost_usd === "number" && Number.isFinite(d.cost_usd)) {
      total += d.cost_usd;
      continue;
    }
    const p = pricingFor(d.model);
    const inp = typeof d.input_tokens === "number" ? d.input_tokens : 0;
    const out = typeof d.output_tokens === "number" ? d.output_tokens : 0;
    const cRead = typeof d.cache_read_tokens === "number" ? d.cache_read_tokens : 0;
    const cWrite =
      typeof d.cache_creation_tokens === "number" ? d.cache_creation_tokens : 0;
    // Cache tiers fall back to the input rate when a pricing entry predates
    // them. That over-estimates rather than under-estimates: this is a BUDGET
    // circuit breaker, and the safe direction for an unknown rate is to stop
    // sooner, never to keep spending because a table row was missing.
    const readRate = p.cache_read ?? p.input;
    const writeRate = p.cache_write ?? p.input;
    total +=
      ((inp / 1_000_000) * p.input +
        (out / 1_000_000) * p.output +
        (cRead / 1_000_000) * readRate +
        (cWrite / 1_000_000) * writeRate) * geo;
  }
  return round4(total);
}

/**
 * Cache read tokens and the dollars they saved versus billing them at the plain input rate
 * (tokens times the model's input minus cache_read price, from model-pricing.json). Returns null
 * unless EVERY record carries a numeric cache_read_tokens: a missing key is unmeasured, never 0,
 * and a partial sum is not the run total. A measured 0 returns {0, 0}.
 */
export function cacheSavings(records: readonly Pick<EfficiencyRecord, "model" | "cache_read_tokens">[]): { readTokens: number; savedUsd: number } | null {
  if (records.length === 0) return null;
  let readTokens = 0;
  let saved = 0;
  for (const d of records) {
    const t = d.cache_read_tokens;
    if (typeof t !== "number" || !Number.isFinite(t)) return null;
    const p = pricingFor(d.model);
    readTokens += t;
    saved += (t / 1_000_000) * (p.input - (p.cache_read ?? p.input));
  }
  return { readTokens, savedUsd: round4(saved) };
}

// Read all .loki/metrics/efficiency/*.json files; bad files are skipped
// (matches Python `except: pass` in run.sh check_budget_limit()). Pass `stats` to learn how
// many were skipped.
export function readEfficiencyDir(dir: string, stats?: { skipped: number }): EfficiencyRecord[] {
  if (!existsSync(dir)) return [];
  const records: EfficiencyRecord[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  for (const f of entries) {
    if (!f.endsWith(".json")) continue;
    const fp = join(dir, f);
    try {
      const raw = readFileSync(fp, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        records.push(parsed as EfficiencyRecord);
      } else if (stats) {
        stats.skipped++;
      }
    } catch {
      if (stats) stats.skipped++;
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// Budget state I/O (atomic write via tmp + rename)
// ---------------------------------------------------------------------------

// Runtime validator for parsed budget.json content. Mirrors BudgetState shape.
// Required: limit, budget_limit, budget_used (finite numbers), exceeded (bool).
// Optional: exceeded_at, created_at (strings if present).
function isValidBudgetState(v: unknown): v is BudgetState {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o["limit"] !== "number" || !Number.isFinite(o["limit"])) return false;
  if (typeof o["budget_limit"] !== "number" || !Number.isFinite(o["budget_limit"])) return false;
  if (typeof o["budget_used"] !== "number" || !Number.isFinite(o["budget_used"])) return false;
  if (typeof o["exceeded"] !== "boolean") return false;
  if (o["exceeded_at"] !== undefined && typeof o["exceeded_at"] !== "string") return false;
  if (o["created_at"] !== undefined && typeof o["created_at"] !== "string") return false;
  return true;
}

const warnedCorruptBudget = new Set<string>();

// A corrupt budget.json must not reset spend to zero and disarm the cap. Rebuild
// budget_used from the efficiency records beside it; null only when there is
// nothing to rebuild from. Warns once per file.
function rebuildBudgetState(fp: string, efficiencyDir?: string): BudgetState | null {
  const stats = { skipped: 0 };
  const records = readEfficiencyDir(efficiencyDir ?? join(dirname(fp), "efficiency"), stats);
  if (!warnedCorruptBudget.has(fp)) {
    warnedCorruptBudget.add(fp);
    console.warn(`[budget] malformed budget state at ${fp}; rebuilding spend from ${records.length} efficiency record(s), skipped ${stats.skipped} malformed`);
  }
  if (records.length === 0) return null;
  const used = calculateCostFromRecords(records);
  const limit = parseBudgetLimit(process.env["BUDGET_LIMIT"] ?? null) ?? 0;
  return { limit, budget_limit: limit, budget_used: used, exceeded: limit > 0 && used >= limit };
}

export function readBudgetState(file?: string, efficiencyDir?: string): BudgetState | null {
  const fp = file ?? join(lokiDir(), "metrics", "budget.json");
  if (!existsSync(fp)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(fp, "utf8"));
  } catch {
    return rebuildBudgetState(fp, efficiencyDir);
  }
  if (!isValidBudgetState(parsed)) return rebuildBudgetState(fp, efficiencyDir);
  return parsed;
}

export function writeBudgetState(state: BudgetState, file?: string): void {
  const fp = file ?? join(lokiDir(), "metrics", "budget.json");
  mkdirSync(dirname(fp), { recursive: true });
  // Build JSON manually to mirror bash heredoc field ordering exactly.
  const lines: string[] = [];
  lines.push("{");
  lines.push(`  "limit": ${formatNumber(state.limit)},`);
  lines.push(`  "budget_limit": ${formatNumber(state.budget_limit)},`);
  lines.push(`  "budget_used": ${formatNumber(state.budget_used)},`);
  if (state.exceeded) {
    lines.push(`  "exceeded": true,`);
    const ts = state.exceeded_at ?? isoNow();
    lines.push(`  "exceeded_at": "${ts}"`);
  } else {
    lines.push(`  "exceeded": false`);
  }
  lines.push("}");
  const body = lines.join("\n") + "\n";
  // Atomic: write tmp then rename. Bash uses cat-heredoc directly (not atomic),
  // but rename is safer for concurrent reads from dashboard.
  atomicWriteText(fp, body);
}

// Format a number to match bash heredoc output. Integers stay integers.
function formatNumber(n: number): string {
  if (Number.isInteger(n)) return n.toString();
  return n.toString();
}

function isoNow(d: Date = new Date()): string {
  // Match bash `date -u +%Y-%m-%dT%H:%M:%SZ` (no millis).
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// Budget circuit breaker
// ---------------------------------------------------------------------------

// Parse BUDGET_LIMIT input. Bash strips non-numeric chars then float()-checks
// (run.sh check_budget_limit() -- `python3 -c "float('${BUDGET_LIMIT//[^0-9.]/}')"`). Returns
// null when no limit set / invalid.
//
// Parity (bug-hunt): bash validates the CLEANED string with python `float()`,
// which REJECTS a multi-dot string (e.g. "10.0.0", "1.2.3.4", "1..2" all raise
// ValueError -> check_budget_limit returns 1 = no limit, breaker disabled).
// `Number.parseFloat` is lenient: it stops at the second dot and returns a
// truncated number ("10.0.0" -> 10), which would ENFORCE a limit the user never
// validly set and trip the circuit breaker wrongly. Mirror python `float()` by
// rejecting any cleaned string that does not parse as a single decimal (at most
// one dot). `Number(cleaned)` (unlike parseFloat) is whole-string and yields NaN
// for multi-dot input, exactly matching python's all-or-nothing float().
function parseBudgetLimit(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const cleaned = v.replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  // Number() is whole-string (rejects "10.0.0" as NaN) where parseFloat would
  // truncate to 10. This matches bash's python float() all-or-nothing parse.
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Equivalent of check_budget_limit() in bash. Returns whether the budget was
// exceeded plus the computed cost. When exceeded, writes PAUSE/BUDGET_EXCEEDED
// signals and updates budget.json (run.sh check_budget_limit()).
//
// NOTE: this is a pure side-effecting helper; orchestrator decides what to do
// with the result. It does NOT emit events (event bus is C1's surface).
export function checkBudgetLimit(opts: CheckBudgetOptions = {}): CheckBudgetResult {
  const root = lokiDir();
  const limit = parseBudgetLimit(opts.budgetLimit ?? process.env["BUDGET_LIMIT"] ?? null);
  if (limit === null) {
    return { exceeded: false, warn: false, current_cost: 0, limit: null, measured: false };
  }

  const efficiencyDir = opts.efficiencyDir ?? join(root, "metrics", "efficiency");
  const budgetFile = opts.budgetFile ?? join(root, "metrics", "budget.json");
  const pauseFile = opts.pauseFile ?? join(root, "PAUSE");
  const signalsDir = opts.signalsDir ?? join(root, "signals");
  const now = opts.now ?? (() => new Date());

  const records = readEfficiencyDir(efficiencyDir);
  const measured = records.length > 0;
  const current = calculateCostFromRecords(records);

  // S-131: a cap is set but nothing has been measured yet -- there is no
  // efficiency data to compute spend from. $0 here is an absence of
  // measurement, not a confirmed zero cost, so never pause and never mark
  // exceeded on it; just surface it as a warning for a human to notice.
  if (!measured) {
    return { exceeded: false, warn: true, current_cost: 0, limit, measured: false };
  }

  // Greater-than-OR-equal (run.sh check_budget_limit()).
  const exceeded = current >= limit;

  if (exceeded) {
    const ts = isoNow(now());
    // PAUSE marker (run.sh check_budget_limit()).
    mkdirSync(dirname(pauseFile), { recursive: true });
    writeFileSync(pauseFile, "");
    // Signal payload (run.sh check_budget_limit(), BUDGET_EXCEEDED).
    mkdirSync(signalsDir, { recursive: true });
    const signal = {
      type: "BUDGET_EXCEEDED",
      limit,
      current,
      timestamp: ts,
    };
    writeFileSync(join(signalsDir, "BUDGET_EXCEEDED"), JSON.stringify(signal));
    writeBudgetState(
      {
        limit,
        budget_limit: limit,
        budget_used: current,
        exceeded: true,
        exceeded_at: ts,
      },
      budgetFile,
    );
    return { exceeded: true, warn: false, current_cost: current, limit, measured: true };
  }

  // Update budget.json with current usage when non-zero (run.sh check_budget_limit()).
  if (current > 0) {
    writeBudgetState(
      {
        limit,
        budget_limit: limit,
        budget_used: current,
        exceeded: false,
      },
      budgetFile,
    );
  }
  // R3 anti-surprise warn: spend is in [80%, 100%) of the cap. Non-pausing;
  // the orchestrator logs it so the user sees it before the hard stop.
  const warn = current >= BUDGET_WARN_FRACTION * limit;
  return { exceeded: false, warn, current_cost: current, limit, measured: true };
}

// ---------------------------------------------------------------------------
// Rate-limit detection
// ---------------------------------------------------------------------------

// Generic patterns from run.sh detect_rate_limit() (case-insensitive grep -E).
const RATE_LIMIT_PATTERN = /(\b429\b|rate.?limit|too many requests|quota exceeded|request limit|retry.?after)/i; // \b429\b: a bare 429 inside a hash, run id or cost figure (sha256:...a429f..., $0.0429) is not a rate limit
// Claude-specific reset format (run.sh parse_claude_reset_time()).
const CLAUDE_RESET_PATTERN = /resets [0-9]+[ap]m/;
// Retry-After header (case-insensitive).
const RETRY_AFTER_PATTERN = /retry.?after:?\s*([0-9]+)/gi;

// Test stdout/stderr text for any rate-limit indicator. Mirrors is_rate_limited
// (run.sh detect_rate_limit()). Accepts a single string or an array (we'll concat).
export function isRateLimited(text: string | readonly string[]): boolean {
  const haystack = Array.isArray(text) ? text.join("\n") : (text as string);
  if (!haystack) return false;
  if (RATE_LIMIT_PATTERN.test(haystack)) return true;
  if (CLAUDE_RESET_PATTERN.test(haystack)) return true;
  return false;
}

// Parse Retry-After value (seconds) from log text (run.sh parse_retry_after()).
// Returns the LAST match (bash uses `tail -1`).
export function parseRetryAfter(text: string): number {
  if (!text) return 0;
  RETRY_AFTER_PATTERN.lastIndex = 0;
  let last: number = 0;
  let m: RegExpExecArray | null;
  while ((m = RETRY_AFTER_PATTERN.exec(text)) !== null) {
    const grp = m[1];
    if (grp !== undefined) {
      const n = Number.parseInt(grp, 10);
      if (Number.isFinite(n)) last = n;
    }
  }
  return last;
}

// Calculate fallback backoff from provider RPM (run.sh calculate_rate_limit_backoff()).
// Formula: (120 * 60) / rpm, clamped to [60, 300] seconds.
export function calculateRateLimitBackoff(retryAfter?: number, providerRpm?: number): number {
  // If a retry-after value was supplied and is positive, prefer it directly.
  if (typeof retryAfter === "number" && retryAfter > 0) {
    return retryAfter;
  }
  const rpm = typeof providerRpm === "number" && providerRpm > 0 ? providerRpm : 50;
  let wait = Math.floor((120 * 60) / rpm);
  if (wait < 60) wait = 60;
  if (wait > 300) wait = 300;
  return wait;
}

// ---------------------------------------------------------------------------
// Runner adapter (Phase 4 v7.4.1). Marker key for autonomous.ts tryImport.
// ---------------------------------------------------------------------------
import type { RunnerContext as LoopRunnerContext } from "./types.ts";

export async function checkBudgetLimitForRunner(ctx: LoopRunnerContext): Promise<boolean> {
  const result = checkBudgetLimit({
    budgetLimit: ctx.budgetLimit,
    iteration: ctx.iterationCount,
    efficiencyDir: `${ctx.lokiDir}/metrics/efficiency`,
    budgetFile: `${ctx.lokiDir}/metrics/budget.json`,
    pauseFile: `${ctx.lokiDir}/PAUSE`,
    signalsDir: `${ctx.lokiDir}/signals`,
  });
  return result.exceeded;
}

// E-98e: streamed running usage total for a possibly-killed session; never `result-cost-*` (nothing globs that prefix).
export function partialUsagePath(lokiRoot: string, iteration: string): string {
  return join(lokiRoot, "metrics", `partial-usage-${iteration}.json`);
}

const PRICING_FAMILIES = ["fable", "opus", "sonnet", "haiku"] as const;

// E-98e: prices a killed session's streamed usage, same table a normal record uses; an unmatched model id leaves usd null, never a guess.
export function recordPartialStreamCost(lokiRoot: string, iterationId: string, info: EfficiencySessionInfo): CostResult {
  const out: CostResult = { usd: null, partialUsd: 0, measuredCount: 0, totalCount: 1, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, model: null, source: "", missing: [iterationId] };
  try {
    const p = partialUsagePath(lokiRoot, iterationId);
    const u = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    out.input_tokens = num(u["input_tokens"]); out.output_tokens = num(u["output_tokens"]);
    out.cache_read_tokens = num(u["cache_read_tokens"]); out.cache_creation_tokens = num(u["cache_creation_tokens"]);
    out.model = typeof u["model"] === "string" ? u["model"] : null;
    out.source = p; out.missing = [];
    const m = out.model?.toLowerCase() ?? "";
    const key = exactIdKey(m) ?? PRICING_FAMILIES.find((f) => m.includes(f));
    if (key) {
      out.usd = calculateCostFromRecords([{ model: key, input_tokens: out.input_tokens, output_tokens: out.output_tokens, cache_read_tokens: out.cache_read_tokens, cache_creation_tokens: out.cache_creation_tokens }]);
      out.partialUsd = out.usd; out.measuredCount = 1;
    }
  } catch { /* no partial file, or unreadable: usd stays null (E-69 semantics) */ }
  if (out.missing.length > 0) out.tokens_measured = { k: 0, n: 1 }; // no usage was read: the record and cost event carry no token keys, never a measured zero (FC-44)
  writeEfficiencyRecord(lokiRoot, info, out, "partial-stream");
  return out;
}

/** P12-22r: shared ledger. One JSON line per priced cost, written with a single O_APPEND write (atomic for small lines). Sum = spend of every unit. */
export function ledgerSum(path: string): number | null {
  try { let t = 0, seeded = false; for (const l of readFileSync(path, "utf8").split("\n")) { if (!l) continue; const r = JSON.parse(l) as { usd?: unknown; seed?: unknown }, u = r.usd; if (r.seed === true) { if (seeded) continue; seeded = true; } /* first seed wins when units carry different seeds */ if (typeof u === "number" && Number.isFinite(u) && u > 0) t += u; } return t; } catch { return null; }
}
