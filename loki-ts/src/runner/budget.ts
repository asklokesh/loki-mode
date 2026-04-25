// Budget tracking and rate-limit detection for the autonomous loop.
// Mirrors bash autonomy/run.sh:
//   - check_budget_limit (lines 7853-7942)
//   - is_rate_limited     (lines 7668-7688)
//   - parse_retry_after   (lines 7738-7750)
//   - calculate_rate_limit_backoff (lines 7755-7772)
// Spec: loki-ts/docs/phase4-research/checkpoint_budget.md sections 6-9.
//
// State file format (.loki/metrics/budget.json) is byte-identical to bash:
// the JSON object is written via cat-heredoc with no JSON encoder, but the
// fields and ordering here match the heredoc layout in run.sh:7913-7921 and
// run.sh:7931-7938.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { lokiDir } from "../util/paths.ts";

// Hard-coded pricing tiers, USD per 1M tokens. Mirrors run.sh:7870-7876.
// Do NOT load from external config -- bash hardcodes these values inline.
export const PRICING: Readonly<Record<string, { input: number; output: number }>> = Object.freeze({
  opus: { input: 5.0, output: 25.0 },
  sonnet: { input: 3.0, output: 15.0 },
  haiku: { input: 1.0, output: 5.0 },
  "gpt-5.3-codex": { input: 1.5, output: 12.0 },
  "gemini-3-pro": { input: 1.25, output: 10.0 },
  "gemini-3-flash": { input: 0.1, output: 0.4 },
});

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

// Per-iteration efficiency record produced elsewhere (run.sh:3921-3936).
// Either cost_usd is present (use directly) or input/output_tokens + model.
export interface EfficiencyRecord {
  cost_usd?: number;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
}

export interface CheckBudgetResult {
  exceeded: boolean;
  current_cost: number;
  limit: number | null;
}

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

// Round to 4 decimals (matches Python `round(total, 4)` at run.sh:7891).
// Uses Number.EPSILON-style rounding via toFixed for consistency.
function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

// Resolve pricing for a model name, defaulting to sonnet (run.sh:7886).
function pricingFor(model: string | undefined): { input: number; output: number } {
  const key = (model ?? DEFAULT_PRICING_KEY).toLowerCase();
  return PRICING[key] ?? PRICING[DEFAULT_PRICING_KEY]!;
}

// Calculate total cost from a list of efficiency records.
// Mirrors run.sh:7867-7892 Python block.
export function calculateCostFromRecords(records: readonly EfficiencyRecord[]): number {
  let total = 0;
  for (const d of records) {
    if (typeof d.cost_usd === "number" && Number.isFinite(d.cost_usd)) {
      total += d.cost_usd;
      continue;
    }
    const p = pricingFor(d.model);
    const inp = typeof d.input_tokens === "number" ? d.input_tokens : 0;
    const out = typeof d.output_tokens === "number" ? d.output_tokens : 0;
    total += (inp / 1_000_000) * p.input + (out / 1_000_000) * p.output;
  }
  return round4(total);
}

// Read all .loki/metrics/efficiency/*.json files; bad files are silently
// skipped (matches Python `except: pass` at run.sh:7890).
export function readEfficiencyDir(dir: string): EfficiencyRecord[] {
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
      }
    } catch {
      // ignore malformed file
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// Budget state I/O (atomic write via tmp + rename)
// ---------------------------------------------------------------------------

export function readBudgetState(file?: string): BudgetState | null {
  const fp = file ?? join(lokiDir(), "metrics", "budget.json");
  if (!existsSync(fp)) return null;
  try {
    const raw = readFileSync(fp, "utf8");
    return JSON.parse(raw) as BudgetState;
  } catch {
    return null;
  }
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
  const tmp = `${fp}.tmp.${process.pid}`;
  writeFileSync(tmp, body);
  renameSync(tmp, fp);
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
// (run.sh:7857). Returns null when no limit set / invalid.
function parseBudgetLimit(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const cleaned = v.replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Equivalent of check_budget_limit() in bash. Returns whether the budget was
// exceeded plus the computed cost. When exceeded, writes PAUSE/BUDGET_EXCEEDED
// signals and updates budget.json (run.sh:7907-7926).
//
// NOTE: this is a pure side-effecting helper; orchestrator decides what to do
// with the result. It does NOT emit events (event bus is C1's surface).
export function checkBudgetLimit(opts: CheckBudgetOptions = {}): CheckBudgetResult {
  const root = lokiDir();
  const limit = parseBudgetLimit(opts.budgetLimit ?? process.env["BUDGET_LIMIT"] ?? null);
  if (limit === null) {
    return { exceeded: false, current_cost: 0, limit: null };
  }

  const efficiencyDir = opts.efficiencyDir ?? join(root, "metrics", "efficiency");
  const budgetFile = opts.budgetFile ?? join(root, "metrics", "budget.json");
  const pauseFile = opts.pauseFile ?? join(root, "PAUSE");
  const signalsDir = opts.signalsDir ?? join(root, "signals");
  const now = opts.now ?? (() => new Date());

  const records = readEfficiencyDir(efficiencyDir);
  const current = calculateCostFromRecords(records);

  // Greater-than-OR-equal (run.sh:7902).
  const exceeded = current >= limit;

  if (exceeded) {
    const ts = isoNow(now());
    // PAUSE marker (run.sh:7909).
    mkdirSync(dirname(pauseFile), { recursive: true });
    writeFileSync(pauseFile, "");
    // Signal payload (run.sh:7910-7911).
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
    return { exceeded: true, current_cost: current, limit };
  }

  // Update budget.json with current usage when non-zero (run.sh:7930).
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
  return { exceeded: false, current_cost: current, limit };
}

// ---------------------------------------------------------------------------
// Rate-limit detection
// ---------------------------------------------------------------------------

// Generic patterns from run.sh:7678 (case-insensitive grep -E).
const RATE_LIMIT_PATTERN = /(429|rate.?limit|too many requests|quota exceeded|request limit|retry.?after)/i;
// Claude-specific reset format (run.sh:7683).
const CLAUDE_RESET_PATTERN = /resets [0-9]+[ap]m/;
// Retry-After header (case-insensitive).
const RETRY_AFTER_PATTERN = /retry.?after:?\s*([0-9]+)/gi;

// Test stdout/stderr text for any rate-limit indicator. Mirrors is_rate_limited
// (run.sh:7668-7688). Accepts a single string or an array (we'll concat).
export function isRateLimited(text: string | readonly string[]): boolean {
  const haystack = Array.isArray(text) ? text.join("\n") : (text as string);
  if (!haystack) return false;
  if (RATE_LIMIT_PATTERN.test(haystack)) return true;
  if (CLAUDE_RESET_PATTERN.test(haystack)) return true;
  return false;
}

// Parse Retry-After value (seconds) from log text (run.sh:7738-7750).
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

// Calculate fallback backoff from provider RPM (run.sh:7755-7772).
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
