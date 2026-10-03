// FC-19: a LOKI_SPEC_CONFLICT from implement gets exactly one resume with a correction before it is believed. No wording of the model's reason is
// inspected (L0): the model itself says whether its conflict was only about Loki's own rules or about the task.
import { readSessionId } from "../runner/session_resume.ts";
import type { RunContext, SessionResult, SessionRunOptions } from "../engine10/types.ts";

export const CONFLICT_CORRECTION =
  "Loki imposes no file or test limits on you. If your conflict is only about Loki's own rules, finish the task. If the task itself conflicts, restate the conflict. " +
  "Finish with exactly one line: LOKI_DONE, or LOKI_ALREADY_DONE: <file:line evidence>, or LOKI_SPEC_CONFLICT: <reason>.";

/** Re-runs the implement session once after a spec conflict, with the first call's options: resumes the provider session when one was recorded, else starts fresh with the original brief plus the correction. */
export async function resumeAfterConflict(ctx: RunContext, first: SessionRunOptions): Promise<{ session: SessionResult; iterationId: string }> {
  const iterationId = `${first.iterationId}-r`, sid = ctx.provider === "claude" ? readSessionId(ctx.repoDir, first.iterationId) : null;
  const session = await ctx.sessions.run({ ...first, iterationId, brief: sid ? CONFLICT_CORRECTION : `${first.brief}\n\n${CONFLICT_CORRECTION}`, ...(sid ? { resumeSessionId: sid } : {}) });
  return { session, iterationId };
}
