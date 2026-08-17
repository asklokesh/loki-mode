// loki-ts/src/runner/recovery_policy.ts -- harness intelligence feature 8.
//
// DETERMINISTIC recovery: map a classified failure to exactly one action, under
// hard caps, with a repeated-signature circuit breaker.
//
// The loop already classifies provider-wire failures (classifyFailure in
// retry_class.ts) and already persists them (LAST_ERROR.json, schema at
// autonomy/run.sh:1800, archived append-only and bounded to 50 entries by
// _loki_archive_last_error at autonomy/run.sh:1845). What did not exist was a
// single table saying what to DO. Scattered ad-hoc retry decisions are how a
// build burns its whole budget re-running a failure that could never succeed.
//
// OWNERSHIP: recovery may request a TIER (see requestTier in capability_router)
// and never names a provider/model ID. Recovery also does NOT own merges -- the
// execution manifest's integration owner does.
//
// THE COMPILE HAZARD, and this is the sharpest constraint in this file.
// retry_class.ts carries a load-bearing comment: the text it classifies is the
// agent's ENTIRE captured output, up to 64KB of the agent's own prose, test
// logs and fixtures -- NOT a provider error envelope. Patterns matching ordinary
// application vocabulary previously fired on benign output and aborted healthy
// runs. Compile failures are exactly that category: an agent that BUILDS a
// compiler, a linter, or an error-handling test emits "compilation failed" as
// normal output. So:
//
//   Compile failures are classified from a BUILD EXIT CODE, never from a regex
//   over agent prose. A caller with no build signal gets no compile
//   classification -- it falls through to the provider-wire classifier.
//
// DEFAULT OFF (LOKI_RECOVERY_POLICY). With the flag unset, decideRecovery()
// returns the pre-existing behavior: shouldStopRetrying() verbatim.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { lokiDir } from "../util/paths.ts";
import { classifyFailure, shouldStopRetrying, type RetryDecision } from "./retry_class.ts";
import type { CapabilityTier } from "./capability_router.ts";

export type RecoveryAction =
  | "retry" // transient; try the same thing again
  | "revise" // the work was wrong, not the transport; re-attempt with feedback
  | "checkpoint_rollback" // the tree is corrupt; restore a known-good snapshot
  | "failover" // this capability is unavailable; request a different tier
  | "escalate" // caps exhausted; hand to a human/stronger tier
  | "stop"; // no action can succeed; save the budget

export interface RecoverySignals {
  /** Agent output. Classified ONLY by the provider-wire patterns. */
  readonly output?: string;
  /**
   * Exit code of a BUILD/TEST command, if one ran. This is the only compile
   * signal accepted. `undefined` means "no build ran", NOT "the build passed".
   */
  readonly buildExitCode?: number;
  /** Working tree failed an integrity check (e.g. conflict markers, partial write). */
  readonly treeCorrupt?: boolean;
  /** Provider itself is unreachable/unavailable (distinct from a rate limit). */
  readonly providerUnavailable?: boolean;
  /** Attempts already spent on this failure. */
  readonly attempts?: number;
  /** Wall-clock seconds already spent on this failure. */
  readonly elapsedSeconds?: number;
  /** Cost already spent, in the same unit as LOKI_RECOVERY_MAX_COST. */
  readonly costSpent?: number;
}

export interface RecoveryDecision {
  readonly action: RecoveryAction;
  /** Which rule fired. Truthful state artifacts depend on this being exact. */
  readonly reason: string;
  /** Set only for `failover`. Recovery requests a TIER, never a model ID. */
  readonly requestTier?: CapabilityTier;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_SECONDS = 1_800;
const DEFAULT_SIGNATURE_THRESHOLD = 3;

function num(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function recoveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["LOKI_RECOVERY_POLICY"] === "1";
}

// ---------------------------------------------------------------------------
// Repeated-signature circuit breaker
// ---------------------------------------------------------------------------

// Read the append-only failure history bash already maintains at
// .loki/state/failure-history.jsonl (written by _loki_archive_last_error,
// autonomy/run.sh:1954 and :26124; bounded to the most recent 50 entries).
// Each line is a LAST_ERROR record. A malformed line is skipped, never fatal.
export function readFailureHistory(lokiDirOverride?: string): Array<{ error_class: string }> {
  const p = resolve(lokiDirOverride ?? lokiDir(), "state", "failure-history.jsonl");
  if (!existsSync(p)) return [];
  try {
    return readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => {
        try {
          return JSON.parse(l) as { error_class: string };
        } catch {
          return null;
        }
      })
      .filter((r): r is { error_class: string } => r !== null && typeof r.error_class === "string");
  } catch {
    return [];
  }
}

// Has `signature` recurred enough times CONSECUTIVELY at the tail of history to
// trip the breaker?
//
// Consecutive at the tail, not a total count across the run: a failure that
// happened three times an hour ago and has since been fixed must not trip the
// breaker on an unrelated new failure. Only an unbroken current streak means
// "we are stuck".
export function signatureRepeated(
  history: ReadonlyArray<{ error_class: string }>,
  signature: string,
  threshold: number,
): boolean {
  if (threshold <= 0 || signature === "") return false;
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.error_class === signature) streak += 1;
    else break;
  }
  return streak >= threshold;
}

// The history file stores BASH error_class values (autonomy/run.sh:1800 schema:
// provider_empty_output | build_timeout | rate_limited | auth_error | unknown),
// while classifyFailure() reports its own rule names. Comparing the two
// directly would never match, so the breaker would silently never trip -- a
// false-green. This maps a TS classification onto the bash vocabulary.
export function toErrorClass(sig: RecoverySignals, classified: RetryDecision): string {
  if (classified.reason === "auth") return "auth_error";
  if (classified.reason === "empty_output") return "provider_empty_output";
  if (classified.reason === "transient_marker") {
    return /\b(?:rate[_ -]?limit|429\b)/i.test(sig.output ?? "") ? "rate_limited" : "unknown";
  }
  if (sig.buildExitCode !== undefined && sig.buildExitCode !== 0) return "build_failed";
  return classified.reason === "unrecognized" ? "unknown" : classified.reason;
}

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

export interface DecideOpts {
  readonly env?: NodeJS.ProcessEnv;
  readonly lokiDirOverride?: string;
  /** Injectable for tests; defaults to reading the bash-written history file. */
  readonly history?: ReadonlyArray<{ error_class: string }>;
}

// decideRecovery -- the single deterministic mapping.
//
// Rule order is the contract, strongest terminal first:
//   1. policy off        -> legacy shouldStopRetrying behavior, verbatim
//   2. permanent failure -> stop (never retry an auth/model/quota error)
//   3. repeated signature-> stop (circuit breaker; we are provably stuck)
//   4. caps exhausted    -> escalate
//   5. tree corrupt      -> checkpoint_rollback
//   6. provider down     -> failover (tier request only)
//   7. build failed      -> revise (exit code only, never prose)
//   8. transient         -> retry
export function decideRecovery(sig: RecoverySignals, opts: DecideOpts = {}): RecoveryDecision {
  const env = opts.env ?? process.env;
  const output = sig.output ?? "";
  const classified: RetryDecision = classifyFailure(output);

  // (1) DEFAULT OFF. Reproduce today's behavior exactly.
  if (!recoveryEnabled(env)) {
    return shouldStopRetrying(classified, env)
      ? { action: "stop", reason: `legacy:${classified.reason}` }
      : { action: "retry", reason: `legacy:${classified.reason}` };
  }

  // (2) Positively-identified permanent failure. Retrying is guaranteed-identical
  // failure; stopping saves the budget for real work.
  //
  // LOKI_SMART_RETRY=0 is the documented escape hatch for "retry regardless",
  // and the runner's own log line advertises it by name. Honored here as well as
  // on the flag-off path: previously it was read only inside shouldStopRetrying,
  // so turning the recovery policy ON silently disabled the operator's opt-out
  // while the log still told them to use it. An escape hatch that stops working
  // when you enable the feature it guards is worse than not having one.
  if (classified.klass === "non_retryable" && env["LOKI_SMART_RETRY"] !== "0") {
    return { action: "stop", reason: `permanent:${classified.reason}` };
  }

  // (3) Circuit breaker. The same failure class, consecutively, at threshold.
  const threshold = num(env, "LOKI_RECOVERY_SIGNATURE_THRESHOLD", DEFAULT_SIGNATURE_THRESHOLD);
  const history = opts.history ?? readFailureHistory(opts.lokiDirOverride);
  const signature = toErrorClass(sig, classified);
  if (signatureRepeated(history, signature, threshold)) {
    return { action: "stop", reason: `repeated_signature:${signature}` };
  }

  // (4) Caps. Any exhausted cap escalates rather than silently continuing.
  const attempts = sig.attempts ?? 0;
  if (attempts >= num(env, "LOKI_RECOVERY_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS)) {
    return { action: "escalate", reason: "cap_attempts" };
  }
  if ((sig.elapsedSeconds ?? 0) >= num(env, "LOKI_RECOVERY_MAX_SECONDS", DEFAULT_MAX_SECONDS)) {
    return { action: "escalate", reason: "cap_time" };
  }
  const maxCost = env["LOKI_RECOVERY_MAX_COST"];
  if (maxCost !== undefined && maxCost !== "" && (sig.costSpent ?? 0) >= Number.parseFloat(maxCost)) {
    return { action: "escalate", reason: "cap_cost" };
  }

  // (5) A corrupt tree cannot be fixed by re-prompting; restore a checkpoint.
  if (sig.treeCorrupt === true) {
    return { action: "checkpoint_rollback", reason: "tree_corrupt" };
  }

  // (6) Provider unavailable -> request a different TIER. No model ID here.
  if (sig.providerUnavailable === true) {
    return { action: "failover", reason: "provider_unavailable", requestTier: "development" };
  }

  // (7) COMPILE/TEST FAILURE -- exit code ONLY. `undefined` means no build ran,
  // which is NOT a pass and NOT a failure; it simply yields no signal here.
  if (sig.buildExitCode !== undefined && sig.buildExitCode !== 0) {
    return { action: "revise", reason: "build_failed" };
  }

  // (8) Transient (including "unrecognized", the fail-safe direction from
  // retry_class.ts) -> retry, exactly as before.
  return { action: "retry", reason: `transient:${classified.reason}` };
}
