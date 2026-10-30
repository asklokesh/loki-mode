// E-13: live stage lines, the 60s heartbeat line, and the 5-line final summary (ENGINE.md section 11). Pure formatting: callers feed in already-folded numbers (events.ts fold(), section 5), this module never reads events.jsonl itself. Null is never
// rendered as 0 (section 5, section 10): a missing cost reads "not measured", a partially-priced run reads "partial: $X for N of M sessions" (E-69), and a priced-but-zero-usage session is never shown as a real $0.00.
import { type EventEnvelope, type Verdict, STAGE_BUDGETS } from "./types.ts";
import { clipWords, collapseNotProven, formatClock, formatDuration, formatTokens } from "../util/term_width.ts";
export { formatClock, formatDuration, formatTokens }; // one owner: util/term_width.ts
import { registryLoader } from "./registry.ts";
import { redactSecrets } from "../util/redact.ts";
import type { TierOutcomeCount } from "../runner/router/history.ts";
import { conflictReasonOf } from "./events.ts"; import { isBlockingFail } from "../util/failure_memory.ts";
const NAME_WIDTH = 12; // fits "implement" + padding to align the next column
const STATUS_WIDTH = 8; // E-44: "skipped" plus one separating space (7 ran it into the duration)
const LABEL_WIDTH = 12; // fits "NOT PROVEN:" + one space
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
// Q18-07: eta.ts is optional (core never imports contrib); the first line kicks off the lazy load, so ETA and learning start from the second line.
let etaMod: { estimate?: EtaEstimator; record?: (t: number | null, a: number) => void } | null = null;
function etaOf(): NonNullable<typeof etaMod> { if (!etaMod) { etaMod = {}; registryLoader("./eta.ts").then((m) => { etaMod = m as typeof etaMod; }, () => {}); } return etaMod!; }
const targetOf = (stage: string) => STAGE_BUDGETS[stage as keyof typeof STAGE_BUDGETS]?.targetS ?? null;
/** `[00:11] intake      done   11s   repo map cached, runners: pytest, vitest` */
export function formatStageLine(line: StageLine): string {
  const clock = formatClock(line.clockS);
  const name = line.name.padEnd(NAME_WIDTH);
  const status = line.status.padEnd(STATUS_WIDTH);
  const duration = line.durationS == null ? "not measured" : formatDuration(line.durationS);
  if (line.status === "done" && line.durationS != null) etaOf().record?.(targetOf(line.name), line.durationS);
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
  const eta = h.etaS !== undefined ? h.etaS : etaOf().estimate?.(targetOf(h.stage), h.elapsedS);
  if (eta != null) bits.push(`ETA ${formatDuration(eta)}`);
  if (h.diff) bits.push(`(${h.diff.files} files, +${h.diff.insertions} -${h.diff.deletions})`);
  return `[${formatClock(h.clockS)}] ${h.stage.padEnd(NAME_WIDTH)}${bits.join("  ")}`;
}
// A-110: one outcome name and a fixed exit ladder, mapped at the edge (the receipt keeps its verdict strings). 2 is usage/preflight, returned by main().
export type Outcome = "VERIFIED" | "ALREADY_SATISFIED" | "BUDGET_STOP" | "BLOCKED" | "STALLED" | "PARTIAL" | "FAILED" | "CANCELLED";
export const EXIT: Record<Outcome, number> = { VERIFIED: 0, ALREADY_SATISFIED: 0, FAILED: 1, PARTIAL: 1, BUDGET_STOP: 3, BLOCKED: 4, STALLED: 5, CANCELLED: 130 }; // CANCELLED: SIGINT/SIGTERM during a run, distinct from FAILED (docs/cost-controls.md)
export function outcomeOf(verdict: Verdict, capHit: boolean, stop: string | null, tampered = false, sealed = false): Outcome {
  if (tampered) return "FAILED"; // a run whose event log was modified is never VERIFIED, whatever the receipt says
  if (verdict === "VERIFIED" || verdict === "ALREADY_SATISFIED") return verdict;
  return capHit && !sealed ? "BUDGET_STOP" : verdict === "SPEC_CONFLICT" ? "BLOCKED" : stop === "stalled" ? "STALLED" : verdict === "PARTIAL" ? "PARTIAL" : "FAILED"; // FC-21 (d): the Outcome line names the receipt verdict; BUDGET_STOP/STALLED/BLOCKED stay the explicit stop reasons
}
export function reasonOf(ev: EventEnvelope[], tampered: boolean, stop: string | null, outcome: Outcome): string | undefined { // A-130: one-line cause, first match wins
  const done = (s: string) => ev.findLast((e) => e.type === "stage.completed" && e.stage === s)?.data, v = done("verify"), checks = (v?.checks ?? []) as { name: string; result: string; first_error?: string; anchor?: string }[], pre = (v?.pre_red_checks ?? []) as string[], bad = checks.find((c) => isBlockingFail(c, pre)); const authCause = stop === "fatal:auth" ? String(ev.findLast((e) => e.type === "session.ended" && typeof e.data?.provider_error === "string" && e.data.provider_error !== "")?.data.provider_error ?? "") : ""; // FC-LINT-PRE-RED: a check excused as failing on base is never the reason
  const r = EXIT[outcome] === 0 ? "" : tampered ? "event log modified outside the engine" : outcome === "CANCELLED" ? `cancelled by signal; usage recorded so far is kept; next loki start offers to ${ev.some((e) => e.type === "stage.completed" && e.stage === "intake") ? "resume it (settled stages are kept) or start fresh" : "start fresh"} (any work is on loki/${ev[0]?.run ?? "<id>"})` : stop?.startsWith("fatal:") ? ({ "fatal:quota_exhausted": "provider credit exhausted", "fatal:auth": `provider authentication failed${authCause ? `: ${authCause}` : ""}` } as Record<string, string>)[stop] ?? stop : outcome === "BLOCKED" ? `spec conflict: ${conflictReasonOf(ev) ?? "see the receipt"}` : stop === "stalled" ? "stalled: same failure 3 times" : bad ? `${bad.name} failed${bad.first_error ? `: ${bad.first_error}` : ""}${bad.anchor ? ` (at ${bad.anchor})` : ""}` : (ev.some((e) => e.type === "cap.hit") ? "cost/time cap reached" : undefined) ?? ev.find((e) => e.type === "stage.failed")?.data.reason ?? (v && !checks.length ? "no tests to run" : stop ?? (ev.some((e) => e.type === "receipt.sealed") ? "" : "engine ended before sealing a receipt"));
  return plainLine(r) || undefined;
}
/** One printable line from a value that may carry attacker-controlled text (a run id, a log event type): control characters (C0, C1, bidi, zero-width, separators), so terminal escapes, become spaces, secrets are redacted, the length is capped. */
export const plainLine = (v: unknown, max = 200): string => clipWords(redactSecrets(String(v ?? "").replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\u061c\u180e\ufeff]+/g, " ").trim()), max);
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
    /** Cache read tokens and dollars saved vs the plain input rate. undefined: not reported by this caller; null: unmeasured ("cache not measured"); 0 is a real measured zero. */
    cacheReadTokens?: number | null;
    cacheSavedUsd?: number | null;
    /** Shown in parens when usd is null, e.g. "codex reports tokens only". */
    note?: string | null;
    /** E-69: some sessions priced, some not (usd above is null because the run isn't FULLY  measured). Renders "partial: $X for N of M sessions" instead of "not measured". Omit,  or leave  measuredSessions 0, for a run with no priced sessions at all. */
    partialUsd?: number;
    measuredSessions?: number;
    totalSessions?: number; stageShares?: string | null; /* TEN-COST-28: stageShareText line, printed as Spend */ capUsd?: number; // Q17-02: run cap USD when set; the measured Cost line adds "N% of cap $X"
  };
  tier?: TierSeal; wallS: number;
  stages: { label: string; seconds: number }[]; firstSealed?: boolean; // TEN-UX-11: first sealed PR in repo (METRICS row 14); only literal true marks Time
}
/** Which tier sealed, the top-tier cost avoided and this shape's sealed parity record. Every figure comes from the receipt or the router history; a missing one reads "not measured". Display only: never feeds the verdict. */
export interface TierSeal { tier?: string | null; topTierCostAvoidedUsd?: number | null; record?: Record<string, TierOutcomeCount> | null }
const TOP_TIER = "opus";
export function formatTierSeal(t: TierSeal): string {
  const tier = t.tier ? plainLine(t.tier, 40) : "", usd = t.topTierCostAvoidedUsd, rec = (k: string): string => { const c = t.record && Object.hasOwn(t.record, k) ? t.record[k] : undefined; return c && c.total > 0 ? `${k} sealed ${c.verified} of ${c.total}` : `${k} not measured`; };
  return `${tier ? `${tier} tier sealed` : "sealed tier not measured"}; top-tier cost avoided ${typeof usd === "number" && Number.isFinite(usd) && usd >= 0 ? `$${usd.toFixed(2)}` : "not measured"}; parity here: ${tier ? rec(tier) : "not measured"}, ${rec(TOP_TIER)}`;
}
function labelCol(text: string): string { return `${text}:`.padEnd(LABEL_WIDTH); }
function cacheText(c: SummaryInput["cost"]): string {
  if (c.cacheReadTokens === undefined && c.cacheSavedUsd === undefined) return "";
  return c.cacheReadTokens == null || c.cacheSavedUsd == null ? "; cache not measured" : `; cache read ${formatTokens(c.cacheReadTokens)} tokens, saved $${c.cacheSavedUsd.toFixed(2)}`;
}
/** The final summary (Outcome first, A-130), section 11. Joined by "\n", no trailing newline. */
export function formatSummary(input: SummaryInput): string {
  const prLine = input.pr
    ? `${labelCol("PR")}${input.pr.url}${input.pr.draft ? ` (draft: ${input.pr.draftReason ?? "draft"})` : ""}`
    : `${labelCol("PR")}none`;
  const verdictLine = `${labelCol("Outcome")}${input.outcome ?? input.verdict}`;
  const r = input.receipt;
  const receiptLine = r ? [`${labelCol("Receipt")}${r.tampered ? "TAMPERED (event log modified; receipt not trustworthy)" : r.sha ? `sha256:${r.sha}${r.signed === false ? " (UNSIGNED)" : r.signed === null ? " (UNCHECKED)" : ""}` : "none (UNCHECKED)"}`] : [];
  const npText = collapseNotProven(input.notProven).map((n) => n.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/ {2,}/g, " ").trim()).join(", ") || (input.receipt && !input.receipt.sha ? "everything (no receipt sealed)" : "");
  const npBody = [npText, input.flaky.length > 8 ? `flaky ${input.flaky.length} tests (listed in receipt.json)` : input.flaky.length ? `flaky ${input.flaky.join(", ")}` : ""].filter(Boolean).join("; "); // FC-OUTCOME-FLOOD; an empty list prints no line
  const costLine =
    input.cost.usd != null
      ? `${labelCol("Cost")}$${input.cost.usd.toFixed(2)} (${input.cost.provider}, ${input.cost.tokens != null ? `${formatTokens(input.cost.tokens)} tokens` : "tokens not measured"}${cacheText(input.cost)}${input.cost.note ? `; ${input.cost.note}` : ""}${input.cost.capUsd ? `; ${Math.round((input.cost.usd / input.cost.capUsd) * 100)}% of cap $${input.cost.capUsd.toFixed(2)}` : ""})`
      : input.cost.measuredSessions
        ? `${labelCol("Cost")}partial: $${(input.cost.partialUsd ?? 0).toFixed(2)} for ${input.cost.measuredSessions} of ${input.cost.totalSessions ?? input.cost.measuredSessions} sessions`
        : `${labelCol("Cost")}not measured${input.cost.note ? ` (${input.cost.note})` : ""}`;
  const stagesStr = input.stages.map((s) => `${s.label} ${formatDuration(s.seconds)}`).join(", ") + ((slow) => (slow ? `; slowest: ${slow.label} ${Math.min(100, Math.round((slow.seconds / input.wallS) * 100))}%` : ""))(input.wallS > 0 ? input.stages.filter((s) => s.seconds > 0).reduce<{ label: string; seconds: number } | null>((a, s) => (a && a.seconds >= s.seconds ? a : s), null) : null); // TEN-SPEED-03: slowest stage share of wall; needs real durations and wall
  const timeLine = `${labelCol("Time")}${formatDuration(input.wallS)} (${stagesStr})${input.firstSealed === true ? " - first sealed PR in this repo" : ""}`;
  return [verdictLine, ...(input.reason ? [`${labelCol("Reason")}${input.reason}`] : []), prLine, ...receiptLine, ...(npBody ? [`${labelCol("NOT PROVEN")}${npBody}`] : []), costLine, ...(input.tier && input.verdict === "VERIFIED" ? [`${labelCol("Tier")}${formatTierSeal(input.tier)}`] : []), ...(input.cost.stageShares ? [`${labelCol("Spend")}${input.cost.stageShares}`] : []), timeLine].join("\n");
}
/** Section 3: eta.ts is optional; when absent, ETAs are omitted. */
export type EtaEstimator = (targetS: number | null, elapsedS: number) => number | null;
/** modulePath is injectable for tests; production callers omit it and get "./eta.ts". */
export async function estimateEtaS(targetS: number | null, elapsedS: number, modulePath = "./eta.ts"): Promise<number | null> {
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
  try { return mod.estimate(targetS, elapsedS); } catch { return null; }
}
