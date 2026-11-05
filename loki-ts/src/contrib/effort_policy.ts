// ER-01 / COST-1: per-stage reasoning effort. Pure; on by default (LOKI_E10_EFFORT_POLICY=off|0|false|legacy opts out).
// implement and wall run at medium, fix round 1 at high, fix round 2+ at xhigh only for a code-owned failure (Haiku: medium every round, see fixEffort).
export function effortPolicyOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env["LOKI_E10_EFFORT_POLICY"] ?? "").trim().toLowerCase();
  return !(v === "off" || v === "0" || v === "false" || v === "legacy");
}

/** Effort for stages that need only the stage name; undefined when the policy is off or the stage is not covered. */
export function stageEffort(stage: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!effortPolicyOn(env)) return undefined;
  return stage === "implement" || stage === "wall" ? "medium" : undefined;
}

export const isHaikuModel = (model: string | undefined): boolean => /haiku/i.test(model ?? "");
/** Fix effort by round. codeOwned = testFailures.length > 0 (the unit_model signal); lint and select-tests failures stay at high.
 *  On Haiku every round is medium (E5: one useful fix round in the 40-session replay, and fix rounds were 40% of spend), low only when every failing group is environment-shaped (info.envOnly). */
export function fixEffort(round: number, codeOwned: boolean, env: NodeJS.ProcessEnv = process.env, info?: { model?: string; envOnly?: boolean }): string | undefined {
  if (!effortPolicyOn(env)) return undefined;
  if (isHaikuModel(info?.model)) return info?.envOnly ? "low" : "medium";
  return round >= 2 && codeOwned ? "xhigh" : "high";
}

// E5 session caps on Haiku. Sized from lab/ledger.csv arm L-Haiku-v131 (437 messages, 20 implement and 10 fix sessions): p90 of hidden-pass sessions is 29 implement turns and 23 fix turns,
// 78k implement and 81k fix new tokens (input + output + cache write; cache reads excluded). The caps sit about 1.5x (turns) and 2x (tokens) above those, so they only meet runaways.
export const HAIKU_CAPS = { implement: { turns: 45, newTokens: 160_000 }, fix: { turns: 36, newTokens: 160_000, noEditByTurn: 8 } } as const;
/** Stop rules for a stage session, or undefined: not implement or fix, not Haiku, the policy off, or LOKI_E10_SESSION_CAPS=off. A positive-integer LOKI_E10_SESSION_TURNS or LOKI_E10_SESSION_TOKENS replaces a cap. */
export function sessionCaps(stage: string, model: string, env: NodeJS.ProcessEnv = process.env): { turns?: number; newTokens?: number; noEditByTurn?: number } | undefined {
  if (!effortPolicyOn(env) || !isHaikuModel(model) || (env["LOKI_E10_SESSION_CAPS"] ?? "").trim().toLowerCase() === "off") return undefined;
  const base = stage === "implement" ? HAIKU_CAPS.implement : stage === "fix" ? HAIKU_CAPS.fix : undefined;
  if (!base) return undefined;
  const pos = (v: string | undefined): number | undefined => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : undefined; };
  return { ...base, turns: pos(env["LOKI_E10_SESSION_TURNS"]) ?? base.turns, newTokens: pos(env["LOKI_E10_SESSION_TOKENS"]) ?? base.newTokens };
}

/** Precedence: the user's LOKI_E10_EFFORT, then the caller's explicit effort, then the policy. */
export function resolveEffort(stage: string, optsEffort: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env["LOKI_E10_EFFORT"] || optsEffort || stageEffort(stage, env);
}
