// MW-2: opt-in (LOKI_E10_FIX_RESUME=1, default off) resume of the engine10 SDK session by a fix round.
// Lives outside engine10/ so the core line budget is untouched. Nothing here feeds a verdict: the seal path
// reads only the engine-recorded mode string and cost-file token counts, never a transcript (see tests/engine10/fix_resume.test.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyExitCause } from "../engine10/session.ts";
import type { RunContext, SessionResult, SessionRunOptions } from "../engine10/types.ts";

/** The provider session id sdkQueryProvider wrote for this iteration, or null (CLI/other providers, missing file). */
export function readSessionId(repoDir: string, iterationId: string): string | null {
  try {
    const v = (JSON.parse(readFileSync(join(repoDir, ".loki", `e10-session-${iterationId}.json`), "utf8")) as { session_id?: unknown }).session_id;
    return typeof v === "string" && v ? v : null;
  } catch { return null; }
}

/** MW-2: the new user turn of a resumed round; the session already holds the task, plan and earlier work. */
export function buildFixResumeBrief(groups: { signature: string; count: number; sample: string }[], diffStat: string | null, priorDiagnosis: string | null): string {
  return ["The Fast verify run failed. Fix these grouped failures:", ...groups.map((g, i) => `${i + 1}. (${g.count}x) ${g.signature}\n   sample: ${g.sample}`), `Diff so far:\n${diffStat ?? "(diff stat is not available)"}`, `Your previous diagnosis: ${priorDiagnosis ?? "(none was recorded)"}`].join("\n\n");
}

export interface FixSessionOutcome {
  session: SessionResult;
  mode: string; // "resumed" | "fresh" | "fallback (<reason>)"
  why?: string; // why a flag-on round still started fresh (model changed)
  ids: string[]; // every iteration id this round ran, in order
  sessionId: string | null;
  cacheRead: number;
}

/** Runs one fix round's session. Flag off: exactly one fresh session, as before. Flag on: resume the latest session of
 *  the chain (implement, then each fix round) on the SAME model; any resume failure starts fresh and records why. */
export async function runFixSession(
  ctx: RunContext, base: Omit<SessionRunOptions, "iterationId" | "brief">, iterationId: string, priorIds: string[],
  chain: { sessionId: string | null; model: string }, actualModel: string, fullBrief: string, resumeBrief: string,
): Promise<FixSessionOutcome> {
  let mode = "fresh", why: string | undefined, resumeId: string | undefined;
  if (process.env["LOKI_E10_FIX_RESUME"] === "1") {
    if (ctx.provider !== "claude" || process.env["LOKI_E10_INVOKER"] === "cli") mode = "fallback (provider is not the SDK)";
    else if (!chain.sessionId) mode = "fallback (no session id recorded)";
    else if (actualModel !== chain.model) why = `model changed ${chain.model} -> ${actualModel}`; // L1: escalation or downgrade never keeps the old model
    else { mode = "resumed"; resumeId = chain.sessionId; }
  }
  let iterId = iterationId;
  const ids = [...priorIds, iterId];
  let session = await ctx.sessions.run({ ...base, iterationId: iterId, brief: resumeId ? resumeBrief : fullBrief, ...(resumeId ? { resumeSessionId: resumeId } : {}) });
  if (resumeId && !session.killed && session.exit !== 0) { // never blocks: a failed resume reruns fresh with the original brief
    const err = (session as unknown as { stderrTail?: string }).stderrTail ?? "";
    mode = `fallback (${(/sdk-loop error: ([^\]\n]*)/.exec(err)?.[1] ?? classifyExitCause(session.exit, false)).slice(0, 120)})`;
    iterId = `${iterId}f`; ids.push(iterId);
    session = await ctx.sessions.run({ ...base, iterationId: iterId, brief: fullBrief });
  }
  return { session, mode, ...(why ? { why } : {}), ids, sessionId: readSessionId(ctx.repoDir, iterId), cacheRead: ctx.cost.read(ctx.repoDir, [iterId]).cacheReadTokens };
}
