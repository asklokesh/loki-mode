// loki-ts/src/engine10/pr_body.ts -- E-19 honest DRAFT PR body (ENGINE.md section 4 "Hard cap").
// Pure rendering, no I/O: stages/pr.ts already computes verdict/notProven/capHit/receiptPath from
// ctx.outputs().seal; formatDuration (output.ts) keeps "1m00s" style consistent with the summary.
// Known contract gap: machine.ts stores outputs[name] = res.data with no duration_s (only the
// emitted event gets it), so "Stage times:" degrades honestly to nothing shown, never a fake 0s,
// until machine.ts stores duration_s too.
import { formatDuration } from "./output.ts"; import { withRouteLine } from "../runner/router/route_block.ts"; // R1-15 route block lives outside engine10 (size budget D29)
import type { StageName, Verdict } from "./types.ts"; import { unitTableLines, type ReceiptGroup } from "../features/speed/seal_group.ts";
import { deriveCriteria, intakeTask, layoutPrBody, type CriterionRow } from "../features/pr_criteria.ts";
export { PR_BODY_LINE_BUDGET, type CriterionRow } from "../features/pr_criteria.ts";
export interface PrBodyInput {
  verdict: Verdict;
  notProven: string[];
  receiptPath: string | null;
  /** MachineRunContext.capHit() (machine.ts, E-02, on main). */
  capHit: boolean;
  /** ctx.outputs(): every completed stage's stage.completed.data, keyed by stage name. */
  outputs: Partial<Record<StageName, Record<string, unknown>>>;
  /** D61-13: the combined receipt's group section; absent for a single run. */
  group?: ReceiptGroup;
  /** INTEL-3: one-line delivery contract; defaults to the first line of outputs.intake.task. */
  contract?: string;
  /** INTEL-3: explicit criterion rows; defaults to the intake task bullets mapped to verify/wall data. */
  criteria?: CriterionRow[];
  /** R1-15: one-line route summary (routePrLine); absent when the router is off, so the body is byte-identical. */
  routeLine?: string;
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
  const task = intakeTask(input.outputs);
  const stages = stageTimes(input.outputs).map((s) => `- ${s.name}: ${formatDuration(s.seconds)}`);
  return withRouteLine(layoutPrBody({
    contract: input.contract ?? (task.split("\n").find((l) => l.trim()) ?? ""), verdictLine: `Verdict: ${input.verdict}${draft ? ` (DRAFT: ${reason})` : ""}`,
    timing: stages, notProven: input.notProven, receipt: input.receiptPath, group: input.group ? unitTableLines(input.group) : [],
    rows: input.criteria ?? deriveCriteria(input.outputs), legacy: !input.contract && !input.criteria && !task,
  }), input.routeLine ?? null);
}
