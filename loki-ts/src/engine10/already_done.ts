// loki-ts/src/engine10/already_done.ts -- E-66: "already implemented" as a first-class v10 outcome
// (docs/v10/ENGINE.md section 4, Intake). Deterministic evidence search over the repo map, test
// map and CHANGELOG/README, gated by one short cheap-model confirmation that must cite files
// before Intake ever claims already-done. Reuses the LOKI_ALREADY_DONE marker session.ts already
// parses (implement.ts's contract), so there is no new marker to teach the provider.
import { wallModel } from "./sizing.ts";
import type { RepoMap } from "./repomap.ts";
import { buildAlreadyDoneCommentArgv, buildConfirmBrief, citesRealHit, evidenceLines, findEvidence, renderAlreadyDoneComment } from "../util/already_done_evidence.ts";
import type { EvidenceHit } from "../util/already_done_evidence.ts";
import type { RunContext, TestMap } from "./types.ts";
export { buildAlreadyDoneCommentArgv, buildConfirmBrief, evidenceLines, findEvidence, renderAlreadyDoneComment };
export type { EvidenceHit };

export interface AlreadyDoneResult {
  satisfied: true;
  evidence: string[]; // the model's own citation first, then the deterministic hits behind it
  paths: string[]; // the hits' file paths (FC-15: checked against the PR target)
}

/** Runs the deterministic search, then, only on a candidate, one short confirmation session
 *  (fast tier pinned to wallModel(), the same cheap-model pin E-45 uses for Wall). No candidate,
 *  no session call: findEvidence's own gate is what keeps this off the hot path. */
export async function checkAlreadyDone(
  ctx: RunContext,
  signal: AbortSignal,
  task: string,
  repoMap: RepoMap,
  testMap: TestMap,
): Promise<AlreadyDoneResult | null> {
  const hits = findEvidence(task, repoMap, testMap, ctx.repoDir);
  if (hits.length === 0 || signal.aborted) return null;
  const session = await ctx.sessions.run({
    stage: "intake",
    brief: buildConfirmBrief(task, hits),
    tier: "fast",
    model: wallModel(),
    iterationId: `${ctx.runId}-already-done`,
    limitS: 30,
    signal,
    cwd: ctx.repoDir,
  });
  const marker = session.markers.alreadyDone;
  if (!marker) return null;
  // The citation must actually point at one of the search's own hits, not just any file name.
  if (!hits.some((h) => citesRealHit(marker, h, ctx.repoDir))) return null;
  return { satisfied: true, evidence: [marker, ...evidenceLines(hits)], paths: hits.map((h) => h.path) };
}
