// loki-ts/src/engine10/pr_body.ts -- AI marking and DRAFT helpers (ENGINE.md section 4 "Hard cap").
// Pure, no I/O. The PR body itself is rendered by e10ext/reviewer_body.ts renderReviewerBody.
import type { Verdict } from "./types.ts";
// MARK-1 AI marking helpers (clean, cleanMarked, aiTrailers, aiMarkerLine, withAiMarker) live in util/reviewer_brief.ts, outside the engine10 line budget (D29, D33).
export { clean, cleanMarked, aiTrailers, aiMarkerLine, withAiMarker, type AiMarkInput } from "../util/reviewer_brief.ts";
/** Section 4 PR: "DRAFT when the verdict is not VERIFIED, or when the cap fired." */
export function isDraft(verdict: Verdict, capHit: boolean): boolean { return verdict !== "VERIFIED" || capHit; }
/** One line naming why the PR is a draft; null when it is not a draft. */
export function draftReason(verdict: Verdict, capHit: boolean): string | null {
  if (!isDraft(verdict, capHit)) return null;
  return capHit ? "global cap fired" : `verdict ${verdict}`;
}
