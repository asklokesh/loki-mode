// loki-ts/src/engine10/pr_body.ts
//
// E-19: honest DRAFT PR body (docs/v10/ENGINE.md section 4 "Hard cap" and the
// section 3 module list: "pr_body.ts honest PR body (verdict, NOT PROVEN,
// stage times, draft reason)"). Pure rendering, no I/O: stages/pr.ts (E-11,
// on main) already computes verdict, not_proven, capHit and the receipt path
// from ctx.outputs().seal; this module turns those into the markdown that
// gh pr create writes as the PR body. Stage-time formatting reuses
// output.ts's formatDuration (E-13) so the same "1m00s" style is used in the
// terminal summary and the PR body.
//
// Two contract gaps found while writing cap.test.ts, reported here rather
// than fixed (neither file is in this slice's set):
//  - machine.ts (E-02) stores `outputs[name] = res.data` without duration_s;
//    only the emitted stage.completed event gets `duration_s` added. So
//    ctx.outputs() -- all renderPrBody ever sees -- carries no per-stage
//    times in a live run, and the "Stage times:" section below never
//    renders. It degrades honestly (nothing shown, never a fabricated 0s)
//    until machine.ts adds duration_s to the stored output too.
//  - stages/seal.ts's verdictOf returns FAILED for an empty diff and never
//    reads capHit. A cap that fires before any progress therefore seals
//    FAILED, not the PARTIAL section 4 promises ("commits whatever diff
//    exists, seals with verdict PARTIAL").
import { formatDuration } from "./output.ts";
import type { StageName, Verdict } from "./types.ts";

export interface PrBodyInput {
  verdict: Verdict;
  notProven: string[];
  receiptPath: string | null;
  /** MachineRunContext.capHit() (machine.ts, E-02, on main). */
  capHit: boolean;
  /** ctx.outputs(): every completed stage's stage.completed.data, keyed by stage name. */
  outputs: Partial<Record<StageName, Record<string, unknown>>>;
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

/** Same reduction seal.ts uses for receipt.time.stages: every stage.completed
 *  data that carries a numeric duration_s, in the order outputs() reports them. */
function stageTimes(outputs: PrBodyInput["outputs"]): { name: StageName; seconds: number }[] {
  const rows: { name: StageName; seconds: number }[] = [];
  for (const [name, data] of Object.entries(outputs)) {
    if (typeof data?.["duration_s"] === "number") rows.push({ name: name as StageName, seconds: data["duration_s"] as number });
  }
  return rows;
}

/** The full PR body markdown. Never throws on empty input: an unknown verdict
 *  or an empty not_proven list still renders an honest, if sparse, body. */
export function renderPrBody(input: PrBodyInput): string {
  const draft = isDraft(input.verdict, input.capHit);
  const reason = draftReason(input.verdict, input.capHit);
  const lines = [`Verdict: ${input.verdict}${draft ? ` (DRAFT: ${reason})` : ""}`, ""];

  const stages = stageTimes(input.outputs);
  if (stages.length > 0) {
    lines.push("Stage times:", ...stages.map((s) => `- ${s.name}: ${formatDuration(s.seconds)}`), "");
  }

  lines.push("NOT PROVEN:", ...(input.notProven.length > 0 ? input.notProven.map((p) => `- ${p}`) : ["- none"]));

  if (input.receiptPath) lines.push("", `Receipt: ${input.receiptPath}`);

  return `${lines.join("\n")}\n`;
}
