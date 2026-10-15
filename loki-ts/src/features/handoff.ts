// HANDOFF: one compact review handoff (.loki/review/HANDOFF.md + handoff.json) composed ONLY from recorded run state.
// Nothing is recomputed: the outcome label is the supervisor's, checks come from the verify stage, spend from cost events.
// Unknown stays unknown: unmeasured spend reads "not measured" (never $0.00), a skipped or not-run check is never "passed".
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeGit } from "../util/safe_git.ts";
import { redactSecrets } from "../util/redact.ts";
import { formatDuration } from "../engine10/output.ts";
import type { EventEnvelope } from "../engine10/types.ts";

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
