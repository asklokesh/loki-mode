// Pure filter, sort and rollup logic for the runs table. No fetching, no DOM.
import type { RunRow } from "../../api";
import { effectiveVerdict, isVerified } from "../../design/primitives";

export type SortKey = "started" | "repo" | "source" | "status" | "verdict" | "cost" | "elapsed";
export interface Filters { status: string; verdict: string; repo: string; source: string; q: string }
export const NO_FILTERS: Filters = { status: "", verdict: "", repo: "", source: "", q: "" };

export const NO_REPO = "no repo";
export const repoOf = (r: RunRow): string => r.origin_repo ?? NO_REPO;
export const statusOf = (r: RunRow): "running" | "completed" => r.status ?? (r.verdict ? "completed" : "running");
export const sourceOf = (r: RunRow): string => r.task_source ?? r.source_id;
export const verdictOf = (r: RunRow): string => effectiveVerdict(r) ?? "none";

export function applyFilters(rows: RunRow[], f: Filters): RunRow[] {
  const q = f.q.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.status && statusOf(r) !== f.status) return false;
    if (f.verdict && verdictOf(r) !== f.verdict) return false;
    if (f.repo && repoOf(r) !== f.repo) return false;
    if (f.source && sourceOf(r) !== f.source) return false;
    if (q && ![r.run_id, r.source_id, r.origin_repo, r.issue_ref, r.provider, r.model, effectiveVerdict(r)].some((v) => v && v.toLowerCase().includes(q))) return false;
    return true;
  });
}

const val = (r: RunRow, k: SortKey): string | number | null => {
  switch (k) {
    case "started": return r.started_at ? Date.parse(r.started_at) : null;
    case "repo": return repoOf(r);
    case "source": return sourceOf(r);
    case "status": return statusOf(r);
    case "verdict": return effectiveVerdict(r);
    case "cost": return r.cost_usd;
    case "elapsed": return r.elapsed_s ?? r.wall_s;
  }
};

/** Unmeasured values (null) sort last in either direction. */
export function sortRows(rows: RunRow[], key: SortKey, dir: "asc" | "desc"): RunRow[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = val(a, key), y = val(b, key);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return c * sign;
  });
}

export interface Rollup { repo: string; runs: number; running: number; verified: number; cost: number | null; unpriced: number }

/** Per-repo rollup. cost sums only priced runs; it is null when none were priced. */
export function rollupByRepo(rows: RunRow[]): Rollup[] {
  const m = new Map<string, Rollup>();
  for (const r of rows) {
    const k = repoOf(r);
    const g = m.get(k) ?? { repo: k, runs: 0, running: 0, verified: 0, cost: null, unpriced: 0 };
    g.runs++;
    if (statusOf(r) === "running") g.running++;
    if (isVerified(r)) g.verified++;
    if (r.cost_usd === null) g.unpriced++; else g.cost = (g.cost ?? 0) + r.cost_usd;
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => b.runs - a.runs || a.repo.localeCompare(b.repo));
}

export const distinct = (vals: string[]): string[] => [...new Set(vals)].sort();
