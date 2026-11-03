// ROUTER-1 R1-11: the implement stage's per-unit ladder, kept outside the engine10 line budget. Called only when routerActive()
// (flag on and no user model override); otherwise the implement stage runs exactly as with the router off.
import type { RunContext, SessionResult, SessionRunOptions } from "../../engine10/types.ts";
import { climb, type UnitEscalation } from "../model_rank.ts";
import { routeRecord } from "./unit_model.ts";
import { routerPreset } from "./flag.ts";
import { repoHistoryFloor } from "./history.ts";
import { REDO_CHALLENGE } from "../../util/conflict_resume.ts";

export interface UnitRoute { current: string; escalations: UnitEscalation[] }
const UNIT = "run";

/** Start model for the single "run" unit from the plan's route record; pins it on the first call and emits the route event. */
export function routeStart(ctx: RunContext, first: SessionRunOptions, plan: Record<string, unknown> | undefined, size?: string): UnitRoute {
  const rr = routeRecord(ctx.model, plan, () => repoHistoryFloor(ctx.repoDir), size);
  first.model = rr.model;
  ctx.emit("route", "implement", { unit: UNIT, model: rr.model, source: rr.source, reason: rr.reason });
  return { current: rr.model, escalations: [] };
}

/** Triggers b (LOKI_ESCALATE marker) and c (SPEC_CONFLICT, implement limit kill): redo the unit once on the next rung. Harness-owned errors never reach here.
 *  LOKI_ROUTER=auto also climbs one rung on an already-done claim that left no diff (`noDiff`): a cheap executor's "nothing to do" is weak evidence.
 *  That redo's brief carries REDO_CHALLENGE (reproduce the described defect first), so it is the claim's challenge at no extra session. */
export async function routeEscalate(ctx: RunContext, first: SessionRunOptions, session: SessionResult, rt: UnitRoute, ids: string[], noDiff: () => boolean = () => false): Promise<SessionResult> {
  const claim = !session.killed && session.markers.alreadyDone !== null && routerPreset() && noDiff();
  const trig = session.killed ? ("limit_kill" as const) : session.markers.escalate ? ("escalate_marker" as const) : session.markers.specConflict ? ("spec_conflict" as const) : claim ? ("already_done_claim" as const) : null;
  const esc = trig ? climb(UNIT, rt.current, trig, session.markers.escalate ?? session.markers.specConflict ?? (claim ? `already-done claim with no diff: ${session.markers.alreadyDone}` : "implement session limit kill")) : null;
  if (!esc) return session;
  rt.escalations.push(esc); rt.current = esc.to;
  ctx.emit("route.escalated", "implement", { ...esc });
  first.model = rt.current; first.iterationId = `${first.iterationId}-esc`; ids.push(first.iterationId);
  return ctx.sessions.run(trig === "already_done_claim" ? { ...first, brief: `${first.brief}\n\n${REDO_CHALLENGE}` } : first); // HONEST-ALREADY-DONE: the claim redo is also its challenge
}
