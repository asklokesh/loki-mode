// loki-ts/src/contrib/receipt_time.ts -- RECEIPT-TRUTH (FC-44): the receipt's time block and its self-consistency check.
// Every interval of the run is a named bucket (setup before the machine starts, each stage, orchestration gaps between
// stages, seal), so the buckets partition total_s. A parallel group is one bucket (the union of its members' intervals). A block that does not reconcile within 1% reads NOT RECORDED downstream (reconciledTotalS returns null), never a number.
import { readFileSync } from "node:fs";
import type { RunContext, StageName } from "../engine10/types.ts";

/** Overhead buckets, a stage name, or a parallel group joined with "+" (for example "plan+wall"). */
export type TimeBucket = string;
/** `stages` is a partition: its buckets are disjoint and sum to total_s, so any consumer may add them. A parallel group is ONE bucket holding the
 *  union of its members' intervals; each member's own seconds (overlap included, so they can add to more than the bucket) live in `stage_s`.
 *  wall_s is the sum of the stage buckets without setup, orchestration and seal, so it never exceeds total_s. */
export interface ReceiptTime { wall_s: number; total_s?: number; stages: Record<TimeBucket, number>; stage_s?: Record<string, number> }
export const RECONCILE_TOLERANCE = 0.01;
const OVERHEAD = new Set(["setup", "orchestration", "seal"]);
const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Epoch ms of the first event in events.jsonl (supervisor-written, so it precedes worker boot), or null when unreadable. */
export function firstEventMs(eventsPath: string): number | null {
  try {
    const first = readFileSync(eventsPath, "utf8").split("\n", 1)[0] ?? "";
    const t = Date.parse((JSON.parse(first) as { ts?: string }).ts ?? "");
    return Number.isFinite(t) ? t : null;
  } catch { return null; }
}

/** Build the time block. `fromOutputs` is the per-stage duration_s read from stage outputs, used when the machine kept no timeline. */
export function buildTime(ctx: RunContext, fromOutputs: Partial<Record<StageName, number>>, firstMs: number | null): ReceiptTime {
  const tl = ctx.timeline ?? [], nowMs = ctx.clock.now();
  const wallOf = (s: Record<string, number>): number => r3(Object.entries(s).reduce((a, [k, v]) => (OVERHEAD.has(k) ? a : a + v), 0));
  if (tl.length === 0 || firstMs === null || typeof ctx.startedAtMs !== "number") { // no timeline: the old stage-sum, and no total to reconcile it against
    const st = { ...fromOutputs } as Record<string, number>;
    return { wall_s: wallOf(st), stages: st };
  }
  const own: Record<string, number> = {};
  for (const e of tl) own[e.stage] = (own[e.stage] ?? 0) + (e.endMs - e.startMs) / 1000;
  const ev = [...tl].sort((a, b) => a.startMs - b.startMs);
  const stages: Record<string, number> = {};
  let busy = 0, cur: { names: string[]; s: number; e: number } | null = null;
  const flush = (): void => {
    if (!cur) return;
    const key = [...new Set(cur.names)].join("+");
    stages[key] = (stages[key] ?? 0) + (cur.e - cur.s) / 1000; busy += cur.e - cur.s;
  };
  for (const e of ev) {
    if (cur && e.startMs < cur.e) { cur.names.push(e.stage); cur.e = Math.max(cur.e, e.endMs); } // overlap: same parallel group
    else { flush(); cur = { names: [e.stage], s: e.startMs, e: e.endMs }; }
  }
  flush();
  const lastEnd = Math.max(...tl.map((e) => e.endMs));
  stages["setup"] = (ctx.startedAtMs - firstMs) / 1000;
  stages["orchestration"] = (lastEnd - ctx.startedAtMs - busy) / 1000;
  stages["seal"] = (nowMs - lastEnd) / 1000;
  for (const k of Object.keys(stages)) stages[k] = r3(stages[k]!);
  for (const k of Object.keys(own)) own[k] = r3(own[k]!);
  return { wall_s: wallOf(stages), total_s: r3((nowMs - firstMs) / 1000), stages, stage_s: own };
}

/** The receipt's total seconds, or null (NOT RECORDED) when it is absent or its buckets do not add up to it within 1%. */
export function reconciledTotalS(t: ReceiptTime | undefined): number | null {
  if (!t || typeof t.total_s !== "number" || !(t.total_s > 0) || !t.stages) return null;
  const vals = Object.values(t.stages);
  if (vals.some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0)) return null; // a negative or non-numeric bucket is a clock fault, not a partition
  const sum = vals.reduce((a, b) => a + b, 0);
  return Math.abs(sum - t.total_s) <= RECONCILE_TOLERANCE * t.total_s ? t.total_s : null;
}
