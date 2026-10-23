// REVIEW HANDOFF contract (renderHandoff, composeHandoff, writeHandoff, handoffSection).
// Goal: a reviewer decides accept or reject in under 2 minutes without reading agent logs.
// Outputs: .loki/review/HANDOFF.md (about 30 lines) and .loki/review/handoff.json (same data,
// version 1, plus spend and decide). Written atomically at the end of every engine10 `loki start`
// run (verified, failed, partial, budget stop, stalled, blocked); not under --json or when
// preflight refuses before any run state. supervisor.ts calls it once after the run and passes
// the markdown to the PR stage as ctx.handoffMd, appended below the reviewer body. `loki chat`
// /run prints HANDOFF.md only if written during that run. The default final summary folds
// "; review: .loki/review/HANDOFF.md" into its last line (D48 cap kept).
// Sections: header (outcome verbatim, draft flag), task, reason, run id, risk tier, elapsed,
// spend, interventions; Change (diff stat, up to 5 largest hunks); Demonstrated (verify checks
// with result pass); Failures; Not checked (not_run, skipped, flaky, receipt not_proven,
// uncovered requirements); Decide (exact accept and reject commands).
// Honesty rules: the outcome is the supervisor's label, never recomputed. Spend is "$X (measured)",
// "partial: $X for N of M sessions" or "not measured", never $0.00 for an unknown. Only result
// pass renders as PASSED. No recorded checks reads "nothing is verified". Missing risk tier or
// interventions read "not recorded". Accept/reject: PR url gives `gh pr ready && gh pr merge
// --squash` and `gh pr close`; else run branch gives `git merge --no-ff` and `git branch -D`;
// else `loki diff` and `loki undo`.
// Inputs read tolerantly: events.jsonl, .loki/state/requirements-map.json (absent is fine), git
// diff base..HEAD excluding .loki. Risk tier from plan.risk_tier, plan.tier or run.started.risk_tier.
// Interventions: steer.consumed or intervention events when present, else .loki/state/interventions.json
// (count, by_type, waited_s as written at the pause site); waited is wall-clock blocked time, an upper
// bound. Absent file and no events read "not recorded".
// Known gaps: legacy bash engine does not write a handoff; hunk summaries are the hunk header or first
// added line.
// OC-OUTPUT: one shared end-of-run summary, same format as autonomy/lib/run-summary.sh
// (legacy engine). Pure formatting; callers supply already-measured facts. Null is never shown as 0.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeGit } from "../util/safe_git.ts";
import { redactSecrets } from "../util/redact.ts";
import { formatDuration, type Outcome } from "../engine10/output.ts";
import type { EventEnvelope } from "../engine10/types.ts";
import { firstIncompleteStage } from "./run_outputs.ts";
import { colorDisabled } from "./colors.ts";
import { collapseNotProven } from "./term_width.ts";

export type RunResult = "verified" | "done-unverified" | "failed" | "stopped";

export interface RunSummaryInput {
  result: RunResult;
  filesChanged: number | null;
  insertions?: number | null;
  deletions?: number | null;
  costUsd: number | null;
  costEstimated?: boolean;
  elapsedS: number;
  receiptPath?: string | null;
  next: string;
  /** REQTRACE: requirements with no passing check, from .loki/state/requirements-map.json; absent or 0 prints nothing. */
  uncovered?: number;
}

/** Map engine10's Outcome to the four user-facing results. */
export function resultOf(outcome: Outcome): RunResult {
  if (outcome === "VERIFIED" || outcome === "ALREADY_SATISFIED") return "verified";
  if (outcome === "PARTIAL") return "done-unverified";
  if (outcome === "BUDGET_STOP" || outcome === "BLOCKED" || outcome === "STALLED" || outcome === "CANCELLED") return "stopped";
  return "failed";
}

/** The one "next:" suggestion; a failed or stopped run's reason (output.ts reasonOf) picks the exact fix. */
export function nextOf(result: RunResult, filesChanged: number | null, reason?: string, provider = "claude", runId?: string): string {
  if (result === "verified") return filesChanged ? "loki diff" : "loki status";
  if (result === "done-unverified") return "loki verify";
  const r = reason ?? "", undo = filesChanged ? "; loki undo to revert" : "";
  if (result === "stopped" && r === "cost/time cap reached") return `if the cost cap was hit, loki start --max-cost <higher>${runId ? ` (stopped run ${runId})` : ""}, then rerun the same task; if the time cap, rerun with more time`;
  if (result === "stopped") return r.startsWith("spec conflict") ? 'loki answer --text "<your decision>"' : r.startsWith("stalled") ? "loki chat --attach" : "loki status";
  if (r === "provider authentication failed" || r.startsWith("provider authentication failed: ")) {
    if (provider !== "claude") return `re-authenticate ${provider}, then loki doctor`;
    return /api key/i.test(r) ? "replace or unset ANTHROPIC_API_KEY, or run claude login" : "claude login"; // an env key outranks the login, so claude login alone would not clear a rejected key
  }
  if (r === "provider credit exhausted") return "check provider billing, or loki start --provider <other>";
  if (r === "engine ended before sealing a receipt") return "loki doctor";
  if (/^[^:]+ failed(: |$)/.test(r)) return `loki chat --attach (ask why)${undo}`;
  return filesChanged ? "loki undo" : "loki doctor";
}

export function useColor(env: NodeJS.ProcessEnv = process.env, isTty: boolean = !!process.stdout.isTTY): boolean {
  return isTty && !colorDisabled(env);
}

export function summaryObject(i: RunSummaryInput): Record<string, unknown> {
  return { result: i.result, files_changed: i.filesChanged, insertions: i.insertions ?? null, deletions: i.deletions ?? null, cost_usd: i.costUsd, cost_estimated: !!i.costEstimated, elapsed_s: Math.round(i.elapsedS), receipt: i.receiptPath ?? null, next: i.next, ...(i.uncovered ? { requirements_uncovered: i.uncovered } : {}) };
}

/** The next-step suffix naming uncovered requirements; empty when there are none. */
export function uncoveredNote(n: number | undefined): string { return n ? `${n} requirement${n === 1 ? "" : "s"} uncovered, see: loki plan --requirements` : ""; }

export function formatRunSummary(i: RunSummaryInput, opts: { json?: boolean; color?: boolean } = {}): string {
  if (opts.json) return `${JSON.stringify(summaryObject(i))}\n`;
  const paint = (code: number, t: string): string => (opts.color ? `\u001b[${code}m${t}\u001b[0m` : t);
  const tone = i.result === "verified" ? 32 : i.result === "done-unverified" ? 33 : 31;
  const files = i.filesChanged == null ? "unknown" : `${i.filesChanged} changed${i.insertions != null && i.deletions != null ? ` (+${i.insertions} -${i.deletions})` : ""}`;
  const cost = i.costUsd == null ? "not measured" : `$${i.costUsd.toFixed(2)}${i.costEstimated ? " (estimated)" : ""}`;
  const lines = [
    `Result:   ${paint(tone, i.result)}`,
    `Files:    ${files}`,
    `Cost:     ${cost}`,
    `Elapsed:  ${formatDuration(i.elapsedS)}`,
    ...(i.receiptPath ? [`Receipt:  ${i.receiptPath}`] : []),
    `next:     ${i.next}  (or: loki chat --attach)${i.uncovered ? `; ${uncoveredNote(i.uncovered)}` : ""}`,
  ];
  return `${lines.join("\n")}\n`;
}

/** Default (D48, at most 8 lines) output: add a "Next:" line, or fold it into the last line when the block already has 7 lines (the start line is printed separately). */
export function withNextLine(out: string, i: RunSummaryInput): string {
  const files = i.filesChanged == null ? "files unknown" : `${i.filesChanged} file${i.filesChanged === 1 ? "" : "s"} changed${i.insertions != null && i.deletions != null ? ` (+${i.insertions} -${i.deletions})` : ""}`;
  const lines = out.replace(/\n+$/, "").split("\n");
  const un = i.uncovered ? `; ${uncoveredNote(i.uncovered)}` : "";
  if (lines.length < 7) return `${lines.join("\n")}\nNext:       ${i.next}  (${files})${un}\n`;
  lines[lines.length - 1] += `; next: ${i.next}${un}`;
  return `${lines.join("\n")}\n`;
}

/** Best-effort diff stat of the run range; null when git cannot answer. */
export function diffStat(repoDir: string, base: string | null): { files: number; ins: number; del: number } | null {
  if (!base) return null;
  try {
    const s = safeGit(repoDir, ["diff", "--shortstat", `${base}..HEAD`, "--", ".", ":(exclude).loki"]);
    const g = (re: RegExp): number => Number(re.exec(s)?.[1] ?? 0);
    return { files: g(/(\d+) files? changed/), ins: g(/(\d+) insertion/), del: g(/(\d+) deletion/) };
  } catch {
    return null;
  }
}

/** The recorded risk-tier record for a run that started at sinceMs; null when absent, stale or unreadable. */
export function readRiskRecord(repoDir: string, sinceMs = 0): { tier?: unknown; summary?: unknown; checks_deferred?: unknown } | null {
  try {
    const p = join(repoDir, ".loki", "state", "risk-tier.json");
    if (statSync(p).mtimeMs < sinceMs) return null;
    const r = JSON.parse(readFileSync(p, "utf8"));
    return r && typeof r === "object" ? r : null;
  } catch { return null; }
}
/** The recorded summary line for a run that started at sinceMs; null when absent, stale or unreadable. */
export function readRiskSummary(repoDir: string, sinceMs = 0): string | null {
  const s = readRiskRecord(repoDir, sinceMs)?.summary;
  return typeof s === "string" && s ? s : null;
}

/** Appends the risk line to rendered output only while the default 8-line cap (D48, start line printed separately) still holds. */
export function withRiskLine(out: string, line: string | null, maxLines = 7, extraLines = 0): string {
  if (!line) return out;
  const body = out.replace(/\n+$/, "");
  return body.split("\n").length + 1 + extraLines > maxLines ? out : `${body}\n${line}\n`;
}

// HANDOFF: one compact review handoff (.loki/review/HANDOFF.md + handoff.json) composed ONLY from recorded run state.
// Nothing is recomputed: the outcome label is the supervisor's, checks come from the verify stage, spend from cost events.
// Unknown stays unknown: unmeasured spend reads "not measured" (never $0.00), a skipped or not-run check is never "passed".
export interface HandoffCheck { name: string; cmd: string; result: string; reason?: string; pre_red?: boolean }
export interface HandoffHunk { file: string; line: number; added: number; removed: number; summary: string }
export interface HandoffInput {
  task: string; outcome: string; reason?: string | null; runId: string; branch?: string | null; prUrl?: string | null; draft?: boolean;
  checks: HandoffCheck[]; notProven: string[]; failures: string[]; requirements?: { id?: string; text?: string; status?: string }[] | null;
  filesChanged: number | null; insertions?: number | null; deletions?: number | null; hunks: HandoffHunk[];
  riskTier?: string | null; deferred?: string[]; usd: number | null; partialUsd?: number; measuredSessions?: number; totalSessions?: number;
  /** Dollars spent in retry sessions (a subset of usd, from costBreakdown().retry_usd); null, 0 or absent prints nothing. */
  retryUsd?: number | null;
  elapsedS: number | null; interventions: number | null; baseSha?: string | null;
  /** By-type counts and wall-clock waited seconds from interventions.json; absent for event-counted or unrecorded runs. */
  interventionDetail?: { by_type: Record<string, number>; waited_s: number | null } | null;
  /** Merge state recorded in .loki/state/pr.json: "merged", "waiting" or "blocked:<gate>". Absent means not recorded. */
  merge?: { outcome: string; gate?: string | null; checks?: string | null } | null;
  /** First engine10 stage that never settled; set only for a run that stopped early (D07, P12-07). */
  resumeFrom?: string | null;
}
const W = 110, clip = (s: string, n = W): string => { const t = redactSecrets(String(s)).replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 3)}...` : t; };
/** Spend text: measured dollars, a partial figure, or "not measured". Never $0.00 for an unknown. */
export function spendText(i: Pick<HandoffInput, "usd" | "partialUsd" | "measuredSessions" | "totalSessions" | "retryUsd">): string {
  if (i.usd != null) return `$${i.usd.toFixed(2)} (measured)${typeof i.retryUsd === "number" && Number.isFinite(i.retryUsd) && i.retryUsd > 0 ? ` ($${i.retryUsd.toFixed(2)} on retries)` : ""}`;
  if (i.measuredSessions) return `partial: $${(i.partialUsd ?? 0).toFixed(2)} for ${i.measuredSessions} of ${i.totalSessions ?? i.measuredSessions} sessions, rest not measured`;
  return "not measured";
}
/** "2 (input 1, authorization 1); waited 4m00s", or "not recorded". Zero types are omitted; waited is an upper bound. */
function interventionsText(i: Pick<HandoffInput, "interventions" | "interventionDetail">): string {
  if (i.interventions == null) return "not recorded";
  const d = i.interventionDetail;
  const types = d ? Object.entries(d.by_type).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(", ") : "";
  return `${i.interventions}${types ? ` (${types})` : ""}${d && d.waited_s != null ? `; waited ${formatDuration(d.waited_s)}` : ""}`;
}
/** "merged", "waiting at: <gate>", or "not recorded". A blocked or waiting merge never reads as merged. */
function mergeText(m: HandoffInput["merge"]): string {
  if (!m) return "not recorded";
  const c = m.checks ? ` (checks: ${clip(m.checks, 40)})` : "";
  if (m.outcome === "merged") return `merged${c}`;
  return `waiting at: ${clip(m.outcome.startsWith("blocked:") ? m.outcome.slice(8) : m.gate || "human review", 40)}${c}`;
}
/** The exact accept and reject commands for the surface this run produced. */
export function decisionCommands(i: Pick<HandoffInput, "prUrl" | "branch" | "baseSha" | "outcome">): { accept: string; reject: string } {
  if (i.prUrl) return { accept: `gh pr ready ${i.prUrl} && gh pr merge ${i.prUrl} --squash`, reject: `gh pr close ${i.prUrl}` };
  if (i.branch) return { accept: `git merge --no-ff ${i.branch}`, reject: `git branch -D ${i.branch}` };
  return { accept: "loki diff (review), then commit what you keep", reject: "loki undo" };
}
function checkLine(c: HandoffCheck): string {
  const label = c.result === "pass" ? "PASSED" : c.result === "fail" ? "FAILED" : c.result === "flaky" ? "FLAKY (not counted as passed)" : "NOT RUN";
  return `${label}: ${clip(c.cmd || c.name, 70)}${c.reason && c.result !== "pass" ? ` (${clip(c.reason, 40)})` : ""}`;
}
/** Human view, about 30 lines. */
export function renderHandoff(i: HandoffInput): string {
  const ran = i.checks.filter((c) => c.result === "pass"), bad = i.checks.filter((c) => c.result === "fail" && !c.pre_red), onBase = i.checks.filter((c) => c.result === "fail" && c.pre_red);
  const skipped = i.checks.filter((c) => c.result !== "pass" && c.result !== "fail");
  const unc = (i.requirements ?? []).filter((r) => r.status !== "covered").map((r) => clip(r.text ?? r.id ?? "requirement", 80));
  const d = decisionCommands(i), L: string[] = [];
  L.push(`# Review handoff: ${i.outcome}${i.draft ? " (draft)" : ""}`, `Task: ${clip(i.task || "not recorded")}`);
  if (i.reason) L.push(`Reason: ${clip(i.reason)}`);
  L.push(`Run ${i.runId}; risk tier: ${i.riskTier ? clip(i.riskTier, 30) : "not recorded"}; elapsed ${i.elapsedS == null ? "not measured" : formatDuration(i.elapsedS)}; spend ${spendText(i)}; interventions ${interventionsText(i)}`);
  L.push("", `## Change: ${i.filesChanged == null ? "diff unavailable" : `${i.filesChanged} files (+${i.insertions ?? 0} -${i.deletions ?? 0})`}`);
  for (const h of i.hunks.slice(0, 5)) L.push(`- ${h.file}:${h.line} +${h.added} -${h.removed} ${clip(h.summary, 60)}`);
  if (i.hunks.length === 0) L.push("- no hunks recorded");
  L.push("", `## Demonstrated (${ran.length} passed)`);
  for (const c of ran.slice(0, 6)) L.push(`- ${checkLine(c)}`);
  if (ran.length === 0) L.push("- nothing demonstrated: no check passed");
  if (ran.length > 6) L.push(`- +${ran.length - 6} more passed`);
  if (onBase.length) L.push("", "## Already failing on base (not caused by this change, not blocking)", ...onBase.slice(0, 4).map((c) => `- ${checkLine(c)}`));
  if (bad.length || i.failures.length) { L.push("", "## Failures"); for (const c of bad.slice(0, 4)) L.push(`- ${checkLine(c)}`); for (const f of i.failures.slice(0, 3)) L.push(`- ${clip(f)}`); }
  const notChecked = [...skipped.map((c) => checkLine(c)), ...(i.deferred ?? []).map((n) => `NOT RUN (deferred by risk tier): ${clip(n, 60)}`), ...collapseNotProven(i.notProven).map((n) => `NOT PROVEN: ${clip(n, 80)}`), ...unc.map((u) => `UNCOVERED requirement: ${u}`)];
  L.push("", "## Not checked");
  for (const n of notChecked.slice(0, 8)) L.push(`- ${n}`);
  if (notChecked.length === 0) L.push(i.checks.length === 0 ? "- no checks were recorded, so nothing is verified" : "- nothing recorded as skipped or uncovered");
  if (notChecked.length > 8) L.push(`- +${notChecked.length - 8} more`);
  if (i.resumeFrom) {
    L.push("", `Stopped before stage ${clip(i.resumeFrom, 20)} completed (run ${i.runId}).`);
    L.push(`No stage is re-entered, so stage ${clip(i.resumeFrom, 20)} and every later stage rerun only in a new run: loki start.`);
    L.push("Only a run stopped after its receipt was sealed (publish phase) resumes, with loki resume or loki start --resume: it reuses that receipt and reruns only the PR step.");
  }
  if (i.filesChanged === 0 && !i.prUrl) L.push("", "## Decide", "Nothing to accept: the run committed no change.", ...(i.branch ? [`Cleanup: git branch -D ${i.branch}`] : [])); // FC-EMPTY-RUN-BRANCH-LEFT-CHECKED-OUT: the branch line shows only while the empty branch still exists
  else L.push("", "## Decide", `Accept: ${d.accept}`, `Reject: ${d.reject}`);
  if (i.prUrl) L.push(`Merge: ${mergeText(i.merge)}`);
  return `${L.join("\n")}\n`;
}
const hunkSummary = (diff: string): HandoffHunk[] => {
  const out: HandoffHunk[] = []; let file = "", cur: HandoffHunk | null = null;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ b/")) file = l.slice(6);
    else if (l.startsWith("@@")) { const m = /\+(\d+)/.exec(l); cur = { file, line: Number(m?.[1] ?? 0), added: 0, removed: 0, summary: clip(l.replace(/^@@[^@]*@@\s*/, ""), 60) }; out.push(cur); }
    else if (cur && l.startsWith("+") && !l.startsWith("+++")) { cur.added++; if (!cur.summary) cur.summary = clip(l.slice(1), 60); }
    else if (cur && l.startsWith("-") && !l.startsWith("---")) cur.removed++;
  }
  return out.sort((a, b) => b.added + b.removed - (a.added + a.removed)).slice(0, 5).map((h) => ({ ...h, summary: h.summary || "changed" }));
};
const branchExists = (repoDir: string, b: string): boolean => { try { safeGit(repoDir, ["rev-parse", "--verify", "-q", `refs/heads/${b}`], { stdio: "ignore" }); return true; } catch { return false; } };
const readJson = (p: string): unknown => { try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; } catch { return null; } };
export interface HandoffFacts { requirements?: HandoffInput["requirements"]; sinceMs?: number; repoDir: string; runId: string; events: EventEnvelope[]; outcome: string; reason?: string | null; prUrl?: string | null; draft?: boolean; usd: number | null; partialUsd?: number; retryUsd?: number | null; measuredSessions?: number; totalSessions?: number; elapsedS: number | null; notProven: string[]; task?: string; baseSha?: string | null; stats?: { files: number; ins: number; del: number } | null }
/** Compose from recorded state; every missing source degrades to "not recorded", never to a fabricated value. */
export function composeHandoff(f: HandoffFacts): HandoffInput {
  const done = (s: string): Record<string, unknown> => (f.events.findLast((e) => e.type === "stage.completed" && e.stage === s)?.data ?? {}) as Record<string, unknown>;
  const started = (f.events.find((e) => e.type === "run.started")?.data ?? {}) as Record<string, unknown>;
  const preRedNames = Array.isArray(done("verify").pre_red_checks) ? done("verify").pre_red_checks as unknown[] : [];
  const checks = (Array.isArray(done("verify").checks) ? done("verify").checks as HandoffCheck[] : []).filter((c) => c && typeof c.name === "string").map((c) => (c.result === "fail" && preRedNames.includes(c.name) ? { ...c, pre_red: true } : c));
  const rm = f.requirements === undefined ? readJson(join(f.repoDir, ".loki", "state", "requirements-map.json")) as { requirements?: HandoffInput["requirements"] } | null : { requirements: f.requirements }; // the in-memory map of THIS run wins; null means no requirements, never a disk fallback
  const rt = readRiskRecord(f.repoDir, f.sinceMs ?? 0); // same reader and freshness rule as the run summary risk line
  const risk = typeof rt?.tier === "string" ? rt.tier : undefined;
  const deferred = Array.isArray(rt?.checks_deferred) ? rt.checks_deferred.filter((x): x is string => typeof x === "string") : [];
  const iv = f.events.filter((e) => e.type === "steer.consumed" || e.type === "intervention").length;
  let count: number | null = iv > 0 ? iv : null, detail: HandoffInput["interventionDetail"] = null;
  if (count === null) { // engine10 emits no intervention events; fall back to the pause-site counter (fresh for this run only)
    try {
      const p = join(f.repoDir, ".loki", "state", "interventions.json");
      const r = statSync(p).mtimeMs < (f.sinceMs ?? 0) ? null : JSON.parse(readFileSync(p, "utf8")) as { count?: unknown; by_type?: Record<string, unknown>; waited_s?: unknown };
      const nn = (v: unknown): number | null => typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
      if (r && nn(r.count) !== null) {
        count = nn(r.count);
        const bt = r.by_type && typeof r.by_type === "object" ? Object.fromEntries(Object.entries(r.by_type).map(([k, v]) => [k, nn(v) ?? 0])) : null;
        if (bt) detail = { by_type: bt, waited_s: nn(r.waited_s) };
      }
    } catch { /* absent or unreadable stays not recorded */ }
  }
  let merge: HandoffInput["merge"] = null;
  if (f.prUrl) { // merge outcome recorded beside the "created" record; anything unrecognised stays not recorded
    try {
      const m = (JSON.parse(readFileSync(join(f.repoDir, ".loki", "state", "pr.json"), "utf8")) as { merge?: { outcome?: unknown; gate?: unknown; checks?: unknown } }).merge;
      const o = m?.outcome;
      if (typeof o === "string" && /^(merged|waiting|blocked:.+)$/.test(o)) merge = { outcome: o, gate: typeof m?.gate === "string" ? m.gate : null, checks: typeof m?.checks === "string" ? m.checks : null };
    } catch { /* absent or unreadable stays not recorded */ }
  }
  let hunks: HandoffHunk[] = [];
  if (f.baseSha) { try { hunks = hunkSummary(safeGit(f.repoDir, ["diff", "--unified=0", `${f.baseSha}..HEAD`, "--", ".", ":(exclude).loki"], { maxBuffer: 8 << 20 })); } catch { /* diff unavailable */ } }
  const failed = f.events.filter((e) => e.type === "stage.failed").map((e) => `${e.stage} failed: ${String(e.data.reason ?? "no reason recorded")}`);
  return {
    task: f.task ?? String(done("intake").task ?? "").split("\n").find((l) => l.trim()) ?? "", outcome: f.outcome, reason: f.reason, runId: f.runId, branch: typeof started.branch === "string" && !(f.stats?.files === 0 && !branchExists(f.repoDir, started.branch)) ? started.branch : null,
    prUrl: f.prUrl, draft: f.draft, checks, notProven: f.notProven, failures: failed, requirements: Array.isArray(rm?.requirements) ? rm.requirements : null,
    filesChanged: f.stats?.files ?? null, insertions: f.stats?.ins ?? null, deletions: f.stats?.del ?? null, hunks, riskTier: risk ?? null, deferred,
    usd: f.usd, partialUsd: f.partialUsd, retryUsd: f.retryUsd, measuredSessions: f.measuredSessions, totalSessions: f.totalSessions, elapsedS: f.elapsedS, interventions: count, interventionDetail: detail, merge, baseSha: f.baseSha,
    resumeFrom: ["BUDGET_STOP", "CANCELLED", "STALLED", "FAILED"].includes(f.outcome) ? firstIncompleteStage(f.events, true) : null,
  };
}
/** Atomic write of HANDOFF.md and handoff.json; returns the markdown, or null when nothing could be written. Never throws. */
export function writeHandoff(f: HandoffFacts): string | null {
  try {
    const h = composeHandoff(f), dir = join(f.repoDir, ".loki", "review"), md = renderHandoff(h);
    mkdirSync(dir, { recursive: true });
    for (const [n, body] of [["HANDOFF.md", md], ["handoff.json", `${JSON.stringify({ version: 1, ...h, spend: spendText(h), decide: decisionCommands(h) }, null, 2)}\n`]] as const) { const t = join(dir, `${n}.tmp`); writeFileSync(t, body, "utf8"); renameSync(t, join(dir, n)); }
    return md;
  } catch { return null; }
}
/** For the PR body: the same markdown, appended below the reviewer body. */
export const handoffSection = (f: HandoffFacts): string => { try { return `\n${renderHandoff(composeHandoff(f)).replace(/^# /, "## ")}`; } catch { return ""; } };
