// D61 slice 14: group events and the terminal unit table. Pure rendering plus a small renderer: on a TTY the
// table repaints in place every 2s, otherwise one plain line is printed per unit status change. Single-run
// output never touches this module. Group events: group.started {group_id, units:[{unit_id, deps}]} and
// group.unit {group_id, unit_id, status, stage, elapsed_s}.
import type { EventEnvelope } from "../../engine10/types.ts";
import { formatDuration } from "../../engine10/output.ts";

export type UnitStatus = "pending" | "running" | "done" | "failed" | "blocked";
export interface UnitRow { id: string; deps: string[]; status: UnitStatus; stage: string; elapsedS: number }

const strs = (x: unknown): string[] => (Array.isArray(x) ? x.filter((d): d is string => typeof d === "string") : []);

/** Folds group.started and group.unit events into one row per unit (declared order, then first-seen order). */
export function foldGroup(events: EventEnvelope[]): UnitRow[] {
  const rows = new Map<string, UnitRow>();
  const row = (id: string): UnitRow => {
    let r = rows.get(id);
    if (!r) rows.set(id, (r = { id, deps: [], status: "pending", stage: "-", elapsedS: 0 }));
    return r;
  };
  for (const e of events) {
    if (e.type === "group.started" && Array.isArray(e.data.units)) {
      for (const u of e.data.units as Record<string, unknown>[]) if (typeof u?.unit_id === "string") row(u.unit_id).deps = strs(u.deps);
    } else if (e.type === "group.unit" && typeof e.data.unit_id === "string") {
      const r = row(e.data.unit_id);
      if (typeof e.data.status === "string") r.status = e.data.status as UnitStatus;
      if (typeof e.data.stage === "string") r.stage = e.data.stage;
      if (typeof e.data.elapsed_s === "number") r.elapsedS = e.data.elapsed_s;
    }
  }
  return [...rows.values()];
}

/** `unit u1 done seal 2m05s` */
export const formatUnitLine = (u: UnitRow): string => `unit ${u.id} ${u.status} ${u.stage} ${formatDuration(u.elapsedS)}`;

/** Fixed-column table, no trailing newline. Column width is the longest cell plus 2, never below the minimum. */
export function formatUnitTable(units: UnitRow[]): string {
  const cells = [["UNIT", "STATUS", "STAGE", "TIME", "DEPS"], ...units.map((u) => [u.id, u.status, u.stage, formatDuration(u.elapsedS), u.deps.join(",") || "-"])];
  const mins = [6, 9, 8, 7];
  const w = mins.map((m, i) => Math.max(m, ...cells.map((c) => c[i]!.length + 2)));
  return cells.map((c) => c.map((s, i) => (i < 4 ? s.padEnd(w[i]!) : s)).join("")).join("\n");
}

export interface GroupRendererOpts {
  write: (s: string) => void;
  isTTY: boolean;
  intervalMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export function createGroupRenderer(o: GroupRendererOpts) {
  const setT = o.setTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearT = o.clearTimer ?? ((t) => clearInterval(t as ReturnType<typeof setInterval>));
  let units: UnitRow[] = [];
  let timer: unknown = null;
  let painted = 0;
  const seen = new Map<string, string>();
  const paint = (): void => {
    if (units.length === 0) return;
    const table = formatUnitTable(units);
    o.write((painted ? `\x1b[${painted}A\x1b[J` : "") + table + "\n");
    painted = units.length + 1;
  };
  return {
    update(next: UnitRow[]): void {
      units = next;
      if (o.isTTY) return;
      for (const u of next) {
        const key = `${u.status}|${u.stage}`;
        if (seen.get(u.id) !== key) { seen.set(u.id, key); o.write(formatUnitLine(u) + "\n"); }
      }
    },
    start(): void {
      if (o.isTTY && timer === null) timer = setT(paint, o.intervalMs ?? 2000);
    },
    stop(): void {
      if (timer !== null) { clearT(timer); timer = null; paint(); }
    },
  };
}
