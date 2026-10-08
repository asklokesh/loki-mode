// loki-ts/src/engine10/pr_body.ts -- E-19 honest DRAFT PR body (ENGINE.md section 4 "Hard cap").
// Pure rendering, no I/O: stages/pr.ts already computes verdict/notProven/capHit/receiptPath from
// ctx.outputs().seal; formatDuration (output.ts) keeps "1m00s" style consistent with the summary.
// machine.ts stores duration_s on every completed stage's output (RECEIPT-TRUTH); a stage that
// never completed has none, and "Stage times:" shows nothing for it, never a fake 0s.
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
  /** MARK-1: the one-line AI marker (aiMarkerLine); absent unless LOKI_AI_MARKING=1, so the body is byte-identical. */
  aiMarker?: string;
}
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
  return withAiMarker(withRouteLine(layoutPrBody({
    contract: input.contract ?? (task.split("\n").find((l) => l.trim()) ?? ""), verdictLine: `Verdict: ${input.verdict}${draft ? ` (DRAFT: ${reason})` : ""}`,
    timing: stages, notProven: input.notProven, receipt: input.receiptPath, group: input.group ? unitTableLines(input.group) : [],
    rows: input.criteria ?? deriveCriteria(input.outputs), legacy: !input.contract && !input.criteria && !task,
    reserve: input.aiMarker ? 1 : 0,
  }), input.routeLine ?? null), input.aiMarker ?? null);
}
