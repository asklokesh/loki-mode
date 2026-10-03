// loki-ts/src/engine10/pr_body.ts -- E-19 honest DRAFT PR body (ENGINE.md section 4 "Hard cap").
// Pure rendering, no I/O: stages/pr.ts already computes verdict/notProven/capHit/receiptPath from
// ctx.outputs().seal; formatDuration (output.ts) keeps "1m00s" style consistent with the summary.
// Known contract gap: machine.ts stores outputs[name] = res.data with no duration_s (only the
// emitted event gets it), so "Stage times:" degrades honestly to nothing shown, never a fake 0s,
// until machine.ts stores duration_s too.
import { formatDuration } from "./output.ts";
import type { StageName, Verdict } from "./types.ts"; import { unitTableLines, type ReceiptGroup } from "../features/speed/seal_group.ts";
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
  if (input.group) lines.push("", ...unitTableLines(input.group));
  return `${lines.join("\n")}\n`;
}
