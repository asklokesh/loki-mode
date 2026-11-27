// Pure view logic for the work views: which bucket a run is in, its chip, its stage bar and the weekly spend table. No fetches, no React.
import { effectiveVerdict, type RunRow } from "../api";

export type View = "needs" | "running" | "delivered" | "all" | "spend" | "setup";
export const VIEWS: Record<"needs" | "running" | "delivered" | "all", [string, string]> = {
  needs: ["Needs you", "Decisions waiting on you"],
  running: ["Running", "Work in progress"],
  delivered: ["Delivered", "Finished, stopped or handed back"],
  all: ["All work", "Every run Loki has recorded"],
};
export const TITLES: Record<View, string> = { needs: "Needs you", running: "Running", delivered: "Delivered", all: "All work", spend: "Spend", setup: "Defaults" };

export const STAGES = ["Preflight", "Contract", "Build", "Verify", "Deliver"] as const;
/** The one table that maps engine stage names onto the five shown stages. A name not listed folds into the stage before it. */
export const STAGE_MAP: Record<string, number> = {
  start: 0, boot: 0, intake: 0, already_done: 0, preflight: 0,
  plan: 1, planned: 1, spec_interrogation: 1, contract: 1,
  implement: 2, fix: 2, agent: 2,
  prove: 3, verify: 3, review: 3, test_suite: 3, code_review: 3, wall: 3,
  commit: 4, seal: 4, pr: 4, teardown: 4,
};
export function stageIndex(name: string | null | undefined, prev = 0): number {
  if (!name) return prev;
  const i = STAGE_MAP[name.toLowerCase()];
  return i === undefined ? prev : i;
}
/** The stage a run is in, or stopped at: the furthest mapped stage among those it recorded and its current one. */
export function stageNow(stages: { stage: string }[], current: string | null | undefined): number {
  let at = 0;
  for (const s of stages) at = Math.max(at, stageIndex(s.stage, at));
  return current ? Math.max(at, stageIndex(current, at)) : at;
}

export type Tone = "ok" | "warn" | "bad" | "run" | "idle";
export const isRunning = (r: Pick<RunRow, "status" | "verdict">): boolean => r.status === "running" || r.verdict === null;
export const verdictOf = (r: RunRow): string | null => r.effective_verdict ?? effectiveVerdict(r);
const up = (r: RunRow): string => String(verdictOf(r) ?? "").toUpperCase();

export function tone(r: RunRow): Tone {
  if (isRunning(r)) return "run";
  const v = up(r);
  if (v === "VERIFIED") return "ok";
  if (/^(PARTIAL|SPEC_CONFLICT|UNVERIFIED)/.test(v) || v.includes("NOT CHECKED") || v.includes("UNATTESTED")) return "warn";
  if (/^(FAILED|TAMPERED)/.test(v)) return "bad";
  return "idle";
}

export const chipText = (r: RunRow): string => (isRunning(r) ? (r.current_stage ?? "working") : String(verdictOf(r) ?? "")).toUpperCase().replace(/_/g, " ");

const NEEDS_VERDICT = /^(PARTIAL|FAILED|SPEC_CONFLICT|UNVERIFIED|TAMPERED)/;
export const runKey = (r: Pick<RunRow, "source_id" | "run_id">): string => `${r.source_id}/${r.run_id}`;

export type Bucket = "needs" | "running" | "delivered";
/** blocked: runs known to hold a question for the person; seen: runs the person dismissed from Needs you. */
export function bucket(r: RunRow, blocked: ReadonlySet<string>, seen: ReadonlySet<string>): Bucket {
  const k = runKey(r);
  if (blocked.has(k)) return "needs";
  if (isRunning(r)) return "running";
  if (seen.has(k)) return "delivered";
  const v = up(r);
  if (NEEDS_VERDICT.test(v)) return "needs";
  if (v === "VERIFIED" && r.pr_url) return "needs";
  return "delivered";
}

export const money = (r: Pick<RunRow, "cost_usd" | "partial_usd">): string =>
  typeof r.cost_usd === "number" ? `$${r.cost_usd.toFixed(2)}` : typeof r.partial_usd === "number" && r.partial_usd > 0 ? `$${r.partial_usd.toFixed(2)}+` : "unpriced";

export const ago = (iso: string | null | undefined, now = Date.now()): string => {
  if (!iso) return "";
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};
export const duration = (s: number | null | undefined): string => {
  if (typeof s !== "number" || !Number.isFinite(s)) return "";
  const m = Math.floor(s / 60), sec = Math.round(s % 60);
  return m ? `${m}m ${String(sec).padStart(2, "0")}s` : `${sec}s`;
};
export const runTitle = (r: Pick<RunRow, "title" | "issue_ref" | "run_id">): string => r.title || r.issue_ref || r.run_id;
export const repoName = (r: Pick<RunRow, "origin_repo" | "issue_ref">): string =>
  r.origin_repo ?? (r.issue_ref && /^[^/\s]+\/[^#\s]+#\d+$/.test(r.issue_ref) ? r.issue_ref.split("#")[0]! : "unknown");

export interface Week { label: string; start: number; runs: number; verified: number; partial: number; failed: number; usd: number; unpriced: number }
/** Runs grouped by local calendar week (Monday start), newest first. usd sums fully priced runs only; unpriced runs are counted apart, never as $0. */
export function weekly(rows: RunRow[], now = Date.now()): Week[] {
  const start = (t: number): number => { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
  const cur = start(now), by = new Map<number, Week>();
  for (const r of rows) {
    const t = r.started_at ? Date.parse(r.started_at) : NaN;
    if (!Number.isFinite(t)) continue;
    const s = start(t);
    let w = by.get(s);
    if (!w) {
      const n = Math.round((cur - s) / (7 * 86400000));
      w = { label: n <= 0 ? "This week" : n === 1 ? "Last week" : `${n} weeks ago`, start: s, runs: 0, verified: 0, partial: 0, failed: 0, usd: 0, unpriced: 0 };
      by.set(s, w);
    }
    w.runs++;
    if (!isRunning(r)) {
      const v = up(r);
      if (v === "VERIFIED") w.verified++; else if (v.startsWith("PARTIAL")) w.partial++; else if (/^(FAILED|TAMPERED)/.test(v)) w.failed++;
    }
    if (typeof r.cost_usd === "number") w.usd += r.cost_usd; else w.unpriced++;
  }
  return [...by.values()].sort((a, b) => b.start - a.start);
}
