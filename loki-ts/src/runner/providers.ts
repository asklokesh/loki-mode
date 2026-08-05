// Provider invocation module. Phase 5 port of providers/loader.sh + the four
// per-provider shell configs (claude.sh, codex.sh, cline.sh, aider.sh).
//
// Bash sources (the single source of truth -- keep references current when
// the shell side changes):
//   providers/loader.sh:1-186  -- dispatcher, validation, capability matrix
//   providers/claude.sh:1-200  -- Tier 1, full features
//   providers/cline.sh:1-139   -- Tier 2, near-full
//   providers/codex.sh:1-190   -- Tier 3, degraded
//   providers/aider.sh:1-145   -- Tier 3, degraded
//
// Contract: autonomous.ts:167 dynamically imports this module and invokes
// `resolveProvider(name)` to obtain a `ProviderInvoker` (see runner/types.ts:90).
//
// Phase 5 progress:
//   - claude is ported in full (Tier 1).
//   - cline, aider are ported (Tier 2 / Tier 3 degraded).
//   - codex is still stubbed pending parallel work by other agents.
// The dispatch table always returns an invoker; stubs throw with a
// discoverable "STUB: Phase 5" marker so failures surface loudly instead
// of silently degrading (BUG-22 stub-discipline rule).

import { mkdirSync, existsSync, readFileSync, realpathSync, appendFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { run as shellRun } from "../util/shell.ts";
import { REPO_ROOT } from "../util/paths.ts";
import {
  buildAutoFlags,
  claudeFlagSupported,
  ensureClaudeHelpCache,
  autonomyAppendText,
  autonomyAppendEnabled,
  sessionStampArgv,
  sessionResumeArgv,
  cavemanActivateEnv,
  cavemanSuppressEnv,
  effortForTier,
  remainingBudget,
  fallbackForPrimary,
  tierRouteModel,
} from "../providers/claude_flags.ts";
import { mcpConfigPath } from "../providers/mcp_config.ts";
import { consumeSdkStream, type StreamMsg } from "./sdk_stream_parser.ts";
import type {
  ProviderInvocation,
  ProviderInvoker,
  ProviderName,
  ProviderResult,
  SessionTier,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Resolve a provider name to a concrete invoker. Mirrors loader.sh:25
// (load_provider) -- validates name, then dispatches to the per-provider
// builder. Throws on unknown name (loader.sh:29) or stubbed providers.
export async function resolveProvider(
  name: ProviderName,
): Promise<ProviderInvoker> {
  const guardCwd = process.env["LOKI_TARGET_DIR"] ?? process.cwd();
  if (name !== "claude" && hostGuardRequired(guardCwd)) {
    throw new Error(`host command guard is required, but provider '${name}' has no enforced PreToolUse hook`);
  }
  switch (name) {
    case "claude":
      // v8 Phase 4: when LOKI_SDK_LOOP is on, the main RARV loop runs on the
      // Agent SDK's query() instead of spawning `claude -p ... stream-json`.
      // Default-off: the bash/shellRun claude path is byte-identical until opted
      // in. sdkQueryProvider delegates non-mainLoop calls back to claudeProvider,
      // so judge subcalls never touch query(). Uses the established truthy()
      // helper so the spelling matches the rest of the codebase.
      //
      // v8.1 (Story 6, T3-prep): LOKI_LEGACY_BASH is a SYMMETRIC escape hatch --
      // see selectClaudeInvokerKind for the precedence. Decision is extracted to
      // a pure helper so the release-safety rollback can be unit-tested without
      // constructing/spawning a provider.
      return selectClaudeInvokerKind(process.env) === "sdk"
        ? sdkQueryProvider()
        : claudeProvider();
    case "codex":
      return codexProvider();
    case "cline":
      return clineProvider();
    case "aider":
      return aiderProvider();
    default: {
      // Defensive: TS exhaustiveness should make this unreachable, but a
      // bad cast at the call site (e.g. user-supplied name) lands here.
      const exhaustive: never = name;
      throw new Error(`unknown provider: ${String(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Allow tests + production to override which binary is invoked. Mirrors the
// bash convention where sourcing scripts can pre-set `PROVIDER_CLI` (see
// loader.sh:12) before invoking. The env var name encodes the provider so
// cross-provider injection in tests is unambiguous.
function resolveCli(envVar: string, defaultCli: string): string {
  const override = process.env[envVar];
  return override && override.length > 0 ? override : defaultCli;
}

// Permissive truthy check accepting "1", "true", "yes", "on" in any case.
// Kept for env reads whose bash counterpart is permissive.
//
// NOTE (v7.41.4 parity): do NOT use this for LOKI_ALLOW_HAIKU. The bash side
// gates haiku on an EXACT "true" string -- claude.sh:294 (provider_get_tier_param),
// claude.sh:104 of autonomy/lib/claude-flags.sh (loki_fallback_for_primary), and
// the Bun fallbackForPrimary (claude_flags.ts:101) all require `=== "true"`. So
// claudeTierToModel reads LOKI_ALLOW_HAIKU with `=== "true"` directly (below), not
// via truthy(). Using truthy() here would honor LOKI_ALLOW_HAIKU=1 (haiku) while
// bash and fallbackForPrimary do not (sonnet) -- a route-to-route drift AND a
// self-inconsistency within the Bun route.
//
// Exported for unit tests; not part of the public provider API.
export function truthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    default:
      return false;
  }
}

// v8.1 (Story 6, T3-prep): decide whether the claude main-loop provider runs on
// the Agent SDK ("sdk") or the legacy bash claude spawn ("legacy"). Pure over
// env so the release-safety rollback is unit-testable without spawning.
//
// Precedence (LOKI_LEGACY_BASH is the SYMMETRIC escape hatch):
//   1. LOKI_LEGACY_BASH truthy  -> "legacy"  (rollback ALWAYS wins, even if the
//      loop is opted-on or, in a future release, default-on). bin/loki also
//      honors it at the shim; this is the in-process backstop for when the Bun
//      route is reached another way (LOKI_TS_ENTRY / direct src run / a default
//      flip). CI-tested now so the rollback exists before LOKI_SDK_LOOP flips.
//   2. else LOKI_SDK_LOOP truthy -> "sdk".
//   3. else                      -> "legacy" (default-off; byte-identical to v8).
export function selectClaudeInvokerKind(
  env: Record<string, string | undefined>,
): "sdk" | "legacy" {
  if (truthy(env["LOKI_LEGACY_BASH"])) return "legacy";
  return truthy(env["LOKI_SDK_LOOP"]) ? "sdk" : "legacy";
}

// Resolve tier -> Claude model alias. Mirrors claude.sh:121-142
// (provider_get_tier_param) including the LOKI_ALLOW_HAIKU branch that
// upgrades fast/development tiers when haiku is opt-in only.
function claudeTierToModel(tier: SessionTier): string {
  // fable unavailable, collapse to opus. Claude Fable 5 is not available at the
  // Claude API ("use Opus 4.8"). This guard precedes the allowHaiku branch
  // because the allowHaiku default arm returns sonnet, which would silently
  // downgrade a fable pin. Mirrors claude.sh resolve_model_for_tier and run.sh
  // (v7.39.1).
  if (tier === "fable") return "opus";
  // EXACT "true" to mirror bash (claude.sh:294, claude-flags.sh:104) and the
  // Bun fallbackForPrimary (claude_flags.ts:101). LOKI_ALLOW_HAIKU=1 must NOT
  // enable haiku on either route (v7.41.4 parity fix).
  const allowHaiku = process.env["LOKI_ALLOW_HAIKU"] === "true";
  if (allowHaiku) {
    // v7.104.0: planning defaults to sonnet (claude.sh:60, unconditional); the
    // ALLOW_HAIKU block only lowers development (already sonnet) and fast (haiku).
    switch (tier) {
      case "planning":
        return "sonnet";
      case "development":
        return "sonnet";
      case "fast":
        return "haiku";
      default:
        return "sonnet";
    }
  }
  // Default: no haiku. Upgrade dev->opus, fast->sonnet (claude.sh:135-141).
  // v7.104.0: Sonnet 5 is the default execution model. planning + development
  // default to sonnet (was opus), matching claude.sh CLAUDE_DEFAULT_PLANNING/
  // DEVELOPMENT and the bash resolver. This route is not yet wired to `loki start`
  // (the shim falls through to bash), but keeping it in parity avoids a silent
  // opus dispatch when the Bun runner is wired on.
  switch (tier) {
    case "planning":
      return "sonnet";
    case "development":
      return "sonnet";
    case "fast":
      return "sonnet";
    default:
      return "sonnet";
  }
}

// Apply LOKI_MAX_TIER ceiling. Mirrors loki_apply_max_tier_clamp at
// claude.sh:343-372 (resolve_model_for_tier maxTier branch).
//
// Parity (v7.41.4): bash normalizes the ceiling with trim + lowercase
// (claude.sh:352, `tr | sed`) BEFORE the case match, so a user-typed cap like
// "Haiku" or " haiku " (settings.json maxTier exports verbatim) is honored.
// The Bun port previously switched on the RAW env value, so "Haiku" missed the
// "haiku" arm, fell through, and dispatched opus -- blowing past the ceiling the
// quote + dashboard claimed enforced. Normalize once, treat empty as no ceiling.
function applyMaxTierCeiling(tier: SessionTier, model: string): string {
  const maxTier = (process.env["LOKI_MAX_TIER"] ?? "").trim().toLowerCase();
  if (!maxTier) return model;
  switch (maxTier) {
    case "haiku":
      // Cap everything to the fast-tier model. We re-resolve from fast tier
      // so LOKI_ALLOW_HAIKU is honored (claude.sh:172-175).
      return claudeTierToModel("fast");
    case "sonnet":
      // Cap planning AND fable down to development tier. Mirrors claude.sh:358-362
      // which caps when tier is planning or fable (model is already fable->opus
      // collapsed upstream by claudeTierToModel, so the model==="fable" arm there
      // is moot here, but a "fable" session tier still reaches this function via
      // the SessionTier string fallback and must be capped).
      if (tier === "planning" || tier === "fable") {
        return claudeTierToModel("development");
      }
      return model;
    case "opus":
    default:
      return model;
  }
}

// Ensure parent dir exists for the captured-output path. Bash equivalent is
// the implicit `mkdir -p` in run.sh prior to teeing into the log file.
function ensureParentDir(path: string): void {
  const parent = dirname(path);
  if (!parent || parent === "." || parent === "/") return;
  mkdirSync(parent, { recursive: true });
}

function physicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function hostGuardRequired(cwd: string): boolean {
  if (truthy(process.env["LOKI_HOST_GUARD"])) return true;
  const target = process.env["LOKI_TARGET_DIR"];
  const roots = process.env["LOKI_WORKSPACE_ROOTS"];
  if (!target || !roots || physicalPath(target) !== physicalPath(cwd)) return false;
  const candidate = physicalPath(cwd);
  return roots.split(delimiter).some((root) => {
    if (!root) return false;
    const fromRoot = relative(physicalPath(root), candidate);
    return fromRoot === "" || (
      fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(fromRoot)
    );
  });
}

function hostGuardSettingsJson(): string {
  const hookPath = resolve(REPO_ROOT, "autonomy", "hooks", "validate-bash.sh");
  if (!existsSync(hookPath)) throw new Error(`host command guard hook is missing: ${hookPath}`);
  return JSON.stringify({
    hooks: {
      PreToolUse: [{
        matcher: "Bash",
        hooks: [{ type: "command", command: `bash ${shellQuote(hookPath)}` }],
      }],
    },
  });
}

// Write captured output to disk. Used by every provider to honor the
// `iterationOutputPath` contract from types.ts:87 -- the runner reads the
// captured file for completion-promise / rate-limit detection.
async function writeCaptured(
  path: string,
  stdout: string,
  stderr: string,
): Promise<void> {
  ensureParentDir(path);
  // stderr first then stdout matches the run.sh `2>&1 | tee` ordering well
  // enough for downstream regex scans (rate-limit messages typically arrive
  // on stderr; completion-promise text on stdout).
  const body = stderr.length > 0 ? `${stderr}\n${stdout}` : stdout;
  await Bun.write(path, body);
}

// ---------------------------------------------------------------------------
// Claude provider (claude.sh:1-200)
// ---------------------------------------------------------------------------

// Build the Claude provider invoker. Maps to provider_invoke_with_tier()
// at claude.sh:192-199 (v7.5.19 Phase B adds --effort / --max-budget-usd /
// --fallback-model derived from existing Loki state):
//   claude --dangerously-skip-permissions --model <model> \
//          [--effort <tier-derived>] [--max-budget-usd <limit-spend>] \
//          [--fallback-model <primary-derived>] -p <prompt>
export function claudeProvider(): ProviderInvoker {
  const cli = resolveCli("LOKI_CLAUDE_CLI", "claude");
  return {
    async invoke(call: ProviderInvocation): Promise<ProviderResult> {
      const baseModel = claudeTierToModel(call.tier);
      // Complexity-aware routing (opt-in LOKI_TIER_ROUTING=1). Applied after base
      // resolution and BEFORE the max-tier ceiling, byte-mirroring claude.sh
      // resolve_model_for_tier (route then clamp).
      const routedModel = tierRouteModel(call.tier, baseModel);
      let model = applyMaxTierCeiling(call.tier, routedModel);

      // Phase I (v7.5.25): when ANTHROPIC_BASE_URL is set, the user is
      // routing Claude Code to an alt-provider (OpenRouter, Ollama,
      // LiteLLM, self-hosted). The alt-provider may not recognize the
      // opus/sonnet/haiku aliases that only Anthropic resolves. Let the
      // user override the resolved model name via LOKI_MODEL_OVERRIDE; it
      // wins over all tier mapping. ANTHROPIC_BASE_URL itself is passed
      // through unchanged (Claude Code reads it natively).
      if (process.env["ANTHROPIC_BASE_URL"] && process.env["LOKI_MODEL_OVERRIDE"]) {
        model = process.env["LOKI_MODEL_OVERRIDE"];
      }

      // v7.5.19 Phase B: prime the claude --help cache once, then compose
      // the auto-derived flag set. ensureClaudeHelpCache is idempotent --
      // first call populates, subsequent calls return immediately.
      await ensureClaudeHelpCache();
      const hostGuard = hostGuardRequired(call.cwd);
      if (hostGuard && !claudeFlagSupported("--settings")) {
        const message = "host command guard requires Claude CLI --settings support";
        await writeCaptured(call.iterationOutputPath, "", message);
        return { exitCode: 1, capturedOutputPath: call.iterationOutputPath };
      }
      const autoFlags = buildAutoFlags({
        tier: call.tier,
        complexity: process.env["LOKI_COMPLEXITY"] ?? "standard",
        primary: model,
        targetDir: call.cwd,
      });

      // v7.34.0 Phase 1 (correlation-only): per-iteration --session-id, OPT-IN
      // via LOKI_SESSION_STAMP=1. Default OFF keeps this argv byte-identical to
      // v7.33. Distinct deterministic UUIDv5("<run-id>:<iteration>") per
      // iteration (never a pinned id), gated on CLI support. Mirrors the run.sh
      // main-loop block; run id + iteration read from env exactly as bash does.
      // Session stamp attaches ONLY to the main RARV-loop call (call.mainLoop),
      // never to subcalls like the override-council judge (council R1: the Bun
      // claudeProvider backs both, so an ungated stamp leaked the same
      // --session-id onto the judge subcall, breaking the main-loop-only
      // invariant). Mirrors the bash route confining it to _loki_claude_argv.
      //
      // Session-continuity Phase 2 (GitHub #165): on the FIRST main-loop call of
      // a RESTARTED run (call.resumeFirstCall) with LOKI_RESUME_SESSION=1, emit
      // `--resume <stored-uuid>` (+ optional --fork-session) INSTEAD of the stamp
      // (--session-id and --resume are mutually exclusive on one invocation).
      // Both default OFF -> []. Mirrors the run.sh main-loop resume-or-stamp
      // decision. resumeFirstCall is set by the caller only on that one call.
      let sessionArgv: string[] = [];
      if (call.mainLoop) {
        const resumeArgv = call.resumeFirstCall ? sessionResumeArgv(call.cwd) : [];
        sessionArgv = resumeArgv.length > 0 ? resumeArgv : sessionStampArgv();
      }

      const argv: string[] = [
        cli,
        // claude.sh:31 PROVIDER_AUTONOMOUS_FLAG
        "--dangerously-skip-permissions",
        "--model",
        model,
        ...autoFlags,
        ...sessionArgv,
        ...(hostGuard ? ["--settings", hostGuardSettingsJson()] : []),
        // claude.sh:32 PROVIDER_PROMPT_FLAG
        "-p",
        call.prompt,
      ];

      // caveman output-token compression. Mirrors the run.sh main-loop wiring.
      // The MAIN RARV loop (call.mainLoop) is FREE-FORM generation -> ACTIVATE
      // at the configured level (when warranted). Every OTHER claudeProvider
      // call is a parsed-output subcall (council judge, etc.) -> HARD-SUPPRESS
      // with "off". An EMPTY value is NOT inert (caveman treats it as unset and
      // falls back to the user default), so we set the var ONLY when we have a
      // concrete level, and unconditionally set "off" on the suppress path.
      let cavemanEnv: Record<string, string> | undefined;
      if (call.mainLoop) {
        // #593: pass the RARV tier so the level is inferred from the work (the
        // same signal the bash route reads from LOKI_CURRENT_TIER). Keeps both
        // routes inferring identically; an explicit LOKI_CAVEMAN_LEVEL overrides.
        const lvl = cavemanActivateEnv(call.tier);
        if (lvl) cavemanEnv = { CAVEMAN_DEFAULT_MODE: lvl };
      } else {
        cavemanEnv = { CAVEMAN_DEFAULT_MODE: cavemanSuppressEnv() };
      }

      const r = await shellRun(argv, { cwd: call.cwd, env: cavemanEnv });
      await writeCaptured(call.iterationOutputPath, r.stdout, r.stderr);

      return {
        exitCode: r.exitCode,
        capturedOutputPath: call.iterationOutputPath,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Append a structured capability-degradation record to .loki/events.jsonl.
//
// Same {type, source, timestamp, payload} envelope the SDK hook events use
// (sdk_stream_parser.ts), so existing consumers of that stream need no change.
// Best-effort by design: diagnostics must NEVER be able to fail a build, so
// every error here is swallowed exactly like the hook-event appender.
//
// Exported for the test that asserts the event actually lands.
export function emitSdkDegradationEvent(
  cwd: string,
  payload: { reason: string; tier?: string; model?: string; iteration?: string },
): void {
  try {
    const lokiRoot = process.env["LOKI_DIR"] ?? resolve(cwd, ".loki");
    mkdirSync(lokiRoot, { recursive: true });
    const record = {
      type: "capability_degraded",
      source: "sdk_loop",
      timestamp: new Date().toISOString(),
      payload: { capability: "sdk_query", fail_closed: true, ...payload },
    };
    appendFileSync(resolve(lokiRoot, "events.jsonl"), `${JSON.stringify(record)}\n`);
  } catch {
    // best-effort: a diagnostic must never break the run it is describing.
  }
}

// SDK query() provider (v8 Phase 4) -- the RARV main loop on @anthropic-ai/
// claude-agent-sdk instead of spawning the claude binary. Reached only when
// LOKI_SDK_LOOP is truthy (see resolveProvider). No binary spawn: query() drives
// the agentic loop in-process; sdk_stream_parser writes the SAME .loki state the
// bash stream-json parser writes, so downstream consumers are unchanged.
// ---------------------------------------------------------------------------

// RUN-25 iter 3 (T3(b)): compose the query() options the SDK loop was MISSING
// vs the shell route -- MCP tools, effort tier, USD budget backstop, fallback
// model, settingSources. Without these the SDK loop silently dropped all 34 MCP
// tools (loki_complete_task, code search, memory, ...), effort tuning, the
// per-call budget circuit breaker, and the rate-limit fallback model: the exact
// hidden-capability regression the T3 pre-flight gate exists to block. Each value
// derives from the SAME helpers the shell route uses (effortForTier /
// remainingBudget / fallbackForPrimary / mcp_config), so bash and the SDK loop
// resolve identically. Every field is best-effort: any miss (no budget set, MCP
// bundle unreadable) simply omits that option -- never throws, never wedges.
export interface SdkLoopExtraOptions {
  mcpServers?: Array<Record<string, unknown>>;
  strictMcpConfig?: boolean;
  settingSources?: string[];
  effort?: string;
  maxBudgetUsd?: number;
  fallbackModel?: string;
}
export function buildSdkLoopOptions(args: {
  tier: string | undefined;
  model: string;
  cwd: string;
  complexity?: string;
  allowHaiku?: boolean;
}): SdkLoopExtraOptions {
  const out: SdkLoopExtraOptions = {};

  // MCP tools: reuse the exact bundle the shell route writes (loki-mode server +
  // optional lsp-proxy). mcpConfigPath writes it idempotently; read its server
  // map and pass as one mcpServers array element. strictMcpConfig ignores any
  // ambient project .mcp.json (parity with the hardcoded-bundle shell behavior).
  try {
    const cfgPath = mcpConfigPath(args.cwd);
    if (existsSync(cfgPath)) {
      const bundle = JSON.parse(readFileSync(cfgPath, "utf8")) as { mcpServers?: Record<string, unknown> };
      if (bundle.mcpServers && Object.keys(bundle.mcpServers).length > 0) {
        out.mcpServers = [bundle.mcpServers];
        out.strictMcpConfig = true;
      }
    }
  } catch {
    // MCP bundle unreadable -> omit (loop still runs, just without MCP tools).
  }
  // settingSources: match the shell route's claude_code preset behavior (project
  // + user settings resolved by the CLI). Explicit so the SDK does not diverge.
  out.settingSources = ["user", "project", "local"];

  // effort tier (same mapping as buildAutoFlags).
  try {
    out.effort = effortForTier(args.tier, args.complexity);
  } catch {
    // omit
  }
  // USD budget backstop: only when a limit is configured AND spend remains.
  try {
    const rem = remainingBudget(args.cwd);
    if (rem !== null) {
      const n = Number(rem);
      if (Number.isFinite(n) && n > 0) out.maxBudgetUsd = n;
    }
  } catch {
    // omit
  }
  // fallback model (rate-limit resilience), same derivation as the shell route.
  try {
    const fb = fallbackForPrimary(args.model, args.allowHaiku);
    if (fb) out.fallbackModel = fb;
  } catch {
    // omit
  }
  return out;
}

function hostGuardDecision(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason: reason,
    },
  };
}

async function runSdkHostGuard(input: unknown, cwd: string) {
  const hookPath = resolve(REPO_ROOT, "autonomy", "hooks", "validate-bash.sh");
  try {
    const proc = Bun.spawn({
      cmd: ["bash", hookPath],
      cwd,
      env: {
        ...process.env,
        LOKI_HOST_GUARD: "1",
        LOKI_TARGET_DIR: cwd,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { permissionDecision?: string };
    };
    const decision = parsed.hookSpecificOutput?.permissionDecision;
    if (exitCode === 0 && decision === "allow") return parsed;
    if (exitCode !== 0 && decision === "deny") return parsed;
    return hostGuardDecision("LOKI_HOST_GUARD: invalid hook verdict was denied.");
  } catch {
    return hostGuardDecision("LOKI_HOST_GUARD: hook execution failed, so the Bash command was denied.");
  }
}

export function sdkQueryProvider(): ProviderInvoker {
  return {
    async invoke(call: ProviderInvocation): Promise<ProviderResult> {
      // Subcalls (council judge, etc.) NEVER run through query(): only the main
      // RARV loop. resolveProvider already scopes this to the main provider, but
      // guard here too so a future subcall reuse can't leak into the agentic path.
      if (!call.mainLoop) return claudeProvider().invoke(call);

      // Model resolution is shared with claudeProvider (do NOT fork it).
      const baseModel = claudeTierToModel(call.tier);
      // Complexity-aware routing (opt-in LOKI_TIER_ROUTING=1), route then clamp,
      // byte-mirroring claude.sh resolve_model_for_tier.
      const routedModel = tierRouteModel(call.tier, baseModel);
      let model = applyMaxTierCeiling(call.tier, routedModel);
      if (process.env["ANTHROPIC_BASE_URL"] && process.env["LOKI_MODEL_OVERRIDE"]) {
        model = process.env["LOKI_MODEL_OVERRIDE"];
      }

      // caveman (main loop -> activate at the tier-inferred level, if warranted).
      const cavemanLvl = cavemanActivateEnv(call.tier);

      // Lazy dynamic import so the default-off path never loads the SDK.
      // A load failure (SDK missing / platform binary absent) is fail-closed:
      // write whatever we captured (empty) and return exitCode 1.
      let captured = "";
      let exitCode = 1;
      let rateLimit: { resetSeconds?: number } | undefined;
      try {
        const { query } = await import("@anthropic-ai/claude-agent-sdk");
        // options.env REPLACES the whole subprocess env -- MUST spread
        // process.env or PATH/HOME/ANTHROPIC_API_KEY vanish and query() fails.
        const env: Record<string, string> = { ...(process.env as Record<string, string>) };
        if (cavemanLvl) env["CAVEMAN_DEFAULT_MODE"] = cavemanLvl;

        // T3(b): compose the MCP/effort/budget/fallback options the loop was
        // missing vs the shell route (see buildSdkLoopOptions). Only fields that
        // resolved are spread in; a miss omits that option.
        const extra = buildSdkLoopOptions({
          tier: call.tier,
          model,
          cwd: call.cwd,
          complexity: process.env["DETECTED_COMPLEXITY"] ?? process.env["LOKI_COMPLEXITY"],
          allowHaiku: process.env["LOKI_ALLOW_HAIKU"] === "true",
        });

        // SLICE 6b note: the Agent SDK query() prompt contract is a plain
        // string (or a stream of SDKUserMessage objects), NOT raw content
        // blocks, so the sdk_invoker buildUserContent([CACHE_BREAKPOINT]) split
        // does not apply here. The Agent SDK/CLI already applies prompt caching
        // to the system prompt and conversation history internally. Explicit
        // per-block cache_control is only wired on the raw-SDK judge path
        // (sdk_invoker.ts) where messages.create accepts content blocks.
        const q = query({
          prompt: call.prompt,
          options: {
            model,
            cwd: call.cwd,
            // fully autonomous, like --dangerously-skip-permissions. bypassPermissions
            // REQUIRES the allowDangerouslySkipPermissions companion or it throws.
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            includePartialMessages: true, // live delta streaming
            includeHookEvents: true, // hooks arrive as system messages (parser)
            ...(hostGuardRequired(call.cwd)
              ? {
                  hooks: {
                    PreToolUse: [{
                      matcher: "Bash",
                      hooks: [(input: unknown) => runSdkHostGuard(input, call.cwd)],
                    }],
                  },
                }
              : {}),
            // build_prompt owns the ITERATION prompt; the preset matches
            // `claude -p`. The one thing build_prompt does NOT carry is the
            // autonomy/first-pass append, which the CLI route sends via
            // --append-system-prompt. That flag path is gated on a `claude`
            // BINARY probe, so on this route (no CLI required) the FIRST-PASS
            // EXCELLENCE directive was silently dropped -- losing a measured
            // 2.8x iterations-to-done reduction on the very route v8 promotes.
            // Same text, same iteration-1 gate, same opt-out, no binary probe.
            systemPrompt: autonomyAppendEnabled()
              ? {
                  type: "preset",
                  preset: "claude_code",
                  append: autonomyAppendText(),
                }
              : { type: "preset", preset: "claude_code" },
            env,
            // T3(b) parity: MCP tools + effort + USD budget + fallback model.
            ...(extra.mcpServers ? { mcpServers: extra.mcpServers } : {}),
            ...(extra.strictMcpConfig ? { strictMcpConfig: true } : {}),
            ...(extra.settingSources ? { settingSources: extra.settingSources } : {}),
            ...(extra.effort ? { effort: extra.effort } : {}),
            ...(extra.maxBudgetUsd ? { maxBudgetUsd: extra.maxBudgetUsd } : {}),
            ...(extra.fallbackModel ? { fallbackModel: extra.fallbackModel } : {}),
          },
          // biome-ignore lint/suspicious/noExplicitAny: SDK Options type is broader than our subset
        } as any);

        const res = await consumeSdkStream(q as AsyncIterable<StreamMsg>, {
          cwd: call.cwd,
          iteration: process.env["LOKI_ITERATION"] ?? "0",
          hookEventsEnabled: process.env["LOKI_HOOK_EVENTS"] !== "off",
          write: (s) => process.stdout.write(s),
        });
        captured = res.capturedText;
        // Fail-closed: a stream that never produced a terminal result is a
        // failed iteration, never counted as success.
        exitCode = res.sawResult ? res.exitCode : 1;
        rateLimit = res.rateLimit;
      } catch (e) {
        captured += `\n[sdk-loop error: ${(e as Error).message}]\n`;
        exitCode = 1;
        // CAPABILITY DEGRADATION (structured, not just prose in the log).
        //
        // The SDK path is already fail-closed: there is NO silent downgrade to
        // the claude CLI, and exitCode stays 1 so a failed iteration can never
        // be counted as success. What was missing is OBSERVABILITY -- the
        // failure existed only as text inside the captured output, so an
        // operator running unattended had nothing to alert on and no way to
        // distinguish "the SDK could not load" from "the model did poor work".
        //
        // Emitted onto the SAME append-only .loki/events.jsonl stream the hook
        // events use, with the same {type, source, timestamp, payload} shape,
        // so every existing consumer picks it up for free. Deliberately NO new
        // env var: this is diagnostic signal an operator always wants, and a
        // knob to enable your own error reporting is a knob nobody would find.
        emitSdkDegradationEvent(call.cwd, {
          reason: (e as Error).message,
          tier: call.tier,
          model,
          iteration: process.env["LOKI_ITERATION"] ?? "0",
        });
      }

      // Always write the captured text (even on a thrown query()) so the
      // completion-promise / rate-limit / council scanners have their file.
      await writeCaptured(call.iterationOutputPath, captured, "");

      const out: ProviderResult = {
        exitCode,
        capturedOutputPath: call.iterationOutputPath,
      };
      // Populate the structured rate-limit hint when the SDK gave a concrete
      // reset. NOTE (council polish): the current Bun runner reads rate limits
      // from the captured-text `[rate_limit]` marker (budget.ts::isRateLimited),
      // not this field, so it is presently a no-op consumer-side. We still emit
      // it because it is part of the ProviderResult contract (types.ts) and the
      // bash route's structured signal; a future runner that prefers the
      // structured value over the text scan gets it for free. Harmless when unread.
      if (rateLimit?.resetSeconds && rateLimit.resetSeconds > 0) {
        out.rateLimitWaitSeconds = rateLimit.resetSeconds;
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Stubbed providers -- Phase 5 next iteration.
//
// Each builder is wired into the dispatch table so the contract surface is
// complete; calling .invoke() throws so the runner immediately fails loudly
// instead of pretending to succeed. BUG-22 rule: stubs must be discoverable
// at the call site and never silently no-op.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Codex provider (codex.sh:1-190)
//
// Maps to provider_invoke_with_tier() at codex.sh:181-189:
//   LOKI_CODEX_REASONING_EFFORT=$effort \
//   CODEX_MODEL_REASONING_EFFORT=$effort \
//   codex exec --sandbox workspace-write --skip-git-repo-check "<prompt>"
//
// Codex uses a single model with varying reasoning effort (xhigh/high/low)
// rather than tier->model mapping. Both env vars are set for forward and
// backward compatibility (codex.sh:178-180).
// ---------------------------------------------------------------------------

// Tier -> effort. Mirrors codex.sh:127-134 (provider_get_tier_param).
function codexTierToEffort(tier: SessionTier): string {
  switch (tier) {
    case "planning":
      return "xhigh";
    case "development":
      return "high";
    case "fast":
      return "low";
    default:
      return "high";
  }
}

// Apply LOKI_MAX_TIER ceiling. Mirrors codex.sh resolve_model_for_tier maxTier
// branch.
//
// Parity: bash normalizes the ceiling with trim + lowercase (codex.sh, mirroring
// claude.sh:356) BEFORE the case match, so a user-typed cap like "Haiku" or
// " haiku " (settings.json maxTier exports verbatim) is honored. This port
// previously switched on the RAW env value, so "Haiku" missed the "haiku" arm,
// fell through to the default, and left effort uncapped -- silently bypassing the
// cost ceiling for codex while claude (applyMaxTierCeiling:158) honored it.
// Normalize once, treat empty as no ceiling. Matches applyMaxTierCeiling:158.
function applyCodexMaxTier(effort: string): string {
  const maxTier = (process.env["LOKI_MAX_TIER"] ?? "").trim().toLowerCase();
  if (!maxTier) return effort;
  switch (maxTier) {
    case "haiku":
    case "low":
      return "low";
    case "sonnet":
    case "high":
      return effort === "xhigh" ? "high" : effort;
    case "opus":
    case "xhigh":
    default:
      return effort;
  }
}

// Aligned with codex CLI 0.132.0 (verified: --full-auto is deprecated and
// removed from `codex exec --help`). argv shape:
//
//   --full-auto                        (was, now deprecated upstream)
//   --sandbox workspace-write          (now -- documented replacement)
//   --skip-git-repo-check              (matches the bash route)
//
// `codex exec` is the non-interactive subcommand: it runs at approval "never"
// with no --ask-for-approval flag, so --sandbox workspace-write alone keeps the
// loop autonomous (verified against codex 0.132.0: no approval prompt). This
// mirrors the bash route (run.sh:14720 + codex.sh provider_invoke_with_tier)
// exactly. workspace-write is also the safer default (scoped disk writes) over
// the prior danger-full-access.
//
// New optional features added (opt-in via env):
//   LOKI_CODEX_WEB_SEARCH=true  -> append --search (codex live web search)
//   LOKI_CODEX_OUTPUT_LAST=true -> --output-last-message <iter-output-path>
//                                  for cleaner final-response capture
//                                  (defaults to true since it is purely
//                                  additive over our existing tee capture)
//
// Still deferred (need orchestrator-level changes, not provider-level):
//   --json / --experimental-json (newline-delimited event stream)
//   codex exec resume --last (session continuity across iterations)
//   codex mcp add/list (loki <-> codex MCP bridge)
//   subagents parallelism
export function codexProvider(): ProviderInvoker {
  const cli = resolveCli("LOKI_CODEX_CLI", "codex");
  return {
    async invoke(call: ProviderInvocation): Promise<ProviderResult> {
      const baseEffort = codexTierToEffort(call.tier);
      const effort = applyCodexMaxTier(baseEffort);

      // codex 0.132.0: --sandbox workspace-write (documented replacement for the
      // deprecated --full-auto). exec is non-interactive (approval "never"), so
      // no --ask-for-approval flag is needed. Mirrors the bash route shape.
      const argv: string[] = [
        cli,
        "exec",
        "--sandbox", "workspace-write",
        "--skip-git-repo-check",
      ];

      // Optional: web search (codex v0.125 --search).
      if (process.env["LOKI_CODEX_WEB_SEARCH"] === "true") {
        argv.push("--search");
      }

      // Optional: capture final response via --output-last-message.
      // Default ON (additive; we still tee stdout/stderr separately).
      // Set LOKI_CODEX_OUTPUT_LAST=false to disable.
      const outputLastEnabled = process.env["LOKI_CODEX_OUTPUT_LAST"] !== "false";
      let lastMessagePath: string | null = null;
      if (outputLastEnabled) {
        lastMessagePath = `${call.iterationOutputPath}.last-message`;
        argv.push("--output-last-message", lastMessagePath);
      }

      argv.push(call.prompt);

      // Both env vars: LOKI_-namespaced (canonical, v6.37.1+) and
      // CODEX_MODEL_REASONING_EFFORT (legacy, deprecated but supported).
      const r = await shellRun(argv, {
        cwd: call.cwd,
        env: {
          LOKI_CODEX_REASONING_EFFORT: effort,
          CODEX_MODEL_REASONING_EFFORT: effort,
        },
      });
      await writeCaptured(call.iterationOutputPath, r.stdout, r.stderr);

      return {
        exitCode: r.exitCode,
        capturedOutputPath: call.iterationOutputPath,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Cline provider (cline.sh:1-139)
// ---------------------------------------------------------------------------

// Build the Cline provider invoker. Maps to provider_invoke() at
// cline.sh:108-115:
//   cline -y [-m <model>] <prompt>
//
// Notes:
//   - Tier is informational only -- Cline uses a single externally-configured
//     model gateway. cline.sh:117-128 returns CLINE_DEFAULT_MODEL for every
//     tier; we mirror that by ignoring the tier argument here.
//   - Capabilities: subagents + MCP, but no parallelization
//     (cline.sh:42-48). Parallel-mode callers fan out at the orchestrator
//     layer, not here.
//   - LOKI_CLINE_MODEL is optional. When unset we omit -m and let the CLI
//     fall back to its `cline auth` configured default -- matches bash
//     behavior at cline.sh:111-113 (empty model_args array).
export function clineProvider(): ProviderInvoker {
  const cli = resolveCli("LOKI_CLINE_CLI", "cline");
  return {
    async invoke(call: ProviderInvocation): Promise<ProviderResult> {
      const model = process.env["LOKI_CLINE_MODEL"] ?? "";

      // cline.sh:33 PROVIDER_AUTONOMOUS_FLAG = "-y" (YOLO mode).
      const argv: string[] = [cli, "-y"];
      if (model.length > 0) {
        // cline.sh:113-114: build -m <model> as a separate pair so model
        // names with spaces survive without word-splitting.
        argv.push("-m", model);
      }
      // cline.sh:35,114: PROVIDER_PROMPT_POSITIONAL=true -- prompt last.
      argv.push(call.prompt);

      const r = await shellRun(argv, { cwd: call.cwd });
      await writeCaptured(call.iterationOutputPath, r.stdout, r.stderr);

      return {
        exitCode: r.exitCode,
        capturedOutputPath: call.iterationOutputPath,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Aider provider (aider.sh:1-145)
// ---------------------------------------------------------------------------

// Build the Aider provider invoker. Maps to provider_invoke() at
// aider.sh:110-121:
//   aider --message <prompt> --yes-always --no-auto-commits \
//         --model <model> [LOKI_AIDER_FLAGS...]
//
// Notes:
//   - Tier is informational only -- Aider routes through litellm with a
//     single externally-configured model. aider.sh:124-135 returns
//     AIDER_DEFAULT_MODEL for every tier; we mirror that by ignoring tier.
//   - Degraded provider: no subagents, no MCP, sequential only
//     (aider.sh:88-94). Multi-agent callers must serialize.
//   - --no-auto-commits is mandatory: loki manages git itself, including
//     branch state for healing mode (aider.sh:108-109,118).
//   - Default model falls back to "claude-opus-4-7" hard-coded here. The
//     bash side reads from providers/model_catalog.json via models.sh; we
//     keep the TS provider hermetic and let LOKI_AIDER_MODEL override.
//   - LOKI_AIDER_FLAGS is whitespace-split pass-through, mirroring bash
//     word-splitting at aider.sh:114,120 ($extra_flags) without invoking
//     a shell.
export function aiderProvider(): ProviderInvoker {
  const cli = resolveCli("LOKI_AIDER_CLI", "aider");
  return {
    async invoke(call: ProviderInvocation): Promise<ProviderResult> {
      const model = process.env["LOKI_AIDER_MODEL"] ?? "claude-opus-4-7";

      const argv: string[] = [
        cli,
        // aider.sh:34,116: PROVIDER_PROMPT_FLAG = --message (single-shot).
        "--message",
        call.prompt,
        // aider.sh:33,117: PROVIDER_AUTONOMOUS_FLAG = --yes-always.
        "--yes-always",
        // aider.sh:118: loki owns git -- never let aider auto-commit.
        "--no-auto-commits",
        // aider.sh:119: model selected via litellm string.
        "--model",
        model,
      ];

      const extraFlags = process.env["LOKI_AIDER_FLAGS"] ?? "";
      if (extraFlags.length > 0) {
        for (const tok of extraFlags.split(/\s+/)) {
          if (tok.length > 0) argv.push(tok);
        }
      }

      const r = await shellRun(argv, { cwd: call.cwd });
      await writeCaptured(call.iterationOutputPath, r.stdout, r.stderr);

      return {
        exitCode: r.exitCode,
        capturedOutputPath: call.iterationOutputPath,
      };
    },
  };
}
