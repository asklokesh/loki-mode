// Provider invocation module. Phase 5 port of providers/loader.sh + the five
// per-provider shell configs (claude.sh, codex.sh, gemini.sh, cline.sh,
// aider.sh).
//
// Bash sources (the single source of truth -- keep references current when
// the shell side changes):
//   providers/loader.sh:1-186  -- dispatcher, validation, capability matrix
//   providers/claude.sh:1-200  -- Tier 1, full features
//   providers/cline.sh:1-139   -- Tier 2, near-full
//   providers/codex.sh:1-190   -- Tier 3, degraded
//   providers/gemini.sh:1-343  -- Tier 3, degraded + rate-limit fallback
//   providers/aider.sh:1-145   -- Tier 3, degraded
//
// Contract: autonomous.ts:167 dynamically imports this module and invokes
// `resolveProvider(name)` to obtain a `ProviderInvoker` (see runner/types.ts:90).
//
// Phase 5 progress:
//   - claude is ported in full (Tier 1).
//   - cline, aider are ported (Tier 2 / Tier 3 degraded).
//   - gemini is ported (Tier 3 degraded + API-key rotation + flash fallback).
//   - codex is still stubbed pending parallel work by other agents.
// The dispatch table always returns an invoker; stubs throw with a
// discoverable "STUB: Phase 5" marker so failures surface loudly instead
// of silently degrading (BUG-22 stub-discipline rule).

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { run as shellRun } from "../util/shell.ts";
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
  switch (name) {
    case "claude":
      return claudeProvider();
    case "codex":
      return codexProvider();
    case "gemini":
      return geminiProvider();
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

// Permissive truthy check matching the bash convention used across the
// shell side (claude.sh and friends accept "1", "true", "yes", "on" in any
// case). The Bun port previously only accepted the literal string "true",
// which silently dropped LOKI_ALLOW_HAIKU=1 -- a real foot-gun for anyone
// switching between routes. Keep the helper narrow: a single exported
// predicate so we can broaden coverage to other env reads in a follow-up
// without re-deriving the matching rules.
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

// Resolve tier -> Claude model alias. Mirrors claude.sh:121-142
// (provider_get_tier_param) including the LOKI_ALLOW_HAIKU branch that
// upgrades fast/development tiers when haiku is opt-in only.
function claudeTierToModel(tier: SessionTier): string {
  const allowHaiku = truthy(process.env["LOKI_ALLOW_HAIKU"]);
  if (allowHaiku) {
    switch (tier) {
      case "planning":
        return "opus";
      case "development":
        return "sonnet";
      case "fast":
        return "haiku";
      default:
        return "sonnet";
    }
  }
  // Default: no haiku. Upgrade dev->opus, fast->sonnet (claude.sh:135-141).
  switch (tier) {
    case "planning":
      return "opus";
    case "development":
      return "opus";
    case "fast":
      return "sonnet";
    default:
      return "opus";
  }
}

// Apply LOKI_MAX_TIER ceiling. Mirrors claude.sh:170-186
// (resolve_model_for_tier maxTier branch).
function applyMaxTierCeiling(tier: SessionTier, model: string): string {
  const maxTier = process.env["LOKI_MAX_TIER"];
  if (!maxTier) return model;
  switch (maxTier) {
    case "haiku":
      // Cap everything to the fast-tier model. We re-resolve from fast tier
      // so LOKI_ALLOW_HAIKU is honored (claude.sh:172-175).
      return claudeTierToModel("fast");
    case "sonnet":
      // Cap planning down to development tier (claude.sh:176-181).
      if (tier === "planning") return claudeTierToModel("development");
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
// at claude.sh:192-199:
//   claude --dangerously-skip-permissions --model <model> -p <prompt>
export function claudeProvider(): ProviderInvoker {
  const cli = resolveCli("LOKI_CLAUDE_CLI", "claude");
  return {
    async invoke(call: ProviderInvocation): Promise<ProviderResult> {
      const baseModel = claudeTierToModel(call.tier);
      const model = applyMaxTierCeiling(call.tier, baseModel);

      const argv: string[] = [
        cli,
        // claude.sh:31 PROVIDER_AUTONOMOUS_FLAG
        "--dangerously-skip-permissions",
        "--model",
        model,
        // claude.sh:32 PROVIDER_PROMPT_FLAG
        "-p",
        call.prompt,
      ];

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
//   codex exec --full-auto "<prompt>"
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

// Apply LOKI_MAX_TIER ceiling. Mirrors codex.sh:163-171
// (resolve_model_for_tier maxTier branch).
function applyCodexMaxTier(effort: string): string {
  const maxTier = process.env["LOKI_MAX_TIER"];
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

// v7.4.18: switched the argv shape to align with codex CLI v0.125.0
// (latest as of 2026-04-26). Changes vs the v7.4.6 baseline:
//
//   --full-auto                        (was)
//   --ask-for-approval never           (now -- explicit)
//   --sandbox danger-full-access       (now -- explicit)
//
// `--full-auto` still works in v0.125 as a low-friction preset that
// expands to those two flags; we use the explicit form so the contract
// is forward-compatible if the preset is renamed/removed and so users
// reading the argv (e.g. in `loki status`) see exactly what is being
// granted to codex.
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

      // v7.4.18: explicit approval + sandbox flags (forward-compat over
      // --full-auto preset).
      const argv: string[] = [
        cli,
        "exec",
        "--ask-for-approval", "never",
        "--sandbox", "danger-full-access",
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
// Gemini provider (gemini.sh:1-343)
//
// Maps to provider_invoke_with_tier() at gemini.sh:300-343:
//   gemini --approval-mode=yolo --model <model> "<prompt>"
//
// Two recovery behaviors are ported from bash:
//   1. API key rotation (gemini.sh:146-176, _gemini_rotate_api_key). When the
//      first invocation fails with an auth error (401/403/unauthorized/...),
//      the next key from LOKI_GEMINI_API_KEYS is selected and the call is
//      retried once with the same model.
//   2. Rate-limit fallback to the flash model (gemini.sh:335-338). When the
//      invocation fails with a 429/quota signal in stderr, the call is retried
//      once with PROVIDER_MODEL_FALLBACK (gemini.sh:77).
//
// At most ONE recovery retry happens per .invoke() to avoid retry loops; this
// is stricter than the bash script (which can chain auth-rotation + flash-
// fallback) and is the explicit Phase 5 contract.
// ---------------------------------------------------------------------------

const GEMINI_DEFAULT_PRO = "gemini-3-pro-preview";
const GEMINI_DEFAULT_FLASH = "gemini-3-flash-preview";
const GEMINI_AUTH_ERROR_RE =
  /(401|403|unauthorized|forbidden|invalid.?api.?key|permission.?denied)/i;
const GEMINI_RATE_LIMIT_RE = /(rate.?limit|429|quota|resource.?exhausted)/i;

// Resolve tier -> Gemini model. Mirrors gemini.sh:74-76 +
// provider_get_tier_param at gemini.sh:243-251. The "thinking" level is
// informational only -- the bash script does not pass a thinking flag to
// the CLI, it only selects pro vs flash.
function geminiTierToModel(tier: SessionTier): string {
  const planning =
    process.env["LOKI_GEMINI_MODEL_PLANNING"] ??
    process.env["LOKI_MODEL_PLANNING"] ??
    GEMINI_DEFAULT_PRO;
  const development =
    process.env["LOKI_GEMINI_MODEL_DEVELOPMENT"] ??
    process.env["LOKI_MODEL_DEVELOPMENT"] ??
    GEMINI_DEFAULT_PRO;
  const fast =
    process.env["LOKI_GEMINI_MODEL_FAST"] ??
    process.env["LOKI_MODEL_FAST"] ??
    GEMINI_DEFAULT_FLASH;
  switch (tier) {
    case "planning":
      return planning;
    case "development":
      return development;
    case "fast":
      return fast;
    default:
      return development;
  }
}

// Apply LOKI_MAX_TIER ceiling. Mirrors gemini.sh:277-290.
//   haiku|flash -> always fast model
//   sonnet|pro  -> cap planning down to development model
//   opus        -> no cap
function applyGeminiMaxTier(tier: SessionTier, model: string): string {
  const maxTier = process.env["LOKI_MAX_TIER"];
  if (!maxTier) return model;
  switch (maxTier) {
    case "haiku":
    case "flash":
      return geminiTierToModel("fast");
    case "sonnet":
    case "pro":
      if (tier === "planning") return geminiTierToModel("development");
      return model;
    default:
      return model;
  }
}

// Resolve the fallback (flash) model used on rate-limit retries.
// Mirrors PROVIDER_MODEL_FALLBACK at gemini.sh:77.
function geminiFallbackModel(): string {
  return process.env["LOKI_GEMINI_MODEL_FALLBACK"] ?? GEMINI_DEFAULT_FLASH;
}

// Parse LOKI_GEMINI_API_KEYS into a clean list (drop empty / whitespace-only).
function parseGeminiKeyPool(): string[] {
  const raw = process.env["LOKI_GEMINI_API_KEYS"];
  if (!raw) return [];
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

// Pick the next API key after `current` from the pool. Mirrors
// _gemini_rotate_api_key (gemini.sh:146-176) including the wrap-around: if
// `current` is unset or not found in the pool, return the first key; if the
// pool has only one entry that equals `current`, return null (exhausted).
function rotateGeminiApiKey(current: string | undefined): string | null {
  const pool = parseGeminiKeyPool();
  if (pool.length === 0) return null;
  if (!current) return pool[0] ?? null;
  const idx = pool.indexOf(current);
  if (idx === -1) {
    // Current key not in the pool -- fall through to the first entry rather
    // than declaring exhaustion (matches the bash "first_key != current"
    // branch at gemini.sh:170-173).
    return pool[0] ?? null;
  }
  if (idx === pool.length - 1) return null; // exhausted, no wrap-around
  return pool[idx + 1] ?? null;
}

// Resolve the initial API key for the invocation. Order matches
// _gemini_resolve_api_key (gemini.sh:127-142) but returns the value rather
// than mutating process.env -- the value is injected via shellRun's `env`
// option so test isolation is preserved.
function resolveInitialGeminiKey(): string | undefined {
  const direct = process.env["GOOGLE_API_KEY"];
  if (direct && direct.length > 0) return direct;
  const alias = process.env["GEMINI_API_KEY"];
  if (alias && alias.length > 0) return alias;
  // ADC path is left to the gemini CLI. If a key pool is set, seed with the
  // first entry so the invocation has credentials even on a fresh shell.
  const pool = parseGeminiKeyPool();
  return pool[0];
}

// Build the gemini argv. Positional prompt -- gemini.sh:34-36 documents -p as
// DEPRECATED. The prompt MUST be the last argument.
function buildGeminiArgv(cli: string, model: string, prompt: string): string[] {
  return [cli, "--approval-mode=yolo", "--model", model, prompt];
}

export function geminiProvider(): ProviderInvoker {
  const cli = resolveCli("LOKI_GEMINI_CLI", "gemini");
  return {
    async invoke(call: ProviderInvocation): Promise<ProviderResult> {
      const baseModel = geminiTierToModel(call.tier);
      const model = applyGeminiMaxTier(call.tier, baseModel);

      let activeKey = resolveInitialGeminiKey();
      const env: Record<string, string> = {};
      if (activeKey) env["GOOGLE_API_KEY"] = activeKey;

      // First attempt.
      let r = await shellRun(buildGeminiArgv(cli, model, call.prompt), {
        cwd: call.cwd,
        env,
      });

      // Recovery: at most ONE retry per .invoke(). Auth error wins over
      // rate-limit if both somehow appear in stderr -- it is the cheaper
      // recovery (no model downgrade) and matches the bash ordering at
      // gemini.sh:323-332 (auth branch runs before rate-limit branch).
      if (r.exitCode !== 0 && GEMINI_AUTH_ERROR_RE.test(r.stderr)) {
        const next = rotateGeminiApiKey(activeKey);
        if (next && next !== activeKey) {
          activeKey = next;
          r = await shellRun(buildGeminiArgv(cli, model, call.prompt), {
            cwd: call.cwd,
            env: { GOOGLE_API_KEY: activeKey },
          });
        }
      } else if (r.exitCode !== 0 && GEMINI_RATE_LIMIT_RE.test(r.stderr)) {
        const fallbackModel = geminiFallbackModel();
        if (fallbackModel !== model) {
          r = await shellRun(
            buildGeminiArgv(cli, fallbackModel, call.prompt),
            { cwd: call.cwd, env },
          );
        }
      }

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
