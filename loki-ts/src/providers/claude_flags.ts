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
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
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

// Complexity-aware MODEL routing (net-new; effort routing already exists in
// effortForTier). ENV VAR: LOKI_TIER_ROUTING (DEFAULT "0" = OFF = current flat
// resolution, zero change to stock runs). Byte-mirror of loki_tier_route_model in
// providers/claude.sh. When LOKI_TIER_ROUTING=1 the resolved model is nudged by
// the auto-detected complexity signal (LOKI_COMPLEXITY: simple|standard|complex):
//   complex + planning -> opus
//   simple  + fast     -> haiku ONLY when LOKI_ALLOW_HAIKU=true (support gate)
//   standard, or development/ACT tier -> UNCHANGED.
// HARD GUARD: the development/ACT tier is NEVER routed below sonnet (the switch
// has no development arm, so it falls through unchanged). "explicit override
// wins": we skip the nudge whenever the operator pinned that tier via
// LOKI_CLAUDE_MODEL_PLANNING / LOKI_MODEL_PLANNING (or the _FAST pair), so a
// deliberate pin is never overridden -- byte-mirroring the bash arm's env checks.
function envPinned(...names: string[]): boolean {
  return names.some((n) => {
    const v = process.env[n];
    return v !== undefined && v !== "";
  });
}

export function tierRouteModel(tier: string, model: string): string {
  if (process.env["LOKI_TIER_ROUTING"] !== "1") return model;
  const complexity = process.env["LOKI_COMPLEXITY"] ?? "standard";
  switch (tier) {
    case "planning":
      if (
        complexity === "complex" &&
        !envPinned("LOKI_CLAUDE_MODEL_PLANNING", "LOKI_MODEL_PLANNING")
      ) {
        return "opus";
      }
      return model;
    case "fast":
      if (
        complexity === "simple" &&
        process.env["LOKI_ALLOW_HAIKU"] === "true" &&
        !envPinned("LOKI_CLAUDE_MODEL_FAST", "LOKI_MODEL_FAST")
      ) {
        return "haiku";
      }
      return model;
    // development/ACT and every other tier: unchanged. HARD GUARD -- never route
    // implementation below sonnet, so no arm here touches it.
    default:
      return model;
  }
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
      // EMBED 1 (v7.33.0): --strict-mcp-config. ONLY emitted alongside an
      // actual --mcp-config (we are inside the success path that just pushed
      // mcpArgv), never bare. Loads EXCLUSIVELY Loki's curated MCP bundle and
      // ignores ambient user/project .mcp.json. Default-ON; opt out with
      // LOKI_STRICT_MCP=0. Gated on CLI support. Mirrors providers/claude.sh.
      if (
        process.env["LOKI_STRICT_MCP"] !== "0" &&
        mcpArgv.length > 0 &&
        claudeFlagSupported("--strict-mcp-config")
      ) {
        out.push("--strict-mcp-config");
      }
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
    // First-pass excellence (v8): on iteration 1, append a directive that
    // front-loads intelligence so a single informed pass lands the complete,
    // working, well-designed solution instead of a draft the loop then corrects.
    // Iteration-1-only + gated on LOKI_FIRST_PASS_EXCELLENCE (default on). MUST
    // mirror providers/claude.sh _loki_autonomy_override_text so both routes send
    // the same append at runtime (the matrix parity gate does not spawn a model,
    // so a one-route-only change would pass every gate yet diverge live).
    out.push("--append-system-prompt", autonomyAppendText());
  }
  // v7.34.0: --no-session-persistence. OPT-IN via LOKI_NO_SESSION_PERSIST=1;
  // DEFAULT OFF (zero behavior change). Disables Claude's own transcript JSONL
  // persistence for ephemeral/CI runs. Gated on CLI support. Mirrors
  // providers/claude.sh _loki_build_claude_auto_flags.
  if (
    process.env["LOKI_NO_SESSION_PERSIST"] === "1" &&
    claudeFlagSupported("--no-session-persistence")
  ) {
    out.push("--no-session-persistence");
  }
  return out;
}

// autonomyAppendText: the exact system-prompt append both routes send.
//
// EXTRACTED so the SDK route can reach it. This composition used to live inline
// inside the CLI flag builder, behind claudeFlagSupported("--append-system-prompt")
// -- a probe of the `claude` BINARY. On the SDK route with no CLI installed
// (LOKI_SDK_MODE=full, the configuration v8 steers new users toward) that
// predicate is false, so the FIRST-PASS EXCELLENCE directive silently vanished
// from exactly the route v8 promotes. That directive is the measured
// iterations-to-done lever: a hard task dropped from [3,2] iterations to [1,1],
// 2.8x cheaper, with correctness held. Losing it on the default route is the
// opposite of what the loop is for.
//
// The CLI caller still gates on binary support (it must -- an unsupported flag
// would be rejected by the binary). The SDK caller has no such constraint and
// passes this text straight to query()'s systemPrompt append.
//
// Iteration-1-only, gated on LOKI_FIRST_PASS_EXCELLENCE (default on). Callers
// on BOTH routes must use this function so the two can never diverge at
// runtime: the matrix parity gate does not spawn a model, so a one-route-only
// change would pass every gate and still send different prompts live.
export function autonomyAppendText(): string {
  const iter = Number.parseInt(process.env["ITERATION_COUNT"] ?? "1", 10);
  const firstPassOn = process.env["LOKI_FIRST_PASS_EXCELLENCE"] !== "0";
  return firstPassOn && (Number.isNaN(iter) || iter <= 1)
    ? AUTONOMY_OVERRIDE_TEXT + FIRST_PASS_EXCELLENCE_TEXT
    : AUTONOMY_OVERRIDE_TEXT;
}

// autonomyAppendEnabled: whether the append should be sent at all. Shared by
// both routes so the opt-out (LOKI_AUTONOMY_OVERRIDE=off) behaves identically.
export function autonomyAppendEnabled(): boolean {
  return process.env["LOKI_AUTONOMY_OVERRIDE"] !== "off";
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

// The curated design archetype library, read VERBATIM from
// references/design-archetypes.md. Item 4 of the first-pass directive is purely
// negative ("NO purple gradient, NO Inter"), which leaves the model on exactly
// the priors that produce the slop; this file is the positive half, giving it a
// concrete aesthetic to commit to. Deliberately no interpolation and no
// archetype-selection logic on either route: the MODEL picks, so the bash/Bun
// parity surface is a plain byte compare of one shared file. Mirror of
// providers/claude.sh _loki_design_archetypes_file. Fails open -- a missing file
// degrades to the negative-only directive rather than erroring.
function designArchetypesText(): string {
  try {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    for (const rel of [
      ["..", "..", "..", "references", "design-archetypes.md"], // src/providers -> repo root
      ["..", "..", "references", "design-archetypes.md"], // dist -> repo root
    ]) {
      const p = resolvePath(moduleDir, ...rel);
      if (existsSync(p)) return readFileSync(p, "utf8");
    }
  } catch {
    // fall through to the empty string (fail open)
  }
  return "";
}

// First-pass excellence directive appended to the iteration-1 system prompt.
// MUST stay byte-identical to the LOKI_FIRSTPASS_EOF heredoc in
// providers/claude.sh _loki_autonomy_override_text (the bash `cat` emits a
// leading newline before the heredoc body, reproduced here), INCLUDING the
// design-archetype library both routes append after it. No emojis, no dashes.
export const FIRST_PASS_EXCELLENCE_TEXT =
  "\n[FIRST-PASS EXCELLENCE] Treat THIS pass as your one shot to ship a complete, working, verified solution. Do not produce a rough draft to refine later; the loop exists as a safety net, not a plan. Before you finish this iteration:\n" +
  "1. BUILD IT FULLY. Implement every requirement end to end. No stubs, no TODOs, no \"coming soon\", no placeholder or hardcoded/mock data where real logic belongs. If the spec implies a backend (auth, persistence, a form that submits, a list that saves), WIRE IT so it actually works and persists -- a beautiful UI whose buttons do nothing is the single most common failure, not a draft. Every list/table must trace to a real query, never an inline mock array.\n" +
  "2. SELF-VERIFY BY RUNNING, not by reading. Run the build and the tests yourself; for each acceptance criterion, DRIVE the actual path and observe the result (submit the form, then reload and confirm the record persisted; hit a protected route logged-out and confirm it is rejected). Fix what fails now, in this pass. Do not mark done on \"looks right\" or a self-claim -- observed behavior is the only proof.\n" +
  "3. LOCK THE ARCHITECTURE on this pass so later edits are small and additive. Decide the data model, routes, and component structure up front and build to them; never rewrite whole files later to patch a small thing (that is the doom loop that breaks working features).\n" +
  "4. DESIGN: commit to ONE named aesthetic direction up front (editorial, brutalist, luxury, retro-futuristic, soft/pastel, industrial, etc. -- chosen from the product domain) and hold it on every surface. Use real content (never lorem). AVOID the AI-slop tells that instantly read as machine-generated: NO indigo/blue-to-purple gradient (the #1 tell), NO Inter/Roboto/system-font headlines (pick a real display+body pairing), NO three-equal-rounded-cards-in-a-row skeleton, NO flat 1px gray card borders or colored left-border strips, NO untouched shadcn defaults, NO reflexive dark mode. Cap the palette at ~3 hues (60/30/10), tinted not pure #fff/#000, separate sections by whitespace then a slight background shift before any border. Aim for Linear/Stripe/Duolingo-tier taste: \"this does not look AI-generated\".\n" +
  "5. SATISFY THE GATES THAT WILL JUDGE THIS PASS. Your work is checked by deterministic gates before it can be accepted, and in measured runs EVERY extra iteration was caused by one of these rejecting the work -- never by the model failing to finish. Clear them now, in this pass:\n" +
  "   - STATIC ANALYSIS: no syntax errors, no unused/undefined symbols, no lint errors in files you touched.\n" +
  "   - TEST SUITE: the existing tests must still pass. Run them; do not assume.\n" +
  "   - MUTATION/MOCK INTEGRITY: tests must assert real behaviour. No tautological assertions (expect(true).toBe(true)), no test that passes whether or not the code works, no mocking the very unit under test, no inline mock data standing in for a real query.\n" +
  "   - CODE REVIEW: no scope creep beyond the stated task, no dead or commented-out code, no leftover debug output, and follow the conventions already in the surrounding files.\n" +
  "Deliver the finished, self-verified, genuinely-designed result in THIS pass. Additional iterations should be the exception, not the plan.\n" +
  designArchetypesText();

// ---------------------------------------------------------------------------
// v7.34.0 Claude session-id stamping (Phase 1, correlation-only).
//
// Mirror of autonomy/lib/claude-flags.sh _loki_claude_session_uuid /
// _loki_claude_iteration_session_uuid / loki_session_stamp_enabled. The uuids
// MUST be byte-identical to the bash route (which derives them via python3's
// uuid.uuid5) for the same trust-run-id. RFC-4122 UUIDv5 = SHA-1 over the
// namespace bytes + the UTF-8 name, with version/variant bits forced. The
// namespace constant below is the EXACT same literal as the bash helper; never
// change it (changing it re-keys every run's uuid).
// ---------------------------------------------------------------------------
export const CLAUDE_SESSION_NAMESPACE = "b6f3c7a2-9d41-5e8b-9c2a-3f7d6e1a4b50";

// UUIDv5 over CLAUDE_SESSION_NAMESPACE + an arbitrary name. Pure + deterministic.
// Matches python3 uuid.uuid5(uuid.UUID(ns), name) byte-for-byte.
export function uuidv5(name: string): string {
  const nsHex = CLAUDE_SESSION_NAMESPACE.replace(/-/g, "");
  const nsBytes = Uint8Array.from(nsHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  const nameBytes = new TextEncoder().encode(name);
  const buf = new Uint8Array(nsBytes.length + nameBytes.length);
  buf.set(nsBytes, 0);
  buf.set(nameBytes, nsBytes.length);
  const hash = Uint8Array.from(createHash("sha1").update(buf).digest());
  const b = hash.subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x50; // version 5
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC-4122 variant
  const hex = Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Stable per-run claude session UUID: UUIDv5 of the trust-run-id. Same run id ->
// same uuid on every route. Returns null when no run id is resolvable.
export function claudeSessionUuid(runId?: string): string | null {
  const id = runId ?? process.env["LOKI_TRUST_RUN_ID"] ?? "";
  if (!id) return null;
  return uuidv5(id);
}

// Per-iteration session UUID: UUIDv5 of "<run-id>:<iteration>" so each iteration
// gets a DISTINCT, deterministic id. Deliberately NOT the stable per-run uuid: a
// reused id would make claude RESUME (accumulate transcript) = Phase 2 continuity,
// out of scope. Returns null when no run id is resolvable.
export function claudeIterationSessionUuid(runId?: string, iteration?: number): string | null {
  const id = runId ?? process.env["LOKI_TRUST_RUN_ID"] ?? "";
  if (!id) return null;
  let iter = iteration;
  if (iter === undefined) {
    const parsed = parseInt(process.env["ITERATION_COUNT"] ?? "0", 10);
    iter = Number.isFinite(parsed) ? parsed : 0;
  }
  return uuidv5(`${id}:${iter}`);
}

// Emit the per-iteration --session-id ARGV flag? CONSERVATIVE DEFAULT is OFF
// (metadata-file-only) so the default claude argv stays byte-identical to v7.33.
// Opt IN with LOKI_SESSION_STAMP=1; gated on CLI support so an older claude
// degrades gracefully. Mirrors loki_session_stamp_enabled in claude-flags.sh.
export function sessionStampEnabled(): boolean {
  if (process.env["LOKI_SESSION_STAMP"] !== "1") return false;
  return claudeFlagSupported("--session-id");
}

// The per-iteration --session-id argv slice for the main-loop invocation, or []
// when disabled / no run id. The Bun runner appends this to the claude argv on
// the MAIN loop only (never on subcalls). Mirrors the run.sh main-loop block.
export function sessionStampArgv(runId?: string, iteration?: number): string[] {
  if (!sessionStampEnabled()) return [];
  const uuid = claudeIterationSessionUuid(runId, iteration);
  return uuid ? ["--session-id", uuid] : [];
}

// ---------------------------------------------------------------------------
// EMBED 3b (v7.35.0, GitHub #167) -- --allowedTools POSITIVE ALLOWLIST for the
// reviewer / adversarial / council subcalls. Mirror of
// loki_review_allowlist_enabled / loki_review_allowlist in
// autonomy/lib/claude-flags.sh.
//
// Complements the v7.33 --disallowedTools denylist with a least-privilege grant:
// only the read/inspect tools a voter needs. Per the official permission docs
// (https://code.claude.com/docs/en/permissions) rules are "evaluated in order:
// deny, then ask, then allow", and "if a tool is denied at any level, no other
// level can allow it." Verified live against claude 2.1.177 (2026-06-13): with
// both an allow and a deny rule on the same command, the command is BLOCKED,
// even under --dangerously-skip-permissions. So DENY PRECEDENCE holds: the
// allowlist and denylist are SAFE to emit together (the denylist still blocks
// every mutation form; the allowlist additionally narrows the surface). They are
// NOT mutually exclusive.
//
// DEFAULT ON (safety-additive least-privilege; opt OUT with LOKI_REVIEW_ALLOWLIST=0).
// Deny precedence (verified live) means the denylist still hard-blocks every
// mutation form while this allowlist only narrows the reviewer surface to
// read/inspect tools -- pure safety win, no surprise spend, no egress. Gated on
// CLI support (graceful degrade). The token MUST stay byte-identical to
// loki_review_allowlist() in claude-flags.sh.
// ---------------------------------------------------------------------------
export const REVIEW_ALLOWLIST_TOKEN =
  "Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(git status:*),Bash(git ls-files:*),Bash(git rev-parse:*),Bash(git blame:*),Bash(cat:*),Bash(ls:*),Bash(grep:*),Bash(rg:*),Bash(find:*),Bash(head:*),Bash(tail:*),Bash(wc:*)";

// Emit the --allowedTools least-privilege grant on reviewer/voter subcalls?
// DEFAULT ON; opt OUT with LOKI_REVIEW_ALLOWLIST=0; gated on CLI support.
// Mirrors loki_review_allowlist_enabled in autonomy/lib/claude-flags.sh.
export function reviewAllowlistEnabled(): boolean {
  if (process.env["LOKI_REVIEW_ALLOWLIST"] === "0") return false;
  return claudeFlagSupported("--allowedTools");
}

// The --allowedTools argv slice for a reviewer/voter subcall, or [] when
// disabled / unsupported. One comma-separated token so the following -p prompt
// is never swallowed as additional tool names. Mirrors the bash call-site shape.
export function reviewAllowlistArgv(): string[] {
  if (!reviewAllowlistEnabled()) return [];
  return ["--allowedTools", REVIEW_ALLOWLIST_TOKEN];
}

// ---------------------------------------------------------------------------
// Session-continuity Phase 2 (GitHub #165) -- LOKI_RESUME_SESSION recovery resume
//
// NAMING COLLISION WARNING: Loki already has a user-facing `loki heal/migrate
// --resume` CHECKPOINT flag. LOKI_RESUME_SESSION governs the CLAUDE-CLI
// session-resume layer (claude --resume <uuid>), NOT the Loki checkpoint resume.
//
// SCOPE: on the FIRST main-loop call of a RESTARTED run, emit
// `claude --resume <stored-uuid>` (the stable per-run uuid from
// .loki/state/claude-session.json) instead of a fresh stateless call, then
// revert to normal. Recovery only, never a per-iteration chain. DEFAULT OFF
// (argv byte-identical to v7.34). Mirrors loki_resume_session_enabled /
// loki_session_fork_enabled / _loki_resume_target_uuid in claude-flags.sh.
// ---------------------------------------------------------------------------

// Recovery resume enabled AND supported? DEFAULT OFF (opt in LOKI_RESUME_SESSION=1),
// gated on `claude --resume` support. Mirrors loki_resume_session_enabled (bash).
export function resumeSessionEnabled(): boolean {
  if (process.env["LOKI_RESUME_SESSION"] !== "1") return false;
  return claudeFlagSupported("--resume");
}

// Fork the resumed session into a new id? Only honored with LOKI_RESUME_SESSION=1.
// DEFAULT OFF. Gated on `claude --fork-session` support. Mirrors
// loki_session_fork_enabled (bash).
export function sessionForkEnabled(): boolean {
  if (process.env["LOKI_SESSION_FORK"] !== "1") return false;
  if (!resumeSessionEnabled()) return false;
  return claudeFlagSupported("--fork-session");
}

// The stable per-run uuid to resume, read from .loki/state/claude-session.json
// (written on the fresh run, survives into a restart). Returns the stored uuid
// or null when absent / unreadable / malformed (caller then skips resume).
// Mirrors _loki_resume_target_uuid (bash). targetDir defaults to cwd, matching
// the bash LOKI_DIR/TARGET_DIR resolution.
export function resumeTargetUuid(targetDir?: string): string | null {
  const base = targetDir ?? process.env["TARGET_DIR"] ?? ".";
  const lokiDir = process.env["LOKI_DIR"] ?? `${base}/.loki`;
  const csPath = `${lokiDir}/state/claude-session.json`;
  try {
    const raw = readFileSync(csPath, "utf8");
    const d = JSON.parse(raw) as unknown;
    if (typeof d !== "object" || d === null) return null;
    const u = (d as Record<string, unknown>)["claude_session_uuid"];
    if (
      typeof u === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(u)
    ) {
      return u;
    }
    return null;
  } catch {
    return null;
  }
}

// The --resume (+ optional --fork-session) argv slice for the ONE recovery
// resume call, or [] when disabled / no stored uuid. The Bun runner appends this
// on the first main-loop call of a restarted run, INSTEAD of sessionStampArgv()
// (mutual exclusion: --session-id and --resume never co-occur). Mirrors the
// run.sh main-loop resume block.
export function sessionResumeArgv(targetDir?: string): string[] {
  if (!resumeSessionEnabled()) return [];
  const uuid = resumeTargetUuid(targetDir);
  if (!uuid) return [];
  const argv = ["--resume", uuid];
  if (sessionForkEnabled()) argv.push("--fork-session");
  return argv;
}

// ---------------------------------------------------------------------------
// v7.38.0 Dynamic Workflows (ultracode) -- Bun-route parity predicate.
//
// Mirror of loki_workflows_enabled in autonomy/lib/claude-flags.sh. This is the
// opt-in env knob (LOKI_USE_CLAUDE_WORKFLOWS=1, default OFF) that turns ON the
// Phase 2 read-only-analysis workflow dispatch. It is intentionally a pure env
// check here; the provider gate (Claude-only) and the "ultracode: " prompt
// prefixing live in runner/build_prompt.ts (useClaudeWorkflowsForAnalysis +
// analysisInstruction), the one place the analysis prompt is composed. Workflows
// are Claude-provider-only and never touch the council, the 8 gates, the
// evidence gate, or the RARV loop -- only the read-only codebase-analysis prompt.
// ---------------------------------------------------------------------------
export function workflowsEnabled(): boolean {
  return process.env["LOKI_USE_CLAUDE_WORKFLOWS"] === "1";
}

// ---------------------------------------------------------------------------
// v7.x caveman output-token compressor -- Bun-route parity predicates.
//
// Mirror of the loki_caveman_* block in autonomy/lib/claude-flags.sh. caveman
// is a Claude Code SKILL + SessionStart hook that compresses OUTPUT tokens only
// (env CAVEMAN_DEFAULT_MODE: lite|full|ultra|wenyan*; "off" suppresses). The
// activate hook reads CAVEMAN_DEFAULT_MODE > repo config > user config > "full".
//
// MOAT RISK + DESIGN (kept byte-identical in intent to the bash route):
//   - ACTIVATE compression on FREE-FORM generation only (main RARV dev loop +
//     read-only analysis): the runner sets CAVEMAN_DEFAULT_MODE=<level> on the
//     claude spawn env for those calls.
//   - HARD-SUPPRESS on EVERY parsed-output subcall (council vote, ^VERDICT:
//     review, completion, evidence gate): the runner sets CAVEMAN_DEFAULT_MODE=
//     "off". Suppression is UNCONDITIONAL/UNGATED (caveman must be off on a
//     trust gate even when a user has it globally on but LOKI_CAVEMAN=0).
//
// Disclosure: output-token-only savings, bounded, no price API -> savings CLASS
// only, never a dollar figure (same posture as workflows/ultrareview).
// ---------------------------------------------------------------------------

// Version pin (vendor-less). Mirrors LOKI_CAVEMAN_VERSION default in bash.
export const CAVEMAN_PINNED_VERSION =
  process.env["LOKI_CAVEMAN_VERSION"] || "1.9.0";

// Default compression level for free-form activation. Mirrors LOKI_CAVEMAN_LEVEL.
export function cavemanLevel(): string {
  return process.env["LOKI_CAVEMAN_LEVEL"] || "full";
}

// #593 intelligent compression-level inference. Mirror of
// _loki_caveman_infer_level in autonomy/lib/claude-flags.sh. Infer the caveman
// level from the run's existing RARV-tier signal (planning|development|fast) so
// the level is DECIDED by inspecting the work, not asked of the user.
//
// INFERENCE RULE (deterministic, conservative-for-accuracy):
//   planning    (Reason -- architecture / design / nuanced reasoning) -> lite
//   development (Act / Reflect -- implementation, the prior default)   -> full
//   fast        (Verify -- testing / validation, more routine)         -> full
//   unknown / empty tier                                               -> full
// The auto ceiling is "full": inference NEVER selects ultra; ultra is reachable
// only via an explicit LOKI_CAVEMAN_LEVEL override. "lite" on planning protects
// the highest-nuance output; unknown tiers fall back to the SAFER "full".
export function cavemanInferLevel(tier?: string): string {
  const t = tier ?? process.env["LOKI_CURRENT_TIER"] ?? "";
  return t === "planning" ? "lite" : "full";
}

// Capability gate: provider is Claude AND the opt-out knob is not set. (The bash
// route additionally checks `claude` on PATH + installed/bootstrappable; on the
// Bun route the CLI presence is established by the runner before this is reached,
// so this predicate is the env-policy surface, matching the workflowsEnabled
// convention of a pure env check with the provider gate enforced at the call.)
export function cavemanSupported(): boolean {
  if ((process.env["LOKI_PROVIDER"] || "claude") !== "claude") return false;
  if (process.env["LOKI_CAVEMAN"] === "0") return false;
  return true;
}

// Activation knob: default ON (LOKI_CAVEMAN unset or != "0"). Disabled when the
// legacy completion-prose match is active (compressing the main loop would break
// the run.sh:9641 grep), mirroring loki_caveman_enabled's cross-coupling guard.
export function cavemanEnabled(): boolean {
  if (process.env["LOKI_CAVEMAN"] === "0") return false;
  if (process.env["LOKI_LEGACY_COMPLETION_MATCH"] === "true") return false;
  return true;
}

// Compression-level rank (higher = more aggressive). Used by the no-raise guard
// so Loki never RAISES a user's lower global caveman level. Mirrors the bash
// _loki_caveman_level_rank (claude-flags.sh:613-621) BYTE-FOR-BYTE: the wenyan-*
// variants rank with their plain counterparts, and unknown / empty modes rank -1
// ("no opinion", so they never win the no-raise comparison via the >= 0 guard).
function cavemanLevelRank(level: string): number {
  switch (level) {
    case "off":
      return 0;
    case "lite":
    case "wenyan-lite":
      return 1;
    case "full":
    case "wenyan":
    case "wenyan-full":
      return 2;
    case "ultra":
    case "wenyan-ultra":
      return 3;
    default:
      // Unknown / empty: rank -1 so the no-raise guard ignores it (matches the
      // bash sentinel + its `-ge 0` checks at claude-flags.sh:725).
      return -1;
  }
}

// The activation env VALUE for a free-form subcall: the configured level, or
// null when activation is not warranted. The runner sets CAVEMAN_DEFAULT_MODE to
// this on the claude spawn env ONLY when non-null (an EMPTY value is NOT inert --
// caveman treats empty as unset and falls back to the user default, so the
// runner must omit the var entirely when this returns null).
//
// No-raise guard (parity with bash loki_caveman_activate_env): if the user set a
// global caveman level LOWER than Loki's configured level, activate at the user's
// lower level rather than raising it. The bash orchestrator captures the user's
// pre-existing mode into LOKI_CAVEMAN_USER_MODE before exporting the default-off,
// and the Bun runner inherits it. A user "off" means opt-out: no activation.
//
// #593 intelligent inference (parity with bash loki_caveman_activate_env): when
// the user did NOT set LOKI_CAVEMAN_LEVEL explicitly, the level is INFERRED from
// the run's RARV tier (cavemanInferLevel); when the user DID set it, that value
// overrides the inference (opt-out escape hatch). The no-raise guard then runs
// unchanged on whichever base was chosen. The runner passes call.tier here so
// both routes infer from the identical tier vocabulary.
export function cavemanActivateEnv(tier?: string): string | null {
  if (!cavemanSupported()) return null;
  if (!cavemanEnabled()) return null;
  // Explicit user value overrides inference; else infer from the RARV tier.
  // Branch on SET-ness, not truthiness: the bash route captures
  // LOKI_CAVEMAN_LEVEL_USERSET="${LOKI_CAVEMAN_LEVEL+set}" (claude-flags.sh:543-544),
  // which is "set" even for an exported-empty LOKI_CAVEMAN_LEVEL="" -> bash uses
  // the override branch (level="${LOKI_CAVEMAN_LEVEL:-full}" -> "full"). A
  // truthiness check would treat "" as falsy and infer instead, diverging from
  // bash. cavemanLevel() already falls back to "full" for empty, matching :-full.
  const userSet = process.env["LOKI_CAVEMAN_LEVEL"] !== undefined;
  const lokiLevel = userSet ? cavemanLevel() : cavemanInferLevel(tier);
  const userMode = process.env["LOKI_CAVEMAN_USER_MODE"];
  // A user global "off" means opt-out: no activation (parity with the bash
  // loki_caveman_activate_env, which returns empty here -- previously the TS
  // route fell through and compressed anyway, ignoring the user's opt-out).
  if (userMode === "off") return null;
  if (userMode) {
    // Never raise: defer to the user only when their mode is a recognized level
    // that ranks LOWER than Loki's. Both ranks must be >= 0 (recognized) so an
    // unknown user mode (rank -1) is ignored -- byte-for-byte the bash guard at
    // claude-flags.sh:725 (`user_rank -ge 0 && level_rank -ge 0 && user_rank -lt level_rank`).
    const userRank = cavemanLevelRank(userMode);
    const levelRank = cavemanLevelRank(lokiLevel);
    if (userRank >= 0 && levelRank >= 0 && userRank < levelRank) {
      return userMode;
    }
  }
  return lokiLevel;
}

// One-time capture of the user's pre-existing global caveman mode into
// LOKI_CAVEMAN_USER_MODE, so the no-raise / opt-out guard in cavemanActivateEnv
// has something to read on the Bun route.
//
// PARITY: mirrors autonomy/lib/claude-flags.sh:574-577 BYTE-FOR-BYTE in intent.
// The bash route, at source time, runs:
//     if [ -z "${LOKI_CAVEMAN_USER_MODE+x}" ]; then
//         LOKI_CAVEMAN_USER_MODE="${CAVEMAN_DEFAULT_MODE:-}"
//     fi
//     export LOKI_CAVEMAN_USER_MODE
// and then exports CAVEMAN_DEFAULT_MODE=off tree-wide. On the Bun route we do NOT
// clobber CAVEMAN_DEFAULT_MODE globally (the runner sets it per-spawn in
// providers.ts), so only the capture half is mirrored here.
//
// Two semantics matter and both mirror bash exactly:
//   - Guard on UNSET, not falsy (`${var+x}` is empty only when genuinely unset):
//     an inherited empty LOKI_CAVEMAN_USER_MODE="" (user had no global mode) must
//     NOT be recaptured. So branch on `=== undefined`, never on truthiness.
//   - Capture to "" when CAVEMAN_DEFAULT_MODE is absent (`${CAVEMAN_DEFAULT_MODE:-}`),
//     so the var is genuinely set afterward and the guard never re-fires.
//
// UNCONDITIONAL (no supported/enabled gate): bash captures at source time before
// any caveman predicate runs, so this must too. Idempotent and process-wide:
// safe to call once at runner startup; a second call is a no-op (already set).
export function cavemanCaptureUserMode(): void {
  if (process.env["LOKI_CAVEMAN_USER_MODE"] === undefined) {
    process.env["LOKI_CAVEMAN_USER_MODE"] = process.env["CAVEMAN_DEFAULT_MODE"] ?? "";
  }
}

// The suppression env VALUE for a parsed-output subcall: ALWAYS "off",
// UNCONDITIONALLY (not gated on supported/enabled). The runner sets
// CAVEMAN_DEFAULT_MODE="off" on every trust-gate claude spawn. Harmless no-op
// when caveman is absent; essential when it is globally present.
export function cavemanSuppressEnv(): string {
  return "off";
}

// Test-only reset. Not exported in production typings.
export function _resetClaudeHelpCacheForTest(text: string | null = null): void {
  _claudeHelpCache = text;
}
