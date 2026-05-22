// loki-ts/src/providers/claude_flags.ts -- Phase B (v7.5.19) Bun-route helpers.
//
// Mirror of autonomy/lib/claude-flags.sh. Compute Claude Code CLI flag values
// automatically from existing Loki state. No new env vars introduced (per binding
// constraint). Every value derives from RARV tier, complexity, and budget config.
//
// Public API:
//   effortForTier(tier, complexity?) -> "low"|"medium"|"high"|"xhigh"|"max"
//   remainingBudget(targetDir?) -> string | null    (string with 2dp when positive remaining, null otherwise)
//   fallbackForPrimary(primary, allowHaiku?) -> string | null
//   buildAutoFlags({tier, complexity, primary, targetDir}) -> string[]
//
// Side-effect free: reads env + filesystem only. Returns flags as an array of
// alternating ["--flag", "value", ...] that the caller appends to its CLI argv.
import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

// Mirror of loki_effort_for_tier in autonomy/lib/claude-flags.sh.
export function effortForTier(tier: string | undefined, complexity?: string): EffortLevel {
  let effort: EffortLevel;
  switch (tier) {
    case "planning":
    case "best":
      effort = "xhigh";
      break;
    case "development":
    case "balanced":
      effort = "high";
      break;
    case "fast":
      effort = "medium";
      break;
    case "cheap":
      effort = "low";
      break;
    default:
      effort = "high";
      break;
  }
  const cx = complexity ?? process.env["LOKI_COMPLEXITY"] ?? "standard";
  if (cx === "complex") {
    switch (effort) {
      case "low":
        effort = "medium";
        break;
      case "medium":
        effort = "high";
        break;
      case "high":
        effort = "xhigh";
        break;
      // xhigh stays xhigh; max not auto-reached.
    }
  }
  return effort;
}

// Mirror of loki_remaining_budget in autonomy/lib/claude-flags.sh.
// Returns null when LOKI_BUDGET_LIMIT is unset or 0, OR when remaining <= 0.
// Returns a string with 2 decimal places when positive remaining exists.
export function remainingBudget(targetDir?: string): string | null {
  const limitRaw = process.env["LOKI_BUDGET_LIMIT"];
  if (!limitRaw) return null;
  const limit = parseFloat(limitRaw);
  if (!Number.isFinite(limit) || limit <= 0) return null;

  const td = targetDir ?? process.env["TARGET_DIR"] ?? ".";
  const budgetFile = resolvePath(td, ".loki", "metrics", "budget.json");

  let spend = 0;
  if (existsSync(budgetFile)) {
    try {
      const obj = JSON.parse(readFileSync(budgetFile, "utf8")) as Record<string, unknown>;
      const v = obj["current_spend"];
      if (typeof v === "number" && Number.isFinite(v)) {
        spend = v;
      } else if (typeof v === "string") {
        const parsed = parseFloat(v);
        if (Number.isFinite(parsed)) spend = parsed;
      }
    } catch {
      // Unreadable / malformed budget.json -- treat as zero spend, do not throw.
      spend = 0;
    }
  }

  const rem = limit - spend;
  if (rem <= 0) return null;
  return rem.toFixed(2);
}

// Mirror of loki_fallback_for_primary in autonomy/lib/claude-flags.sh.
// opus -> sonnet always. sonnet -> haiku only when LOKI_ALLOW_HAIKU=true.
// Everything else -> null (no auto-fallback we can reason about safely).
export function fallbackForPrimary(primary: string | undefined, allowHaiku?: boolean): string | null {
  if (!primary) return null;
  const ah = allowHaiku ?? (process.env["LOKI_ALLOW_HAIKU"] === "true");
  switch (primary) {
    case "opus":
      return "sonnet";
    case "sonnet":
      return ah ? "haiku" : null;
    default:
      return null;
  }
}

// Per-process flag-support cache. Populated lazily on first call.
let _claudeHelpCache: string | null = null;

export function claudeFlagSupported(flag: string, helpText?: string): boolean {
  const txt = helpText ?? _claudeHelpCache;
  if (txt === null || txt === undefined) {
    // No cached help, no override -> conservative answer.
    return false;
  }
  return txt.includes(flag);
}

// One-shot async initializer for the help cache. The caller is responsible
// for invoking this before calling claudeFlagSupported() (otherwise the cache
// stays empty and all checks return false -> we never pass an unsupported flag).
export async function ensureClaudeHelpCache(): Promise<void> {
  if (_claudeHelpCache !== null) return;
  try {
    const proc = Bun.spawn(["claude", "--help"], { stdout: "pipe", stderr: "pipe" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    _claudeHelpCache = text || "";
  } catch {
    _claudeHelpCache = "";
  }
}

export interface AutoFlagsArgs {
  tier: string;
  complexity?: string;
  primary?: string;
  targetDir?: string;
}

// Compose the auto-derived flag array. Each value is appended only if non-null
// AND the flag is supported by the installed claude CLI.
// Caller MUST `await ensureClaudeHelpCache()` once before calling this function
// for the support-check to be meaningful. Without it, we conservatively skip flags.
export function buildAutoFlags(args: AutoFlagsArgs): string[] {
  const out: string[] = [];

  if (claudeFlagSupported("--effort")) {
    const e = effortForTier(args.tier, args.complexity);
    out.push("--effort", e);
  }
  if (claudeFlagSupported("--max-budget-usd")) {
    const rb = remainingBudget(args.targetDir);
    if (rb !== null) out.push("--max-budget-usd", rb);
  }
  if (claudeFlagSupported("--fallback-model")) {
    const fb = fallbackForPrimary(args.primary);
    if (fb !== null) out.push("--fallback-model", fb);
  }
  return out;
}

// Test-only reset. Not exported in production typings.
export function _resetClaudeHelpCacheForTest(text: string | null = null): void {
  _claudeHelpCache = text;
}
