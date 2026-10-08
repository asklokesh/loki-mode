// FC-34: the ONE route record. The plan stage writes it (<runDir>/route.json and its stage output); the start line, the
// receipt route block and the PR line are all derived from it, so what is advertised is what is recorded (L7). Pure
// builders plus two tiny file helpers; no task-wording or path logic (L0).
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UnitRoute } from "./decision.ts";

export const ROUTE_RECORD_FILE = "route.json";
/** Per-unit executors are recorded at plan time but implement/fix do not read them yet (R1-11), so every stage runs the run model. Flip with R1-11. */
export const PER_UNIT_EXECUTORS_APPLIED = false;

export interface RouteRecordInput {
  units: readonly UnitRoute[];
  notProven: readonly string[];
  /** Model the plan session ran on ("opus", "sonnet" after an Opus failure, an override, or "provider default"). */
  planModel: string;
  /** Why the plan model is not Opus, or null when it is. */
  planModelNote: string | null;
  shapeKey: string | null;
  /** Set when no plan session ran (plan disabled): the record says why nothing routed. */
  skipReason?: string | null;
}

/** Record in the shape buildRouteBlock reads. Always emitted while the router is on: a route, or the reason there is none. */
export function buildRouteRecord(i: RouteRecordInput): Record<string, unknown> {
  const notProven = [...i.notProven, ...(i.planModelNote ? [`plan model: NOT PROVEN (owner provider): ${i.planModelNote}`] : [])];
  const base = { plan_model: i.planModel, shape_key: i.shapeKey, route_not_proven: notProven, applied: PER_UNIT_EXECUTORS_APPLIED };
  if (i.units.length === 0) {
    const why = i.skipReason ?? i.notProven[0] ?? "no per-unit routes returned";
    return { ...base, routed: false, executor: "sonnet", source: "default", reason: `no plan route (NOT PROVEN): ${why}`, units: [] };
  }
  const execs = [...new Set(i.units.map((u) => u.executor))];
  return {
    ...base, routed: true, executor: execs.length === 1 ? execs[0] : "mixed", source: "opus",
    reason: `Opus routed ${i.units.length} unit(s) at plan time`,
    units: i.units.map((u) => ({ id: u.id, executor: u.executor, reason: u.reason, assigned_by: "opus" })),
  };
}

export function writeRouteRecord(runDir: string, record: Record<string, unknown>): void {
  try { mkdirSync(runDir, { recursive: true }); writeFileSync(join(runDir, ROUTE_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`); } catch { /* the stage output still carries the record */ }
}

/** Read back a record; undefined when missing, not a regular file, or malformed (never a throw). */
export function loadRouteRecord(runDir: string): Record<string, unknown> | undefined {
  try {
    const p = join(runDir, ROUTE_RECORD_FILE);
    if (!existsSync(p) || !lstatSync(p).isFile()) return undefined;
    const v: unknown = JSON.parse(readFileSync(p, "utf8"));
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch { return undefined; }
}
