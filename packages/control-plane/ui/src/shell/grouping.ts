// Session list grouping: Today, Yesterday, Earlier by the viewer's local calendar day.
import type { RunRow } from "../api";

export type GroupName = "Today" | "Yesterday" | "Earlier";
export interface RunGroup { name: GroupName; runs: RunRow[] }

const stamp = (r: RunRow): number => Date.parse(r.started_at ?? r.last_event_at ?? "");

const dayStart = (ms: number): number => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** Newest first inside each group. A run with no usable timestamp is Earlier. Empty groups are omitted. */
export function groupRuns(runs: RunRow[], now: number): RunGroup[] {
  const today = dayStart(now);
  const yesterday = dayStart(today - 1);
  const buckets: Record<GroupName, RunRow[]> = { Today: [], Yesterday: [], Earlier: [] };
  for (const r of runs) {
    const t = stamp(r);
    const g: GroupName = Number.isNaN(t) ? "Earlier" : t >= today ? "Today" : t >= yesterday ? "Yesterday" : "Earlier";
    buckets[g].push(r);
  }
  const key = (r: RunRow) => { const t = stamp(r); return Number.isNaN(t) ? -Infinity : t; };
  const out: RunGroup[] = [];
  for (const name of ["Today", "Yesterday", "Earlier"] as const) {
    if (buckets[name].length) out.push({ name, runs: buckets[name].sort((a, b) => key(b) - key(a)) });
  }
  return out;
}
