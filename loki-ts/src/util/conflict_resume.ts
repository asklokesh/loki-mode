// FC-19: a LOKI_SPEC_CONFLICT from implement gets exactly one resume with a correction before it is believed. No wording of the model's reason is
// inspected (L0): the model itself says whether its conflict was only about Loki's own rules or about the task.
import { readSessionId } from "../runner/session_resume.ts";
import { FINISH_LINE } from "../e10ext/context.ts";
import type { RunContext, SessionResult, SessionRunOptions } from "../engine10/types.ts";

export const CONFLICT_CORRECTION =
  "Loki imposes no file or test limits on you. If your conflict is only about Loki's own rules, finish the task. If the task itself conflicts, restate the conflict. " +
  FINISH_LINE;

// FC-19b: under this much of the implement window the resume would only die at the limit; the first conflict stands and the run ends BLOCKED with its question.
export const RESUME_MIN_LEFT_S = 60;

/** Re-runs the implement session once after a spec conflict, with the first call's options: resumes the provider session when one was recorded, else starts fresh with the original brief plus the correction. */
export async function resumeAfterConflict(ctx: RunContext, first: SessionRunOptions, firstSession: SessionResult): Promise<{ session: SessionResult; iterationId: string }> {
  if ((ctx.implementLeftS?.() ?? Infinity) < RESUME_MIN_LEFT_S) return { session: firstSession, iterationId: first.iterationId };
  const iterationId = `${first.iterationId}-r`, sid = ctx.provider === "claude" ? readSessionId(ctx.repoDir, first.iterationId) : null;
  const session = await ctx.sessions.run({ ...first, iterationId, brief: sid ? CONFLICT_CORRECTION : `${first.brief}\n\n${CONFLICT_CORRECTION}`, ...(sid ? { resumeSessionId: sid } : {}) });
  const terminal = !session.killed && (session.markers.done || session.markers.alreadyDone !== null || session.markers.specConflict !== null);
  const durationS = firstSession.durationS + session.durationS;
  // A resume that errors, is killed or ends without a marker must not erase the question: the first session's conflict stands.
  return { session: { ...(terminal ? session : firstSession), durationS }, iterationId };
}

// FC-43: a LOKI_DONE exit whose tree has no change gets one correction before verify fails it. The model says which it was: forgot to edit, already satisfied, or a real conflict.
export const EMPTY_DONE_CORRECTION =
  "Your session finished with LOKI_DONE but the working tree has no change against the base. Make the change the task asks for, or if the task is already satisfied finish with LOKI_ALREADY_DONE: <file:line evidence>, or if the task itself conflicts finish with LOKI_SPEC_CONFLICT: <reason>. " +
  FINISH_LINE;

/** Same shape as resumeAfterConflict (suffix "-e"): a resume that errors, is killed or ends without a marker leaves the first result standing. */
export async function resumeAfterEmptyDone(ctx: RunContext, first: SessionRunOptions, firstSession: SessionResult): Promise<{ session: SessionResult; iterationId: string }> {
  const iterationId = `${first.iterationId}-e`, sid = ctx.provider === "claude" ? readSessionId(ctx.repoDir, first.iterationId) : null;
  const session = await ctx.sessions.run({ ...first, iterationId, brief: sid ? EMPTY_DONE_CORRECTION : `${first.brief}\n\n${EMPTY_DONE_CORRECTION}`, ...(sid ? { resumeSessionId: sid } : {}) });
  const terminal = !session.killed && (session.markers.done || session.markers.alreadyDone !== null || session.markers.specConflict !== null);
  return { session: { ...(terminal ? session : firstSession), durationS: firstSession.durationS + session.durationS }, iterationId };
}
