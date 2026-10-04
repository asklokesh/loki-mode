// Pure model for the issue-centric views: runs of one issue are grouped, the newest attempt is the issue's state.
// Every formatter returns null when the field has no data so a list renders nothing for it.
import { effectiveVerdict, type RunRow } from "../../api";
import { displayOutcome, type Outcome } from "../../display";
import { fmtUsd } from "../../format";

const DAY = 86_400_000;
export const PR_WINDOW_DAYS = 14;

export const stamp = (r: RunRow): number => { const t = Date.parse(r.started_at ?? r.last_event_at ?? ""); return Number.isNaN(t) ? -Infinity : t; };
export const runHref = (r: Pick<RunRow, "source_id" | "run_id">): string => `#/runs/${encodeURIComponent(r.source_id)}/${encodeURIComponent(r.run_id)}`;
export const verdictOf = (r: RunRow): string | null => (r.status === "running" || (!r.verdict && !r.ended_at) ? null : effectiveVerdict(r));
export const outcomeOf = (r: RunRow): Outcome => displayOutcome(verdictOf(r));
export const isRunning = (r: RunRow): boolean => verdictOf(r) === null;
const keyOf = (r: RunRow): string => (verdictOf(r) ?? "").trim().toUpperCase();
export const isBlocked = (r: RunRow): boolean => ["SPEC_CONFLICT", "BLOCKED"].includes(keyOf(r));
export const isPartial = (r: RunRow): boolean => keyOf(r) === "PARTIAL";
export const isVerifiedRun = (r: RunRow): boolean => keyOf(r) === "VERIFIED";
export const isFinished = (r: RunRow): boolean => !isRunning(r);

export interface IssueGroup {
  key: string;
  /** Issue or task title, else the issue ref. Never a run id. */
  title: string;
  repo: string | null;
  ref: string | null;
  attempts: RunRow[]; // newest first
  latest: RunRow;
}

const titleOf = (r: RunRow): string => r.title?.trim() || r.issue_ref || "Untitled task";

export function groupByIssue(runs: RunRow[]): IssueGroup[] {
  const m = new Map<string, RunRow[]>();
  for (const r of runs) {
    const k = r.issue_ref ? `${r.origin_repo ?? ""}|${r.issue_ref}` : `${r.source_id}/${r.run_id}`;
    m.set(k, [...(m.get(k) ?? []), r]);
  }
  const out: IssueGroup[] = [];
  for (const [key, list] of m) {
    const attempts = [...list].sort((a, b) => stamp(b) - stamp(a));
    const latest = attempts[0]!;
    const titled = attempts.find((a) => a.title?.trim());
    out.push({ key, title: titled ? titleOf(titled) : titleOf(latest), repo: latest.origin_repo, ref: latest.issue_ref, attempts, latest });
  }
  return out.sort((a, b) => stamp(b.latest) - stamp(a.latest));
}

/** "FireLater#17, 6 attempts, latest Failed" for a multi-attempt issue; null for a single run. */
export function groupSummary(g: IssueGroup): string | null {
  if (g.attempts.length < 2) return null;
  const name = g.ref ? (g.ref.includes("/") ? g.ref.split("/").slice(1).join("/") : g.ref) : g.title;
  return `${name}, ${g.attempts.length} attempts, latest ${outcomeOf(g.latest).label}`;
}

export function costOf(r: RunRow): string | null {
  if (typeof r.cost_usd === "number") return fmtUsd(r.cost_usd);
  return r.partial_usd ? `${fmtUsd(r.partial_usd)}+` : null;
}

export function durationOf(r: RunRow): string | null {
  const s = r.wall_s ?? r.elapsed_s;
  if (typeof s !== "number" || !Number.isFinite(s)) return null;
  if (s < 60) return `${Math.round(s)}s`;
  return s < 3600 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function whenOf(r: RunRow, now: number): string | null {
  const t = Date.parse(r.started_at ?? r.last_event_at ?? "");
  if (Number.isNaN(t)) return null;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export interface Kpis {
  runsWeek: number;
  finishedWeek: number;
  verifiedWeek: number;
  /** Null when no finished run this week. */
  verifiedShare: number | null;
  costWeek: number | null;
  costPartial: boolean;
  needsYou: number;
}

export interface Inbox { blocked: IssueGroup[]; partial: IssueGroup[]; prs: IssueGroup[] }

/** Needs-you buckets from each issue's latest attempt. A PR is listed while its latest attempt is inside PR_WINDOW_DAYS; the CP does not see merge state. */
export function inboxOf(groups: IssueGroup[], now: number): Inbox {
  const blocked = groups.filter((g) => isBlocked(g.latest));
  const partial = groups.filter((g) => isPartial(g.latest));
  const prs = groups.filter((g) => g.latest.pr_url && ["VERIFIED", "ALREADY_SATISFIED"].includes(keyOf(g.latest)) && now - stamp(g.latest) <= PR_WINDOW_DAYS * DAY);
  return { blocked, partial, prs };
}

export function kpisOf(runs: RunRow[], groups: IssueGroup[], now: number): Kpis {
  const week = runs.filter((r) => stamp(r) >= now - 7 * DAY);
  const fin = week.filter(isFinished);
  const ver = fin.filter(isVerifiedRun);
  const priced = week.filter((r) => typeof r.cost_usd === "number");
  const inbox = inboxOf(groups, now);
  return {
    runsWeek: week.length,
    finishedWeek: fin.length,
    verifiedWeek: ver.length,
    verifiedShare: fin.length ? ver.length / fin.length : null,
    costWeek: priced.length ? priced.reduce((a, r) => a + (r.cost_usd ?? 0), 0) : null,
    costPartial: priced.length < week.length,
    needsYou: inbox.blocked.length + inbox.partial.length + inbox.prs.length,
  };
}
