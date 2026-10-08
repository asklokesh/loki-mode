// v8 Phase 4 Story 5 + RUN-25 iter 2: `loki start` on the Bun route. Parses the
// reconciled flag surface and runs engine10 (FC-38: never the legacy loop). Reached
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
import { tokenFreeEnv } from "../util/safe_git.ts";

function argVal(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

// FC-38: `loki start` runs only engine10. A flag is accepted only if engine10 honors it:
// --provider / --budget(-limit) / --no-pr are forwarded as child argv, --session-model reaches the
// child through LOKI_SESSION_MODEL, --attempts drives the attempts runner, --prd / --brief pick the
// spec. Every other former runner flag (--max-iterations, --simple, --allow-haiku, ...) was honored
// only by the removed legacy loop and is refused with exit 2 instead of being dropped silently.
const VALUE_FLAGS = new Set([
  "--budget-limit",
  "--budget", // alias of --budget-limit (bash uses --budget); closes the divergence
  "--provider",
  "--session-model",
  "--prd", // explicit spec path (overrides positional)
  "--brief", // one-liner spec text
  "--attempts", // 11.3.0 T5: N independent attempts in separate worktrees (1-5, default 1)
]);

const BOOL_ENV_FLAGS = new Map<string, [string, string]>();

// True no-ops on the non-interactive engine10 route (no plan step, no mirofish, no dashboard,
// no prompts). --no-pr is read separately (noPr) and forwarded to engine10.
const NOOP_BOOL_FLAGS = new Set(["--yes", "-y", "--no-plan", "--no-mirofish", "--no-dashboard", "--no-pr"]);

const VALID_PROVIDERS = new Set(["claude", "codex", "cline", "aider"]);
// The session-pin values run.sh's LOKI_SESSION_MODEL case accepts: the three
// tier names plus the Claude aliases (opus is the top-only setting; bash
// dispatches it as opus, not as the sonnet-defaulted planning tier).
const VALID_TIERS = new Set(["planning", "development", "fast", "opus", "sonnet", "haiku", "fable"]);

// Generic capability tiers: small|medium|high -> the canonical tier names.
// Callers ask for a CLASS of model and each provider supplies its own latest
// model in that class, so no user has to name a vendor model. Translated, so
// downstream consumers only ever see the canonical names in VALID_TIERS.
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
  attempts?: number;
  noPr?: boolean; // FC-38: forwarded to engine10; absent = normal PR behavior
}

const START_USAGE =
  "usage: loki start <spec> [--max-iterations N] [--max-retries N] [--budget-limit USD]\n" +
  "                        [--provider claude|codex|cline|aider] [--session-model small|medium|high|opus|sonnet|haiku]\n" +
  "                        [--completion-promise TEXT] [--base-wait S] [--max-wait S]\n" +
  "                        [--prd FILE | --brief TEXT] [--simple|--complex] [--allow-haiku]\n" +
  "                        [--regen-prd] [--skip-memory] [--attempts N]\n" +
  "  --attempts N  run N (1-5, default 1) independent attempts in separate git worktrees; the one with the most\n" +
  "                executed passing checks is applied and every loser is recorded on the attempts receipt\n" +
  "  <spec> = a PRD path, or a one-line brief. Every start runs the Loki 10 engine and seals a receipt;\n" +
  "  --github / --parallel / --sandbox / --issue / --detach and the opencode provider are refused.\n";

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
        err(`start: flag ${name} is not supported by loki start (it runs only the Loki 10 engine).\n`);
        err(
          "Orchestration flags (--parallel, --github, --issue, --sandbox, --api, --bg, mirofish) were only honored by the removed legacy loop; remove them.\n",
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
  // canonical tier names before validation. Mirrors loki_tier_alias() in
  // providers/models.sh and run.sh's entry-point case.
  const tierRaw = GENERIC_TIERS[argVal(args, "--session-model") ?? ""]
    ?? argVal(args, "--session-model");
  if (tierRaw && !VALID_TIERS.has(tierRaw)) {
    err(
      `start: unknown --session-model '${tierRaw}' ` +
        `(small|medium|high, planning|development|fast, or opus|sonnet|haiku|fable)\n`,
    );
    return 2;
  }
  // Export the pin the way run.sh does (translated, e.g. high -> planning), so
  // the provider's opus pin and every child process read the same value.
  if (tierRaw) applyEnv("LOKI_SESSION_MODEL", tierRaw);

  // --budget is an alias of --budget-limit (bash divergence closed).
  const budget = posNum(argVal(args, "--budget-limit") ?? argVal(args, "--budget"));

  let attempts: number | undefined;
  const attemptsRaw = argVal(args, "--attempts") ?? args.find((a) => a.startsWith("--attempts="))?.slice("--attempts=".length);
  if (attemptsRaw !== undefined) {
    if (!/^[1-5]$/.test(attemptsRaw)) {
      err(`start: --attempts must be an integer from 1 to 5, got '${attemptsRaw}'\n`);
      return 2;
    }
    attempts = Number(attemptsRaw);
  }

  return {
    ...(attempts !== undefined ? { attempts } : {}),
    ...(args.includes("--no-pr") ? { noPr: true } : {}),
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

/** One engine10 run (FC-38: the only engine a user-facing `start` may reach; it seals a receipt). */
async function runEngine10(cwd: string, o: ParsedStartOpts, env: NodeJS.ProcessEnv, forceNoPr: boolean): Promise<number> {
  const { spawn } = await import("node:child_process");
  const { existsSync, readFileSync, statSync } = await import("node:fs");
  const spec = o.prdPath;
  const task = existsSync(spec) && statSync(spec).isFile() ? readFileSync(spec, "utf8") : spec;
  const argv = [process.argv[1] ?? "", "engine10", task];
  if (forceNoPr || o.noPr) argv.push("--no-pr");
  if (o.provider) argv.push("--provider", o.provider);
  if (o.budgetLimit !== undefined) argv.push("--max-cost", String(o.budgetLimit)); // FC-37: per-run cap, never dropped
  return await new Promise<number>((resolveExit) => {
    const child = spawn(process.execPath, argv, { cwd, env, stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", () => resolveExit(1));
    child.on("close", (code) => resolveExit(code ?? 1));
  });
}

export async function runStart(args: readonly string[]): Promise<number> {
  const parsed = parseStartArgs(args);
  if (typeof parsed === "number") return parsed;
  const { attempts, ...runnerOpts } = parsed;
  const { runAttempts, productionDeps } = await import("../runner/attempts.ts");
  const deps = productionDeps(
    process.cwd(),
    () => runEngine10(process.cwd(), runnerOpts, process.env, false),
    async (_id, wt) => {
      // Each attempt is one engine10 run in its own worktree: only engine10 seals the receipt the scorer reads.
      // Attempts never open PRs themselves; the winner alone follows normal PR behavior (see productionDeps.openPr).
      // Token-free: attempts never push (forced --no-pr), so no attempt process needs GH_TOKEN or SSH_AUTH_SOCK.
      const env = tokenFreeEnv({ ...process.env, LOKI_DIR: `${wt}/.loki` });
      delete env["LOKI_RUN_TMP"];
      return runEngine10(wt, runnerOpts, env, true);
    },
    { noPr: runnerOpts.noPr === true },
  );
  return runAttempts(attempts ?? 1, deps);
}
