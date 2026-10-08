// ER-01: per-stage reasoning effort. Pure; off by default (LOKI_E10_EFFORT_POLICY=rerun turns it on).
// implement and wall run at medium, fix round 1 at high, fix round 2+ at xhigh only for a code-owned failure.
export function effortPolicyOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["LOKI_E10_EFFORT_POLICY"] === "rerun";
}

/** Effort for stages that need only the stage name; undefined when the policy is off or the stage is not covered. */
export function stageEffort(stage: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!effortPolicyOn(env)) return undefined;
  return stage === "implement" || stage === "wall" ? "medium" : undefined;
}

/** Fix effort by round. codeOwned = testFailures.length > 0 (the unit_model signal); lint and select-tests failures stay at high. */
export function fixEffort(round: number, codeOwned: boolean, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!effortPolicyOn(env)) return undefined;
  return round >= 2 && codeOwned ? "xhigh" : "high";
}

/** Precedence: the user's LOKI_E10_EFFORT, then the caller's explicit effort, then the policy. */
export function resolveEffort(stage: string, optsEffort: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env["LOKI_E10_EFFORT"] || optsEffort || stageEffort(stage, env);
}
