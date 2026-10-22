// MW-2 / CH-03: warm chain (plan, implement, fix 1..n) over one SDK session. plan -> implement is default ON (LOKI_E10_FIX_RESUME=0 opts out); fix rounds stay OFF, LOKI_E10_FIX_RESUME=1 opts in.
// Lives outside engine10/ so the core line budget is untouched. Nothing here feeds a verdict: the seal path
// reads only the engine-recorded mode string and cost-file token counts, never a transcript (see tests/engine10/fix_resume.test.ts).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeGit } from "../util/safe_git.ts";
import { classifyExitCause } from "../engine10/session.ts";
import type { RunContext, SessionResult, SessionRunOptions } from "../engine10/types.ts";

/** Above this many first-turn prompt tokens a chain link starts fresh (a long resumed context costs more per turn than a cold write). */
export const CHAIN_MAX_PROMPT_TOKENS = 100_000;
/** CH-03: the warm chain is on only with LOKI_E10_FIX_RESUME=1. The default flips on after the RECEIPT-TRUTH resume-cost detection lands (a resumed session's total_cost_usd may be cumulative). */
export const chainEnabled = (): boolean => process.env["LOKI_E10_FIX_RESUME"] === "1";

/** first_turn_prompt_tokens the stream parser recorded for one iteration's result-cost file, or null. */
export function readFirstTurnTokens(repoDir: string, iterationId: string): number | null {
  try {
    const v = (JSON.parse(readFileSync(join(repoDir, ".loki", "metrics", `result-cost-${iterationId}.json`), "utf8")) as { first_turn_prompt_tokens?: unknown }).first_turn_prompt_tokens;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch { return null; }
}

/** CH-03: whether implement may resume plan's session. Same model, plan exited ok (its output carries a plan), SDK invoker, under 100K. */
export function planChain(ctx: RunContext, implementModel: string, planModel: string): { id: string } | { why: string } {
  if (process.env["LOKI_E10_FIX_RESUME"] === "0") return { why: "LOKI_E10_FIX_RESUME=0" }; // COST-5: plan -> implement is default-on; fix rounds stay opt-in via chainEnabled
  if (ctx.provider !== "claude" || process.env["LOKI_E10_INVOKER"] === "cli") return { why: "provider is not the SDK" };
  const plan = ctx.outputs().plan;
  const planIter = (plan?.iteration_ids as string[] | undefined)?.at(-1);
  if (!plan || typeof plan.plan !== "string" || !planIter) return { why: "plan did not complete" }; // a failed plan stage carries no plan text
  const id = readSessionId(ctx.repoDir, planIter);
  if (!id) return { why: "no plan session id recorded" };
  if (planModel.toLowerCase() !== implementModel.toLowerCase()) return { why: `model changed ${planModel} -> ${implementModel}` };
  const t = readFirstTurnTokens(ctx.repoDir, planIter);
  if (t !== null && t > CHAIN_MAX_PROMPT_TOKENS) return { why: `first turn prompt ${t} tokens above ${CHAIN_MAX_PROMPT_TOKENS}` };
  return { id };
}

/** The provider session id sdkQueryProvider wrote for this iteration, or null (CLI/other providers, missing file). */
export function readSessionId(repoDir: string, iterationId: string): string | null {
  try {
    const v = (JSON.parse(readFileSync(join(repoDir, ".loki", `e10-session-${iterationId}.json`), "utf8")) as { session_id?: unknown }).session_id;
    return typeof v === "string" && v ? v : null;
  } catch { return null; }
}

/** Counterpart of readSessionId: record the session id a finished iteration can be resumed from. A truncated turn is
 *  still resumable (partial work lives in the session). A model_refusal_no_fallback turn is not: the refusal sits in
 *  that session's history, so any stale id is removed and the next iteration starts fresh. Best-effort. */
export function writeSessionId(repoDir: string, iterationId: string, res: { sessionId?: string; refusedNoFallback?: boolean }): void {
  const file = join(repoDir, ".loki", `e10-session-${iterationId}.json`);
  try {
    if (res.refusedNoFallback || !res.sessionId) { if (res.refusedNoFallback) rmSync(file, { force: true }); return; }
    mkdirSync(join(repoDir, ".loki"), { recursive: true });
    writeFileSync(file, JSON.stringify({ session_id: res.sessionId }));
  } catch { /* best-effort */ }
}

/** MW-2: the new user turn of a resumed round; the session already holds the task, plan and earlier work. */
export function holdoutNote(n: number): string[] { return n > 0 ? [`${n} hidden acceptance check${n === 1 ? "" : "s"} failed. Their content is withheld; re-read the task and make the behavior correct for inputs the visible tests do not cover.`] : []; } // C-C4b: the only form in which a held-out failure reaches a fix brief
export function buildFixResumeBrief(groups: { signature: string; count: number; sample: string }[], diffStat: string | null, priorDiagnosis: string | null, holdoutFailed = 0): string {
  return ["The Fast verify run failed. Fix these grouped failures:", ...groups.map((g, i) => `${i + 1}. (${g.count}x) ${g.signature}\n   sample: ${g.sample}`), ...holdoutNote(holdoutFailed), `Diff so far:\n${diffStat ?? "(diff stat is not available)"}`, `Your previous diagnosis: ${priorDiagnosis ?? "(none was recorded)"}`].join("\n\n");
}

/** TEN-QUALITY-07: the live diff against the run base, computed fresh each fix round (no stage records one). Stat always; bounded hunks
 *  when `hunks`; untracked files by name (ls-files, no index change). .loki/ excluded. Null when git cannot answer. */
export function currentDiff(repoDir: string, baseSha: string, maxBytes = 6000, hunks = false, skip?: (f: string) => boolean): string | null {
  const ex = [":(exclude).loki", ":(exclude).loki/**"];
  try {
    const parts = [safeGit(repoDir, ["diff", "--stat", baseSha, "--", ".", ...ex]).trimEnd()];
    if (hunks) parts.push(safeGit(repoDir, ["diff", "-U2", baseSha, "--", ".", ...ex]).trimEnd());
    const fresh = safeGit(repoDir, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter((f) => f && f !== ".loki" && !f.startsWith(".loki/") && !skip?.(f));
    if (fresh.length) parts.push(`New untracked files:\n${fresh.join("\n")}`);
    const text = parts.filter(Boolean).join("\n\n") || "(no changes since the run base)";
    if (Buffer.byteLength(text) <= maxBytes) return text;
    const note = "\n[diff truncated at the byte limit]";
    return Buffer.from(text).subarray(0, Math.max(0, maxBytes - Buffer.byteLength(note))).toString("utf8").replace(/�+$/, "") + note;
  } catch { return null; }
}

export interface FixSessionOutcome {
  session: SessionResult;
  mode: string; // "resumed" | "fresh" | "fallback (<reason>)"
  why?: string; // why a flag-on round still started fresh (model changed)
  ids: string[]; // every iteration id this round ran, in order
  sessionId: string | null;
  cacheRead: number;
}

/** Runs one fix round's session. Default (flag unset): exactly one fresh session. LOKI_E10_FIX_RESUME=1: resume the latest session of
 *  the chain (implement, then each fix round) on the SAME model; any resume failure starts fresh and records why. */
export async function runFixSession(
  ctx: RunContext, base: Omit<SessionRunOptions, "iterationId" | "brief">, iterationId: string, priorIds: string[],
  chain: { sessionId: string | null; model: string }, actualModel: string, fullBrief: string, resumeBrief: string,
): Promise<FixSessionOutcome> {
  let mode = "fresh", why: string | undefined, resumeId: string | undefined;
  if (chainEnabled()) {
    if (ctx.provider !== "claude" || process.env["LOKI_E10_INVOKER"] === "cli") mode = "fallback (provider is not the SDK)";
    else if (!chain.sessionId) mode = "fallback (no session id recorded)";
    else if (actualModel !== chain.model) why = `model changed ${chain.model} -> ${actualModel}`; // L1: escalation or downgrade never keeps the old model
    else {
      const last = priorIds.at(-1) ?? (ctx.outputs().implement?.iteration_ids as string[] | undefined)?.at(-1);
      const t = last ? readFirstTurnTokens(ctx.repoDir, last) : null;
      if (t !== null && t > CHAIN_MAX_PROMPT_TOKENS) why = `first turn prompt ${t} tokens above ${CHAIN_MAX_PROMPT_TOKENS}`;
      else { mode = "resumed"; resumeId = chain.sessionId; }
    }
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
