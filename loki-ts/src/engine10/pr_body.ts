// loki-ts/src/engine10/pr_body.ts -- AI marking and DRAFT helpers (ENGINE.md section 4 "Hard cap").
// Pure, no I/O. The PR body itself is rendered by e10ext/reviewer_body.ts renderReviewerBody.
import type { Verdict } from "./types.ts";
/** MARK-1: LOKI_AI_MARKING=1 turns on AI trailers and the PR marker. Off by default. */
const markingOn = (env: NodeJS.ProcessEnv): boolean => env["LOKI_AI_MARKING"] === "1";
/** One line, no control characters, bounded: a value can never open a new trailer or markdown line. */
const clean = (v: string): string => v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "unknown";
export interface AiMarkInput { runId: string; provider: string; model: string; receiptRel?: string }
/** The commit trailers added after Loki-Run. Empty when the flag is off. */
export function aiTrailers(i: AiMarkInput & { receiptRel: string }, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!markingOn(env)) return [];
  return ["AI-Generated: true", `AI-Provider: ${clean(i.provider)}`, `AI-Model: ${clean(i.model)}`, `Loki-Receipt: ${clean(i.receiptRel)}`];
}
/** The single PR-body marker line; null when the flag is off. */
export function aiMarkerLine(i: AiMarkInput, env: NodeJS.ProcessEnv = process.env): string | null {
  return markingOn(env) ? `AI-Generated: true (Loki Mode, ${clean(i.provider)}, ${clean(i.model)}, run ${clean(i.runId)})` : null;
}
/** Insert the marker right after the verdict line (same anchor as the route line). */
export function withAiMarker(body: string, line: string | null): string {
  if (!line) return body;
  const lines = body.split("\n");
  const i = lines.findIndex((l) => /^(- )?Verdict:/.test(l));
  if (i < 0) return body;
  lines.splice(i + 1, 0, line);
  return lines.join("\n");
}
/** Section 4 PR: "DRAFT when the verdict is not VERIFIED, or when the cap fired." */
export function isDraft(verdict: Verdict, capHit: boolean): boolean {
  return verdict !== "VERIFIED" || capHit;
}
/** One line naming why the PR is a draft; null when it is not a draft. */
export function draftReason(verdict: Verdict, capHit: boolean): string | null {
  if (!isDraft(verdict, capHit)) return null;
  return capHit ? "global cap fired" : `verdict ${verdict}`;
}
