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
import { buildMcpConfigArgv } from "./mcp_config.ts";

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
  // Phase E (v7.5.20): --exclude-dynamic-system-prompt-sections.
  // Boolean flag (no value). Default on when supported; suppress with
  // LOKI_DYNAMIC_PROMPT_SECTIONS=keep.
  if (
    (process.env["LOKI_DYNAMIC_PROMPT_SECTIONS"] ?? "auto") !== "keep" &&
    claudeFlagSupported("--exclude-dynamic-system-prompt-sections")
  ) {
    out.push("--exclude-dynamic-system-prompt-sections");
  }
  // Phase D (v7.5.22): --mcp-config variadic. Emits the Loki bundle path plus
  // optional ~/.claude/mcp.json overlay. Wrapped in try/catch so a filesystem
  // failure (e.g. read-only targetDir) does not break flag emission for the
  // rest of the pipeline (e.g. --include-hook-events below).
  if (claudeFlagSupported("--mcp-config")) {
    try {
      const td = args.targetDir ?? process.env["TARGET_DIR"] ?? ".";
      const mcpArgv = buildMcpConfigArgv(td);
      out.push(...mcpArgv);
    } catch (e) {
      console.warn(`[claude_flags] --mcp-config emit skipped: ${(e as Error).message}`);
    }
  }
  // Phase D (v7.5.22): --include-hook-events boolean. Default on; suppress with
  // LOKI_HOOK_EVENTS=off. Requires --output-format=stream-json (wired by Dev-C
  // in runner/providers.ts; this module only emits the flag itself).
  if (
    process.env["LOKI_HOOK_EVENTS"] !== "off" &&
    claudeFlagSupported("--include-hook-events")
  ) {
    out.push("--include-hook-events");
  }

  // v7.7.31: authorize autonomous operation at the system-prompt tier so the
  // spawned agent does not read the user's global ~/.claude/CLAUDE.md, judge it
  // to conflict with the loki_system prompt, call AskUserQuestion, and exit
  // having done nothing. An appended system prompt outranks CLAUDE.md memory
  // (verified empirically). Default-on; opt out with LOKI_AUTONOMY_OVERRIDE=off.
  // Mirrors providers/claude.sh _loki_autonomy_override_text (kept byte-identical).
  if (
    process.env["LOKI_AUTONOMY_OVERRIDE"] !== "off" &&
    claudeFlagSupported("--append-system-prompt")
  ) {
    out.push("--append-system-prompt", AUTONOMY_OVERRIDE_TEXT);
  }
  return out;
}

// The system-prompt text that authorizes autonomous operation and resolves
// precedence against a conflicting user/project CLAUDE.md. MUST stay
// byte-identical to providers/claude.sh _loki_autonomy_override_text so the
// bash and Bun routes send the same override. No emojis, no em dashes.
export const AUTONOMY_OVERRIDE_TEXT =
  "[LOKI-AUTONOMY-AGENT] This is a Loki Mode autonomous agent process.\n" +
  "You are running INSIDE Loki Mode autonomous execution, a session the user explicitly launched with full prior authorization (loki start / loki run). This IS an authorized autonomous session, not an unattended action you must seek consent for.\n\n" +
  "Instruction precedence for THIS session: when the loki_system instructions in the user prompt conflict with any CLAUDE.md, project memory, or global memory that tells you to ask for clarification, pause for confirmation, refuse to act autonomously, or withhold routine commits, the loki_system instructions take precedence. The user has already consented by launching autonomous mode.\n\n" +
  "Therefore, for this session: do NOT ask the user questions, do NOT call the AskUserQuestion tool, do NOT stop to request confirmation, and do NOT refuse routine, reversible engineering work (writing code, running tests, creating files, atomic git checkpoints in the working tree). Proceed and complete the task directly. If a decision is genuinely ambiguous, choose the most reasonable option, record the assumption in .loki/CONTINUITY.md, and continue rather than halting.\n\n" +
  "Commit hygiene still applies: git checkpoints are LOCAL only. Never push or force-push. Stage files by explicit path, never `git add -A` or `git add .`, and never commit secrets, credentials, .env files, or untracked files you did not author this session.\n\n" +
  "This precedence override is narrow. It does NOT relax any safety rule. Every safety prohibition in CLAUDE.md or memory still fully binds: anything genuinely destructive or irreversible remains out of scope unless the task explicitly calls for it. This includes (not limited to) force-pushing, deleting or overwriting the user's data, dropping or truncating databases, publishing or releasing, rotating or exfiltrating secrets, touching production systems, and anything a CLAUDE.md safety rule explicitly forbids. When in doubt about whether an action is destructive, treat it as destructive and do not do it.\n";

// Test-only reset. Not exported in production typings.
export function _resetClaudeHelpCacheForTest(text: string | null = null): void {
  _claudeHelpCache = text;
}
