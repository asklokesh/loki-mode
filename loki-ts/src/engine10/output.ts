// E-13: live stage lines, the 60s heartbeat line, and the 5-line final summary (ENGINE.md section
// 11). Pure formatting: callers feed in already-folded numbers (events.ts fold(), section 5), this
// module never reads events.jsonl itself. Null is never rendered as 0 (section 5, section 10): a
// missing cost reads "not measured", a partially-priced run reads "partial: $X for N of M
// sessions" (E-69), and a priced-but-zero-usage session is never shown as a real $0.00.
import type { Verdict } from "./types.ts";
import { registryLoader } from "./registry.ts";
const NAME_WIDTH = 12; // fits "implement" + padding to align the next column
// E-44 (found by E-14): 7 ("skipped") left no separating space, ran duration straight into it
// ("skipped0s"); +1 guarantees at least one space after the longest status word.
const STATUS_WIDTH = 8; // fits "skipped" plus a required separating space
const LABEL_WIDTH = 12; // fits "NOT PROVEN:" + one space
export function formatClock(elapsedS: number): string {
  const s = Math.max(0, Math.round(elapsedS));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
}
export function formatDuration(totalS: number): string {
  const s = Math.max(0, Math.round(totalS));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${String(rem).padStart(2, "0")}s`;
}
/** 212000 -> "212k"; under 1000 renders as-is. */
export function formatTokens(n: number): string {
  const v = Math.max(0, Math.round(n));
  return v >= 1000 ? `${Math.round(v / 1000)}k` : `${v}`;
}
export interface StageLine {
  /** Elapsed run time (since run.started) when this line is printed. */
  clockS: number;
  /** Display name, e.g. "intake" or the combined "plan+wall". */
  name: string;
  status: "done" | "failed" | "skipped";
  /** null when the stage carries no duration_s (stage.skipped, section 5); never fabricated as 0. */
  durationS: number | null;
  detail: string;
}
/** `[00:11] intake      done   11s   repo map cached, runners: pytest, vitest` */
export function formatStageLine(line: StageLine): string {
  const clock = formatClock(line.clockS);
  const name = line.name.padEnd(NAME_WIDTH);
  const status = line.status.padEnd(STATUS_WIDTH);
  const duration = line.durationS == null ? "not measured" : formatDuration(line.durationS);
  return `[${clock}] ${name}${status}${duration}   ${line.detail}`;
}
export interface HeartbeatLine {
  /** Elapsed run time (since run.started) when this line is printed. */
  clockS: number;
  stage: string;
  /** heartbeat event's `waiting_on` (section 5). */
  waitingOn: string;
  /** Time spent in this stage so far. */
  elapsedS: number;
  etaS?: number | null;
  diff?: { files: number; insertions: number; deletions: number } | null;
}
/** `[01:05] implement   waiting on claude session  1m00s  ETA 2m00s  (3 files, +41 -2)` */
export function formatHeartbeatLine(h: HeartbeatLine): string {
  const bits = [`waiting on ${h.waitingOn}`, formatDuration(h.elapsedS)];
  if (h.etaS != null) bits.push(`ETA ${formatDuration(h.etaS)}`);
  if (h.diff) bits.push(`(${h.diff.files} files, +${h.diff.insertions} -${h.diff.deletions})`);
  return `[${formatClock(h.clockS)}] ${h.stage.padEnd(NAME_WIDTH)}${bits.join("  ")}`;
}
/** E-44 (found by E-14): sum every `cost` event's token fields, including
 *  cache read and cache creation tokens (cost.ts already tracks these;
 *  events.ts's fold() summed only input/output). Feeds SummaryInput.cost.tokens.
 *  Null, never 0, when no cost event carried any token field. */
export function foldCostTokens(events: { type: string; data: Record<string, unknown> }[]): number | null {
  let total = 0;
  let saw = false;
  for (const e of events) {
    if (e.type !== "cost") continue;
    for (const key of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens"]) {
      const v = e.data[key];
      if (typeof v === "number" && Number.isFinite(v)) {
        total += v;
        saw = true;
      }
    }
  }
  return saw ? total : null;
}
export interface SummaryInput {
  pr: { url: string; draft: boolean; draftReason?: string | null } | null;
  verdict: Verdict;
  /** Deferred/missing checks (section 9); rendered comma-joined. */
  notProven: string[];
  /** Flaky tests (section 9); rendered as a separate "; flaky ..." clause. */
  flaky: string[];
  cost: {
    usd: number | null; // null is unmeasured, never 0 (section 10)
    provider: string;
    tokens: number | null;
    /** Shown in parens when usd is null, e.g. "codex reports tokens only". */
    note?: string | null;
    /** E-69: some sessions priced, some not (usd above is null because the run isn't FULLY
     *  measured). Renders "partial: $X for N of M sessions" instead of "not measured". Omit,
     *  or leave measuredSessions 0, for a run with no priced sessions at all. */
    partialUsd?: number;
    measuredSessions?: number;
    totalSessions?: number;
  };
  wallS: number;
  stages: { label: string; seconds: number }[];
}
function labelCol(text: string): string {
  return `${text}:`.padEnd(LABEL_WIDTH);
}
/** The 5-line final summary, section 11. Joined by "\n", no trailing newline. */
export function formatSummary(input: SummaryInput): string {
  const prLine = input.pr
    ? `${labelCol("PR")}${input.pr.url}${input.pr.draft ? ` (draft: ${input.pr.draftReason ?? "draft"})` : ""}`
    : `${labelCol("PR")}none`;
  const verdictLine = `${labelCol("Verdict")}${input.verdict}`;
  let notProvenLine = `${labelCol("NOT PROVEN")}${input.notProven.join(", ")}`;
  if (input.flaky.length > 0) notProvenLine += `; flaky ${input.flaky.join(", ")}`;
  const costLine =
    input.cost.usd != null
      ? `${labelCol("Cost")}$${input.cost.usd.toFixed(2)} (${input.cost.provider}, ${input.cost.tokens != null ? `${formatTokens(input.cost.tokens)} tokens` : "tokens not measured"})`
      : input.cost.measuredSessions
        ? `${labelCol("Cost")}partial: $${(input.cost.partialUsd ?? 0).toFixed(2)} for ${input.cost.measuredSessions} of ${input.cost.totalSessions ?? input.cost.measuredSessions} sessions`
        : `${labelCol("Cost")}not measured${input.cost.note ? ` (${input.cost.note})` : ""}`;
  const stagesStr = input.stages.map((s) => `${s.label} ${formatDuration(s.seconds)}`).join(", ");
  const timeLine = `${labelCol("Time")}${formatDuration(input.wallS)} (${stagesStr})`;
  return [prLine, verdictLine, notProvenLine, costLine, timeLine].join("\n");
}
/** Section 3: an optional module loaded only if present, never a hard dependency.
 *  eta.ts (E-20, wave 2) is not part of this slice; when absent, ETAs are omitted. */
export type EtaEstimator = (targetS: number | null, elapsedS: number) => number | null;
/** modulePath is injectable for tests; production callers omit it and get "./eta.ts". */
export async function estimateEtaS(
  targetS: number | null,
  elapsedS: number,
  modulePath = "./eta.ts",
): Promise<number | null> {
  let mod: { estimate?: EtaEstimator };
  try {
    mod = (await (modulePath === "./eta.ts" ? registryLoader(modulePath) : import(modulePath))) as { estimate?: EtaEstimator };
  } catch (err) {
    // Only a missing module means "no ETA yet"; any other import error is a bug.
    const e = err as { code?: string; message?: string };
    if (e?.code === "ERR_MODULE_NOT_FOUND" || /Cannot find module|Module not found/i.test(String(e?.message ?? err))) return null;
    throw err;
  }
  if (typeof mod.estimate !== "function") return null;
  try {
    return mod.estimate(targetS, elapsedS);
  } catch {
    return null;
  }
}
