// v8 Phase 4 Story 5 + RUN-25 iter 2: `loki start` on the Bun route. Parses the
// reconciled flag surface into RunnerOpts / env and calls runAutonomous. Reached
// from bin/loki ONLY when LOKI_SDK_LOOP is truthy (Story 6); until then the
// default route still runs the bash cmd_start.
//
// T3(c) reconciliation (loop default-flip pre-flight): the bash cmd_start accepts
// ~44 flags. This route now handles every RUNNER flag (value-flags -> RunnerOpts,
// env-mapping flags -> process.env the lazily-imported runner reads, no-ops
// accepted) and REJECTS only genuinely-unsupported flags. Pre-loop orchestration
// flags (--parallel, --github, --sandbox, issue-mode, ...) are diverted BACK to
// the bash route by bin/loki BEFORE this code runs, so they are never seen here
// and never rejected -- the user gets full behavior. Deliberate drops
// (--compliance, mirofish) are rejected loudly and documented. See
// artifacts/ITER1-FLAG-RECONCILE.md.

import type { ProviderName, SessionTier } from "../runner/types.ts";

function argVal(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

// RUNNER value-flags: consume the next token, map to a ParsedStartOpts field.
const VALUE_FLAGS = new Set([
  "--max-iterations",
  "--max-retries",
  "--budget-limit",
  "--budget", // alias of --budget-limit (bash uses --budget); closes the divergence
  "--provider",
  "--session-model",
  "--completion-promise",
  "--base-wait",
  "--max-wait",
  "--prd", // explicit spec path (overrides positional)
  "--brief", // one-liner spec text
  // provider-specific env-mapping value flags (only affect that provider)
  "--aider-model",
  "--aider-flags",
  "--cline-model",
]);

// RUNNER boolean env-mapping flags: no value token; set an env var the runner
// already reads (or, for --skip-memory, now reads -- see build_prompt/runner).
const BOOL_ENV_FLAGS = new Map<string, [string, string]>([
  ["--allow-haiku", ["LOKI_ALLOW_HAIKU", "true"]],
  ["--simple", ["LOKI_COMPLEXITY", "simple"]],
  ["--complex", ["LOKI_COMPLEXITY", "complex"]],
  ["--regen-prd", ["LOKI_PRD_REGEN", "1"]],
  ["--regenerate-prd", ["LOKI_PRD_REGEN", "1"]],
  ["--regen", ["LOKI_PRD_REGEN", "1"]],
  ["--fresh-prd", ["LOKI_PRD_REGEN", "1"]],
  ["--skip-memory", ["LOKI_SKIP_MEMORY", "true"]],
]);

// Accept-and-ignore no-op booleans (documented no-op on the non-interactive Bun
// route). Accepted so scripts passing them do not hard-fail; they take no action.
const NOOP_BOOL_FLAGS = new Set(["--yes", "-y", "--no-plan", "--no-mirofish", "--no-dashboard"]);

const VALID_PROVIDERS = new Set(["claude", "codex", "cline", "aider"]);
const VALID_TIERS = new Set(["planning", "development", "fast"]);

// Generic capability tiers: small|medium|high -> the canonical tier names.
// Callers ask for a CLASS of model and each provider supplies its own latest
// model in that class, so no user has to name a vendor model. Translation, not
// a widened allowlist, so every downstream consumer keeps seeing three values.
const GENERIC_TIERS: Record<string, string> = {
  small: "fast",
  medium: "development",
  high: "planning",
};

// The full set of flag names this route ACCEPTS (value + bool-env + no-op).
// Anything else is rejected loudly (fail-closed: no silent capability loss).
function acceptedFlags(): Set<string> {
  const s = new Set<string>(VALUE_FLAGS);
  for (const k of BOOL_ENV_FLAGS.keys()) s.add(k);
  for (const k of NOOP_BOOL_FLAGS) s.add(k);
  s.add("--help");
  s.add("-h");
  return s;
}

function posNum(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export interface ParsedStartOpts {
  prdPath: string;
  provider?: ProviderName;
  maxIterations?: number;
  maxRetries?: number;
  budgetLimit?: number;
  sessionModel?: SessionTier;
  completionPromise?: string;
  baseWaitSeconds?: number;
  maxWaitSeconds?: number;
}

const START_USAGE =
  "usage: loki start <spec> [--max-iterations N] [--max-retries N] [--budget-limit USD]\n" +
  "                        [--provider claude|codex|cline|aider] [--session-model small|medium|high]\n" +
  "                        [--completion-promise TEXT] [--base-wait S] [--max-wait S]\n" +
  "                        [--prd FILE | --brief TEXT] [--simple|--complex] [--allow-haiku]\n" +
  "                        [--regen-prd] [--skip-memory]\n" +
  "  <spec> = a PRD path, or a one-line brief. (Issue refs / --github / --parallel /\n" +
  "  --sandbox and other orchestration flags run on the bash route automatically.)\n";

// Parse the reconciled flag surface into RunnerOpts (+ apply env-mapping flags to
// process.env), or return an error/terminal exit code. Value 0 = handled+exit
// (e.g. --help). Exported for a pure unit test. `applyEnv` lets the test capture
// env writes instead of mutating process.env.
export function parseStartArgs(
  args: readonly string[],
  err: (s: string) => void = (s) => process.stderr.write(s),
  out: (s: string) => void = (s) => process.stdout.write(s),
  applyEnv: (k: string, v: string) => void = (k, v) => {
    process.env[k] = v;
  },
): ParsedStartOpts | number {
  // --help / -h: print usage and exit 0 (terminal pre-loop arg).
  if (args.includes("--help") || args.includes("-h")) {
    out(START_USAGE);
    return 0;
  }

  const accepted = acceptedFlags();

  // Single pass: validate flag names, collect the spec, apply bool/env flags.
  // `--` ends options: the next token is the spec regardless of leading dashes.
  let spec: string | undefined;
  let endOfOpts = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a) continue;
    if (endOfOpts) {
      if (spec === undefined) spec = a;
      continue;
    }
    if (a === "--") {
      endOfOpts = true;
      continue;
    }
    if (a.startsWith("-") && a !== "-") {
      const name = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
      if (!accepted.has(name)) {
        err(`start: flag ${name} is not supported by the Bun (LOKI_SDK_LOOP) runner.\n`);
        err(
          "Orchestration flags (--parallel, --github, --issue, --sandbox, --api, --bg, mirofish) run on the bash route automatically; if you reached this, run without LOKI_SDK_LOOP.\n",
        );
        return 2;
      }
      const boolEnv = BOOL_ENV_FLAGS.get(name);
      if (boolEnv) {
        applyEnv(boolEnv[0], boolEnv[1]);
        continue;
      }
      if (NOOP_BOOL_FLAGS.has(name)) continue;
      // value-flag: skip its value token (unless inline --flag=value)
      if (VALUE_FLAGS.has(name) && !a.includes("=")) i++;
      continue;
    }
    // bare token: the spec (first one wins)
    if (spec === undefined) spec = a;
  }

  // --prd / --brief override the positional spec.
  const prdFlag = argVal(args, "--prd");
  const briefFlag = argVal(args, "--brief");
  const resolvedSpec = prdFlag ?? briefFlag ?? spec;
  if (!resolvedSpec) {
    err("start: a spec source (PRD path, --prd FILE, --brief TEXT, or issue ref) is required\n");
    err(START_USAGE);
    return 2;
  }

  // Apply provider-specific env-mapping VALUE flags (runner reads them per provider).
  const aiderModel = argVal(args, "--aider-model");
  if (aiderModel) applyEnv("LOKI_AIDER_MODEL", aiderModel);
  const aiderFlags = argVal(args, "--aider-flags");
  if (aiderFlags) applyEnv("LOKI_AIDER_FLAGS", aiderFlags);
  const clineModel = argVal(args, "--cline-model");
  if (clineModel) applyEnv("LOKI_CLINE_MODEL", clineModel);

  const providerRaw = argVal(args, "--provider");
  if (providerRaw && !VALID_PROVIDERS.has(providerRaw)) {
    err(`start: unknown --provider '${providerRaw}'\n`);
    return 2;
  }
  // Generic capability vocabulary (small|medium|high) is translated onto the
  // canonical tier names before validation, so this route accepts it without
  // VALID_TIERS -- or anything downstream of sessionModel -- widening. Mirrors
  // loki_tier_alias() in providers/models.sh and run.sh's entry-point case.
  const tierRaw = GENERIC_TIERS[argVal(args, "--session-model") ?? ""]
    ?? argVal(args, "--session-model");
  if (tierRaw && !VALID_TIERS.has(tierRaw)) {
    err(
      `start: unknown --session-model '${tierRaw}' ` +
        `(small|medium|high, or planning|development|fast)\n`,
    );
    return 2;
  }

  // --budget is an alias of --budget-limit (bash divergence closed).
  const budget = posNum(argVal(args, "--budget-limit") ?? argVal(args, "--budget"));

  return {
    prdPath: resolvedSpec,
    provider: providerRaw as ProviderName | undefined,
    maxIterations: posNum(argVal(args, "--max-iterations")),
    maxRetries: posNum(argVal(args, "--max-retries")),
    budgetLimit: budget,
    sessionModel: tierRaw as SessionTier | undefined,
    completionPromise: argVal(args, "--completion-promise"),
    baseWaitSeconds: posNum(argVal(args, "--base-wait")),
    maxWaitSeconds: posNum(argVal(args, "--max-wait")),
  };
}

export async function runStart(args: readonly string[]): Promise<number> {
  const parsed = parseStartArgs(args);
  if (typeof parsed === "number") return parsed;
  const { runAutonomous } = await import("../runner/autonomous.ts");
  return runAutonomous(parsed);
}
