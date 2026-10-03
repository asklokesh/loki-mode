// E-13: live stage lines, the 60s heartbeat line, and the 5-line final summary (ENGINE.md section
// 11). Pure formatting: callers feed in already-folded numbers (events.ts fold(), section 5), this
// module never reads events.jsonl itself. Null is never rendered as 0 (section 5, section 10): a
// missing cost reads "not measured", a partially-priced run reads "partial: $X for N of M
// sessions" (E-69), and a priced-but-zero-usage session is never shown as a real $0.00.
import type { EventEnvelope, Verdict } from "./types.ts";
import { registryLoader } from "./registry.ts";
import { redactSecrets } from "../util/redact.ts";
const NAME_WIDTH = 12; // fits "implement" + padding to align the next column
// E-44 (found by E-14): 7 ("skipped") left no separating space, ran duration straight into it
// ("skipped0s"); +1 guarantees at least one space after the longest status word.
const STATUS_WIDTH = 8; // fits "skipped" plus a required separating space
const LABEL_WIDTH = 12; // fits "NOT PROVEN:" + one space
export function formatClock(elapsedS: number): string {
  const s = Math.max(0, Math.round(elapsedS));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
export function formatDuration(totalS: number): string {
  const s = Math.max(0, Math.round(totalS));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
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
// A-110: one outcome name and a fixed exit ladder, mapped at the edge (the receipt keeps its verdict strings). 2 is usage/preflight, returned by main().
export type Outcome = "VERIFIED" | "ALREADY_SATISFIED" | "BUDGET_STOP" | "BLOCKED" | "STALLED" | "PARTIAL" | "FAILED";
export const EXIT: Record<Outcome, number> = { VERIFIED: 0, ALREADY_SATISFIED: 0, FAILED: 1, PARTIAL: 1, BUDGET_STOP: 3, BLOCKED: 4, STALLED: 5 };
export function outcomeOf(verdict: Verdict, capHit: boolean, stop: string | null, tampered = false): Outcome {
  if (tampered) return "FAILED"; // a run whose event log was modified is never VERIFIED, whatever the receipt says
  if (verdict === "VERIFIED" || verdict === "ALREADY_SATISFIED") return verdict;
  return capHit ? "BUDGET_STOP" : verdict === "SPEC_CONFLICT" ? "BLOCKED" : stop === "stalled" ? "STALLED" : verdict === "PARTIAL" ? "PARTIAL" : "FAILED"; // FC-21 (d): the Outcome line names the receipt verdict; BUDGET_STOP/STALLED/BLOCKED stay the explicit stop reasons
}
export function reasonOf(ev: EventEnvelope[], tampered: boolean, stop: string | null, outcome: Outcome): string | undefined { // A-130: one-line cause, first match wins
  const done = (s: string) => ev.findLast((e) => e.type === "stage.completed" && e.stage === s)?.data, v = done("verify"), checks = (v?.checks ?? []) as { name: string; result: string; first_error?: string }[], bad = checks.find((c) => c.result === "fail");
  const r = EXIT[outcome] === 0 ? "" : tampered ? "event log modified outside the engine" : stop?.startsWith("fatal:") ? ({ "fatal:quota_exhausted": "provider credit exhausted", "fatal:auth": "provider authentication failed" } as Record<string, string>)[stop] ?? stop : outcome === "BLOCKED" ? `spec conflict: ${done("implement")?.spec_conflict_reason ?? "see the receipt"}` : stop === "stalled" ? "stalled: same failure 3 times" : bad ? `${bad.name} failed${bad.first_error ? `: ${bad.first_error}` : ""}` : ev.find((e) => e.type === "stage.failed")?.data.reason ?? (ev.some((e) => e.type === "cap.hit") ? "cost/time cap reached" : v && !checks.length ? "no tests to run" : stop ?? (ev.some((e) => e.type === "receipt.sealed") ? "" : "engine ended before sealing a receipt"));
  return redactSecrets(String(r ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").trim()).slice(0, 200) || undefined;
}
export interface PreModelTiming { span_s: number; stages: Record<string, number> } // D61-1: startMs to first session.started, self-time per stage ("setup" = none open); sums to span_s
export function preModelTiming(events: EventEnvelope[], startMs: number): PreModelTiming | null {
  const cut = events.find((e) => e.type === "session.started"); if (!cut) return null;
  const cutMs = Math.max(startMs, Date.parse(cut.ts)), stages: Record<string, number> = {}, open: string[] = []; let prev = startMs;
  const charge = (at: number): void => { const n = open.at(-1) ?? "setup"; stages[n] = (stages[n] ?? 0) + (at - prev) / 1000; prev = at; };
  for (const e of events.slice(0, events.indexOf(cut))) { charge(Math.min(Math.max(Date.parse(e.ts), prev), cutMs)); if (e.type === "stage.started" && e.stage) open.push(e.stage); else if (/^stage\.(completed|failed|skipped)$/.test(e.type)) { const i = open.lastIndexOf(String(e.stage)); if (i >= 0) open.splice(i, 1); } }
  charge(cutMs); return { span_s: (cutMs - startMs) / 1000, stages };
}
export const formatPreModelLine = (t: PreModelTiming | null, env: NodeJS.ProcessEnv = process.env): string => env.LOKI_SPEED === "0" || !t ? "" : `pre-model ${t.span_s.toFixed(1)}s (${Object.entries(t.stages).filter(([, v]) => v >= 0.05).map(([k, v]) => `${k} ${v.toFixed(1)}s`).join(", ")})\n`; // flag off: byte-identical output
export interface SummaryInput {
  pr: { url: string; draft: boolean; draftReason?: string | null } | null;
  verdict: Verdict;
  /** A-110: the one name printed on the Outcome line; absent falls back to the receipt verdict. */
  outcome?: Outcome;
  reason?: string; receipt?: { sha: string | null; signed: boolean | null; tampered?: boolean }; // A-130: UNSIGNED/UNCHECKED always shown
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
/** The final summary (Outcome first, A-130), section 11. Joined by "\n", no trailing newline. */
export function formatSummary(input: SummaryInput): string {
  const prLine = input.pr
    ? `${labelCol("PR")}${input.pr.url}${input.pr.draft ? ` (draft: ${input.pr.draftReason ?? "draft"})` : ""}`
    : `${labelCol("PR")}none`;
  const verdictLine = `${labelCol("Outcome")}${input.outcome ?? input.verdict}`;
  const r = input.receipt;
  const receiptLine = r ? [`${labelCol("Receipt")}${r.tampered ? "TAMPERED (event log modified; receipt not trustworthy)" : r.sha ? `sha256:${r.sha}${r.signed === false ? " (UNSIGNED)" : r.signed === null ? " (UNCHECKED)" : ""}` : "none (UNCHECKED)"}`] : [];
  let notProvenLine = `${labelCol("NOT PROVEN")}${input.notProven.join(", ") || (input.receipt && !input.receipt.sha ? "everything (no receipt sealed)" : "")}`;
  if (input.flaky.length > 0) notProvenLine += `; flaky ${input.flaky.join(", ")}`;
  const costLine =
    input.cost.usd != null
      ? `${labelCol("Cost")}$${input.cost.usd.toFixed(2)} (${input.cost.provider}, ${input.cost.tokens != null ? `${formatTokens(input.cost.tokens)} tokens` : "tokens not measured"}${input.cost.note ? `; ${input.cost.note}` : ""})`
      : input.cost.measuredSessions
        ? `${labelCol("Cost")}partial: $${(input.cost.partialUsd ?? 0).toFixed(2)} for ${input.cost.measuredSessions} of ${input.cost.totalSessions ?? input.cost.measuredSessions} sessions`
        : `${labelCol("Cost")}not measured${input.cost.note ? ` (${input.cost.note})` : ""}`;
  const stagesStr = input.stages.map((s) => `${s.label} ${formatDuration(s.seconds)}`).join(", ");
  const timeLine = `${labelCol("Time")}${formatDuration(input.wallS)} (${stagesStr})`;
  return [verdictLine, ...(input.reason ? [`${labelCol("Reason")}${input.reason}`] : []), prLine, ...receiptLine, notProvenLine, costLine, timeLine].join("\n");
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
