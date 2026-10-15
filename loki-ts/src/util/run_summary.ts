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
// Known gaps: legacy bash engine does not write a handoff; interventions are counted only from
// steer.consumed or intervention events, which engine10 does not yet emit; hunk summaries are the
// hunk header or first added line.
// OC-OUTPUT: one shared end-of-run summary, same format as autonomy/lib/run-summary.sh
// (legacy engine). Pure formatting; callers supply already-measured facts. Null is never shown as 0.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeGit } from "../util/safe_git.ts";
import { redactSecrets } from "../util/redact.ts";
import { formatDuration, type Outcome } from "../engine10/output.ts";
import type { EventEnvelope } from "../engine10/types.ts";

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

/** The one "next:" suggestion. */
export function nextOf(result: RunResult, filesChanged: number | null): string {
  if (result === "verified") return filesChanged ? "loki diff" : "loki status";
  if (result === "done-unverified") return "loki verify";
  if (result === "stopped") return "loki status";
  return filesChanged ? "loki undo" : "loki doctor";
}

export function useColor(env: NodeJS.ProcessEnv = process.env, isTty: boolean = !!process.stdout.isTTY): boolean {
  return isTty && env.NO_COLOR === undefined;
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

/** The recorded summary line for a run that started at sinceMs; null when absent, stale or unreadable. */
export function readRiskSummary(repoDir: string, sinceMs = 0): string | null {
  try {
    const p = join(repoDir, ".loki", "state", "risk-tier.json");
    if (statSync(p).mtimeMs < sinceMs) return null;
    const s = (JSON.parse(readFileSync(p, "utf8")) as { summary?: unknown }).summary;
    return typeof s === "string" && s ? s : null;
  } catch { return null; }
}

/** Appends the risk line to rendered output only while the default 8-line cap (D48, start line printed separately) still holds. */
export function withRiskLine(out: string, line: string | null, maxLines = 7): string {
  if (!line) return out;
  const body = out.replace(/\n+$/, "");
  return body.split("\n").length + 1 > maxLines ? out : `${body}\n${line}\n`;
}

// HANDOFF: one compact review handoff (.loki/review/HANDOFF.md + handoff.json) composed ONLY from recorded run state.
// Nothing is recomputed: the outcome label is the supervisor's, checks come from the verify stage, spend from cost events.
// Unknown stays unknown: unmeasured spend reads "not measured" (never $0.00), a skipped or not-run check is never "passed".
export interface HandoffCheck { name: string; cmd: string; result: string; reason?: string }
export interface HandoffHunk { file: string; line: number; added: number; removed: number; summary: string }
export interface HandoffInput {
  task: string; outcome: string; reason?: string | null; runId: string; branch?: string | null; prUrl?: string | null; draft?: boolean;
  checks: HandoffCheck[]; notProven: string[]; failures: string[]; requirements?: { id?: string; text?: string; status?: string }[] | null;
  filesChanged: number | null; insertions?: number | null; deletions?: number | null; hunks: HandoffHunk[];
  riskTier?: string | null; usd: number | null; partialUsd?: number; measuredSessions?: number; totalSessions?: number;
  elapsedS: number | null; interventions: number | null; baseSha?: string | null;
}
const W = 110, clip = (s: string, n = W): string => { const t = redactSecrets(String(s)).replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 3)}...` : t; };
/** Spend text: measured dollars, a partial figure, or "not measured". Never $0.00 for an unknown. */
export function spendText(i: Pick<HandoffInput, "usd" | "partialUsd" | "measuredSessions" | "totalSessions">): string {
  if (i.usd != null) return `$${i.usd.toFixed(2)} (measured)`;
  if (i.measuredSessions) return `partial: $${(i.partialUsd ?? 0).toFixed(2)} for ${i.measuredSessions} of ${i.totalSessions ?? i.measuredSessions} sessions, rest not measured`;
  return "not measured";
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
  const ran = i.checks.filter((c) => c.result === "pass"), bad = i.checks.filter((c) => c.result === "fail");
  const skipped = i.checks.filter((c) => c.result !== "pass" && c.result !== "fail");
  const unc = (i.requirements ?? []).filter((r) => r.status !== "covered").map((r) => clip(r.text ?? r.id ?? "requirement", 80));
  const d = decisionCommands(i), L: string[] = [];
  L.push(`# Review handoff: ${i.outcome}${i.draft ? " (draft)" : ""}`, `Task: ${clip(i.task || "not recorded")}`);
  if (i.reason) L.push(`Reason: ${clip(i.reason)}`);
  L.push(`Run ${i.runId}; risk tier: ${i.riskTier ? clip(i.riskTier, 30) : "not recorded"}; elapsed ${i.elapsedS == null ? "not measured" : formatDuration(i.elapsedS)}; spend ${spendText(i)}; interventions ${i.interventions == null ? "not recorded" : i.interventions}`);
  L.push("", `## Change: ${i.filesChanged == null ? "diff unavailable" : `${i.filesChanged} files (+${i.insertions ?? 0} -${i.deletions ?? 0})`}`);
  for (const h of i.hunks.slice(0, 5)) L.push(`- ${h.file}:${h.line} +${h.added} -${h.removed} ${clip(h.summary, 60)}`);
  if (i.hunks.length === 0) L.push("- no hunks recorded");
  L.push("", `## Demonstrated (${ran.length} passed)`);
  for (const c of ran.slice(0, 6)) L.push(`- ${checkLine(c)}`);
  if (ran.length === 0) L.push("- nothing demonstrated: no check passed");
  if (ran.length > 6) L.push(`- +${ran.length - 6} more passed`);
  if (bad.length || i.failures.length) { L.push("", "## Failures"); for (const c of bad.slice(0, 4)) L.push(`- ${checkLine(c)}`); for (const f of i.failures.slice(0, 3)) L.push(`- ${clip(f)}`); }
  const notChecked = [...skipped.map((c) => checkLine(c)), ...i.notProven.map((n) => `NOT PROVEN: ${clip(n, 80)}`), ...unc.map((u) => `UNCOVERED requirement: ${u}`)];
  L.push("", "## Not checked");
  for (const n of notChecked.slice(0, 8)) L.push(`- ${n}`);
  if (notChecked.length === 0) L.push(i.checks.length === 0 ? "- no checks were recorded, so nothing is verified" : "- nothing recorded as skipped or uncovered");
  if (notChecked.length > 8) L.push(`- +${notChecked.length - 8} more`);
  L.push("", "## Decide", `Accept: ${d.accept}`, `Reject: ${d.reject}`);
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
const readJson = (p: string): unknown => { try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; } catch { return null; } };
export interface HandoffFacts { repoDir: string; runId: string; events: EventEnvelope[]; outcome: string; reason?: string | null; prUrl?: string | null; draft?: boolean; usd: number | null; partialUsd?: number; measuredSessions?: number; totalSessions?: number; elapsedS: number | null; notProven: string[]; task?: string; baseSha?: string | null; stats?: { files: number; ins: number; del: number } | null }
/** Compose from recorded state; every missing source degrades to "not recorded", never to a fabricated value. */
export function composeHandoff(f: HandoffFacts): HandoffInput {
  const done = (s: string): Record<string, unknown> => (f.events.findLast((e) => e.type === "stage.completed" && e.stage === s)?.data ?? {}) as Record<string, unknown>;
  const started = (f.events.find((e) => e.type === "run.started")?.data ?? {}) as Record<string, unknown>;
  const checks = (Array.isArray(done("verify").checks) ? done("verify").checks as HandoffCheck[] : []).filter((c) => c && typeof c.name === "string");
  const rm = readJson(join(f.repoDir, ".loki", "state", "requirements-map.json")) as { requirements?: HandoffInput["requirements"] } | null;
  const risk = [done("plan").risk_tier, done("plan").tier, started.risk_tier].find((v) => typeof v === "string") as string | undefined;
  const iv = f.events.filter((e) => e.type === "steer.consumed" || e.type === "intervention").length;
  let hunks: HandoffHunk[] = [];
  if (f.baseSha) { try { hunks = hunkSummary(safeGit(f.repoDir, ["diff", "--unified=0", `${f.baseSha}..HEAD`, "--", ".", ":(exclude).loki"], { maxBuffer: 8 << 20 })); } catch { /* diff unavailable */ } }
  const failed = f.events.filter((e) => e.type === "stage.failed").map((e) => `${e.stage} failed: ${String(e.data.reason ?? "no reason recorded")}`);
  return {
    task: f.task ?? String(done("intake").task ?? "").split("\n").find((l) => l.trim()) ?? "", outcome: f.outcome, reason: f.reason, runId: f.runId, branch: typeof started.branch === "string" ? started.branch : null,
    prUrl: f.prUrl, draft: f.draft, checks, notProven: f.notProven, failures: failed, requirements: Array.isArray(rm?.requirements) ? rm.requirements : null,
    filesChanged: f.stats?.files ?? null, insertions: f.stats?.ins ?? null, deletions: f.stats?.del ?? null, hunks, riskTier: risk ?? null,
    usd: f.usd, partialUsd: f.partialUsd, measuredSessions: f.measuredSessions, totalSessions: f.totalSessions, elapsedS: f.elapsedS, interventions: iv > 0 ? iv : null, baseSha: f.baseSha,
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
