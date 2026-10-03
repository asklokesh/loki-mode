// Pure helpers for the session card grid. Every line is built from fields the API returned; a missing field reads "unmeasured".
import type { RunRow } from "../../api";
import { effectiveVerdict } from "../../api";
import { fmtUsd } from "../../format";
import { UNMEASURED, elapsedLabel } from "../run/model";

const stamp = (r: RunRow): number => Date.parse(r.started_at ?? r.last_event_at ?? "");
export const runKey = (r: Pick<RunRow, "source_id" | "run_id">): string => `${r.source_id}/${r.run_id}`;
export const cardTitle = (r: RunRow): string => r.title ?? r.issue_ref ?? r.run_id;
export const cardRepo = (r: RunRow): string => r.origin_repo ?? `repo ${UNMEASURED}`;

export function timeAgo(iso: string | null | undefined, now: number): string {
  const t = Date.parse(iso ?? "");
  if (Number.isNaN(t)) return `time ${UNMEASURED}`;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

const cost = (r: RunRow): string => (r.cost_usd !== null && r.cost_usd !== undefined ? fmtUsd(r.cost_usd) : r.partial_usd ? `at least ${fmtUsd(r.partial_usd)}` : `cost ${UNMEASURED}`);
// An empty list means no diff was recorded, which is a gap, not zero files changed.
const files = (r: RunRow): string => (Array.isArray(r.files_touched) && r.files_touched.length > 0 ? `${r.files_touched!.length} file${r.files_touched!.length === 1 ? "" : "s"} touched` : `files ${UNMEASURED}`);

/** Two plain-English lines for a card. A blocked run quotes the question when the caller has it. */
export function outcome(r: RunRow, blockedQuestion?: string | null): [string, string] {
  if (blockedQuestion !== undefined) return [`Blocked: needs answer. ${blockedQuestion ?? `question ${UNMEASURED}`}`, `${cardRepo(r)}, waiting since ${timeAgo(r.last_event_at ?? r.started_at, Date.now())}`];
  const v = effectiveVerdict(r);
  if (v === null) return [`Running: stage ${r.current_stage ?? UNMEASURED}`, `${elapsedLabel(r.elapsed_s)} so far, ${files(r)}`];
  const tail = `${files(r)}, ${cost(r)}, ${elapsedLabel(r.wall_s)}`;
  const head: Record<string, string> = {
    VERIFIED: "Done: the change was verified.",
    ALREADY_SATISFIED: "Done: already satisfied, nothing to change.",
    PARTIAL: "Partly done: some checks are not proven.",
    FAILED: "Failed: the run did not pass verification.",
    SPEC_CONFLICT: "Blocked: the spec conflicts, needs an answer.",
    TAMPERED: "Not trusted: the receipt failed its integrity check.",
    UNVERIFIED: "Done, but not verified: no attested receipt.",
  };
  return [head[v] ?? (v.startsWith("VERIFIED") ? "Done: verified, signature not checked." : `Finished: ${v}`), tail];
}

export type Filter = "all" | "running" | "VERIFIED" | "PARTIAL" | "FAILED" | "TAMPERED";
export const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" }, { value: "running", label: "Running" }, { value: "VERIFIED", label: "Verified" },
  { value: "PARTIAL", label: "Partial" }, { value: "FAILED", label: "Failed" }, { value: "TAMPERED", label: "Tampered" },
];

export function matches(r: RunRow, q: string, f: Filter): boolean {
  const v = effectiveVerdict(r);
  if (f === "running" && v !== null) return false;
  if (f !== "all" && f !== "running" && v !== f) return false;
  const n = q.trim().toLowerCase();
  if (!n) return true;
  return [cardTitle(r), r.origin_repo, r.issue_ref, r.run_id, r.provider, r.model].some((x) => (x ?? "").toLowerCase().includes(n));
}

/** Newest first; a run with no usable timestamp sorts last. */
export function newestFirst(runs: RunRow[]): RunRow[] {
  const k = (r: RunRow) => { const t = stamp(r); return Number.isNaN(t) ? -Infinity : t; };
  return [...runs].sort((a, b) => k(b) - k(a));
}

/** Groups tab: one group per repo, groups ordered by their newest run. A run without a repo goes under "repo unmeasured". */
export function groupByRepo(runs: RunRow[]): { repo: string; runs: RunRow[] }[] {
  const m = new Map<string, RunRow[]>();
  for (const r of newestFirst(runs)) { const k = cardRepo(r); m.set(k, [...(m.get(k) ?? []), r]); }
  return [...m].map(([repo, rs]) => ({ repo, runs: rs }));
}
