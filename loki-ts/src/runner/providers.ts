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
// Phase 5 first iteration: Claude is implemented in full. Codex, Gemini,
// Cline, Aider are stubbed and throw on resolveProvider so the runner can
// surface a clear error rather than silently degrading. Subsequent Phase 5
// iterations port the remaining four (BUG-22 stub-discipline rule).

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

// Resolve tier -> Claude model alias. Mirrors claude.sh:121-142
// (provider_get_tier_param) including the LOKI_ALLOW_HAIKU branch that
// upgrades fast/development tiers when haiku is opt-in only.
function claudeTierToModel(tier: SessionTier): string {
  const allowHaiku = process.env["LOKI_ALLOW_HAIKU"] === "true";
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

// STUB: Phase 5 next iteration -- port codex.sh:113-189 (exec --full-auto,
// CODEX_MODEL_REASONING_EFFORT env, effort-based tier mapping).
export function codexProvider(): ProviderInvoker {
  return {
    async invoke(_call: ProviderInvocation): Promise<ProviderResult> {
      // STUB: Phase 5 -- codex.sh:119 provider_invoke not yet ported.
      throw new Error(
        "codex provider not yet implemented -- STUB: Phase 5 next iteration (codex.sh:119)",
      );
    },
  };
}

// STUB: Phase 5 next iteration -- port gemini.sh:195-298 (positional prompt,
// --approval-mode=yolo, rate-limit fallback to flash, API key rotation).
export function geminiProvider(): ProviderInvoker {
  return {
    async invoke(_call: ProviderInvocation): Promise<ProviderResult> {
      // STUB: Phase 5 -- gemini.sh:195 provider_invoke not yet ported.
      throw new Error(
        "gemini provider not yet implemented -- STUB: Phase 5 next iteration (gemini.sh:195)",
      );
    },
  };
}

// STUB: Phase 5 next iteration -- port cline.sh:108-131 (positional prompt
// with -y YOLO flag, single-model dispatch).
export function clineProvider(): ProviderInvoker {
  return {
    async invoke(_call: ProviderInvocation): Promise<ProviderResult> {
      // STUB: Phase 5 -- cline.sh:108 provider_invoke not yet ported.
      throw new Error(
        "cline provider not yet implemented -- STUB: Phase 5 next iteration (cline.sh:108)",
      );
    },
  };
}

// STUB: Phase 5 next iteration -- port aider.sh:110-122 (--yes-always,
// --message <prompt>, LOKI_AIDER_FLAGS pass-through, --no-auto-commits).
export function aiderProvider(): ProviderInvoker {
  return {
    async invoke(_call: ProviderInvocation): Promise<ProviderResult> {
      // STUB: Phase 5 -- aider.sh:110 provider_invoke not yet ported.
      throw new Error(
        "aider provider not yet implemented -- STUB: Phase 5 next iteration (aider.sh:110)",
      );
    },
  };
}
