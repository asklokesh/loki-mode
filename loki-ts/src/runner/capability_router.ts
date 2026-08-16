// loki-ts/src/runner/capability_router.ts -- harness intelligence feature 5.
//
// DETERMINISTIC task-class -> capability-tier router. Given a task class (the
// kind of work an iteration is doing) it resolves the capability tier, and from
// that tier the concrete model ID.
//
// This module is THE ONLY PLACE that emits a provider/model ID. The recovery
// policy (feature 8) may request a TIER; it never names a model. That single
// ownership rule is what keeps model identity from drifting across modules.
//
// DEFAULT OFF. With LOKI_CAPABILITY_ROUTER unset, routeTaskClass() returns the
// model it was handed, unchanged. This is not a preference: 60 SHA-256
// byte-exact build_prompt parity fixtures run with a fresh env object, so any
// non-passthrough default would diverge them. Same idiom as tierRouteModel
// (src/providers/claude_flags.ts:84).

import { getRarvTier, type RarvTier } from "./rarv.ts";

// The work an iteration is doing. Deliberately small: each class must map to a
// genuinely different capability need, or it does not earn an entry.
export type TaskClass =
  | "planning" // architecture, decomposition, spec reasoning
  | "implementation" // writing code that must compile and pass tests
  | "review" // reading a diff and judging it
  | "verification" // running checks, reading output, mechanical confirmation
  | "recovery"; // re-attempting after a classified failure

// Capability tiers, ordered weakest -> strongest. The ORDER is load-bearing:
// the session ceiling comparison below is an index comparison over this array.
const TIER_ORDER = ["fast", "development", "planning"] as const;
export type CapabilityTier = (typeof TIER_ORDER)[number];

function tierRank(t: CapabilityTier): number {
  return TIER_ORDER.indexOf(t);
}

// Task class -> the tier that class NEEDS. Deterministic, no heuristics, no
// scoring. A reader can predict every routing decision from this table alone.
const TASK_CLASS_TIER: Readonly<Record<TaskClass, CapabilityTier>> = {
  planning: "planning",
  implementation: "development",
  review: "development",
  verification: "fast",
  // Recovery re-attempts work that already failed once, so it never routes
  // BELOW implementation strength -- a weaker model retrying a failed
  // implementation is how a build burns attempts without progressing.
  recovery: "development",
};

// Env var names an operator uses to pin a tier's model explicitly. Mirrors the
// pairs tierRouteModel already honors, so a pin means the same thing in both.
const PIN_VARS: Readonly<Record<CapabilityTier, readonly string[]>> = {
  planning: ["LOKI_CLAUDE_MODEL_PLANNING", "LOKI_MODEL_PLANNING"],
  development: ["LOKI_CLAUDE_MODEL_DEVELOPMENT", "LOKI_MODEL_DEVELOPMENT"],
  fast: ["LOKI_CLAUDE_MODEL_FAST", "LOKI_MODEL_FAST"],
};

// Read an explicit pin for a tier. Returns the model string, or null if unpinned.
// Empty-string env values count as UNSET (matching envPinned in claude_flags.ts).
function explicitPin(tier: CapabilityTier, env: NodeJS.ProcessEnv): string | null {
  for (const name of PIN_VARS[tier]) {
    const v = env[name];
    if (v !== undefined && v !== "") return v;
  }
  return null;
}

// Default model per tier. Generic small/medium/high convention.
const TIER_MODEL: Readonly<Record<CapabilityTier, string>> = {
  planning: "opus",
  development: "sonnet",
  fast: "haiku",
};

// Map a session-pinned model name to the tier it ceilings at. Unknown strings
// yield null (= "no ceiling I can reason about"), which is the safe direction:
// an unrecognized pin must not silently clamp routing to some default.
function sessionCeiling(sessionModel: string | undefined): CapabilityTier | null {
  switch (sessionModel) {
    case "opus":
    case "planning":
      return "planning";
    case "sonnet":
    case "development":
      return "development";
    case "haiku":
    case "fast":
      return "fast";
    default:
      return null;
  }
}

export interface RouteDecision {
  /** Model ID to dispatch. Equals the input model when the router is off. */
  readonly model: string;
  /** Tier the decision resolved to. */
  readonly tier: CapabilityTier;
  /** Why, for logs and truthful state artifacts. */
  readonly reason:
    | "router_off"
    | "explicit_override"
    | "session_ceiling"
    | "task_class"
    | "unknown_task_class";
}

export interface RouteOptions {
  /** Iteration number, used only to resolve the session/RARV tier. */
  readonly iteration?: number;
  /** Overrides process.env; for tests. */
  readonly env?: NodeJS.ProcessEnv;
}

// routeTaskClass -- resolve (task class, current model) to a routing decision.
//
// PRECEDENCE, highest first. This order is the contract:
//   1. router off              -> passthrough, unchanged
//   2. explicit model override -> the operator's pin always wins
//   3. session ceiling         -> routing may go DOWN from it, never UP
//   4. task class table        -> the deterministic mapping above
export function routeTaskClass(
  taskClass: string,
  currentModel: string,
  opts: RouteOptions = {},
): RouteDecision {
  const env = opts.env ?? process.env;

  // (1) Default OFF. Passthrough keeps parity fixtures byte-exact.
  if (env["LOKI_CAPABILITY_ROUTER"] !== "1") {
    return { model: currentModel, tier: "development", reason: "router_off" };
  }

  // An unrecognized task class routes NOTHING. Guessing a tier for work we
  // cannot classify is how a router silently downgrades real implementation
  // work; passthrough is the honest answer.
  const wanted = TASK_CLASS_TIER[taskClass as TaskClass];
  if (wanted === undefined) {
    return { model: currentModel, tier: "development", reason: "unknown_task_class" };
  }

  // (3) Session ceiling. Resolved through the existing RARV seam so the router
  // and the rest of the loop agree on what the session is pinned to.
  const sessionModel = env["LOKI_SESSION_MODEL"];
  let tier = wanted;
  let reason: RouteDecision["reason"] = "task_class";

  const ceiling = sessionCeiling(sessionModel);
  if (ceiling !== null && tierRank(tier) > tierRank(ceiling)) {
    // Wanted is STRONGER than the session allows -> clamp down to the ceiling.
    tier = ceiling;
    reason = "session_ceiling";
  }

  // (2) Explicit pin for the resolved tier wins over everything below it.
  const pinned = explicitPin(tier, env);
  if (pinned !== null) {
    return { model: pinned, tier, reason: "explicit_override" };
  }

  return { model: TIER_MODEL[tier], tier, reason };
}

// requestTier -- the interface feature 8 (recovery) uses. Recovery names a
// TIER; this resolves it to a model, honoring explicit pins. Recovery never
// touches TIER_MODEL itself, which is what keeps model identity owned here.
export function requestTier(
  tier: CapabilityTier,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return explicitPin(tier, env) ?? TIER_MODEL[tier];
}

// Resolve the tier the RARV cycle would pick for an iteration. Thin pass-through
// to the existing seam so callers do not import rarv.ts directly and re-derive
// session-pin semantics differently. ponytail: a wrapper this thin exists only
// to keep the "router owns tier resolution" boundary real.
export function currentRarvTier(iteration: number): RarvTier {
  return getRarvTier(iteration);
}
