// ROUTER-1: every model decision the engine10 stages make under LOKI_ROUTER=1 lives here, outside the engine10 line budget.
// Invariant (L1, tested semantically in tests/engine10/route_matrix.test.ts): a session is never started below the run's model
// unless a VALID Opus route record (plan.units: every unit executor "haiku" with a reason, nothing NOT PROVEN) names haiku.
import { resolveModelAlias } from "../../engine10/sizing.ts";
import { PROVIDER_DEFAULT_MODEL } from "../../engine10/session.ts";
import { envOverride, unitRedo } from "./decision.ts";
import { routerEnabled } from "./flag.ts";
import { climb, modelRank, type UnitEscalation } from "../model_rank.ts";

export type StageOutputs = Partial<Record<string, Record<string, unknown> | undefined>>;
export interface RouteRecord { model: string; source: string; reason: string; valid: boolean }

const isHaiku = (m: string): boolean => resolveModelAlias(m).toLowerCase().includes("haiku");
/** The model a LOKI_ROUTER=1 run floors at: the run's model, or sonnet when the run model is only the provider-default label. */
export const runFloor = (runModel: string): string => (runModel === PROVIDER_DEFAULT_MODEL ? resolveModelAlias("sonnet") : runModel);

/** A valid Opus route record: plan.units non-empty, nothing NOT PROVEN, every unit routed to haiku with a reason (R1-10 parseUnits output). */
export function validHaikuRoute(plan: Record<string, unknown> | undefined): { reason: string } | null {
  const units = plan?.["units"], np = plan?.["route_not_proven"];
  if (!Array.isArray(units) || units.length === 0 || (Array.isArray(np) && np.length > 0)) return null;
  for (const u of units) {
    const r = (typeof u === "object" && u !== null ? u : {}) as Record<string, unknown>;
    if (r["executor"] !== "haiku" || typeof r["id"] !== "string" || r["id"] === "" || typeof r["reason"] !== "string" || r["reason"].trim() === "" || r["reason"] === "invalid unit route") return null;
  }
  return { reason: String((units[0] as Record<string, unknown>)["reason"]) };
}

/** The ONE user-bypass check: LOKI_MODEL_OVERRIDE or LOKI_CLAUDE_MODEL_DEVELOPMENT set means no router pin applies on any path (implement, fix, redo, escalation, session). */
export const routerPinsAllowed = (env: Record<string, string | undefined> = process.env): boolean => envOverride(env) === null;

/** The router acts on model choice only when the flag is on and no user model override is set; otherwise a stage behaves exactly as with the router off. */
export const routerActive = (env: Record<string, string | undefined> = process.env): boolean => routerEnabled(env) && routerPinsAllowed(env);

/** The route record for the single "run" unit: haiku only with a valid record, otherwise the run floor. Callers gate on routerActive(). */
export function routeRecord(runModel: string, plan: Record<string, unknown> | undefined): RouteRecord {
  const v = validHaikuRoute(plan);
  return v ? { model: resolveModelAlias("haiku"), source: "opus-plan", reason: v.reason, valid: true } : { model: runFloor(runModel), source: "default", reason: "no valid haiku route record", valid: false };
}

/** The fix-round model under the router, or the stall escalation decision (stall: true). Climbs only on code-owned evidence; a lint-only or harness-owned failure never does. */
export function routedFix(runModel: string, out: StageOutputs, o: { repeated: boolean; stall: boolean; groups: readonly { signature: string }[]; reason: string }): { pin: string | undefined; climbed: UnitEscalation | null } {
  const rec = routeRecord(runModel, out["plan"]);
  const carried = String(out["fix"]?.["model"] ?? out["implement"]?.["route_model"] ?? rec.model);
  const floor = runFloor(runModel);
  const cur = !rec.valid && modelRank(carried) < modelRank(floor) ? floor : carried; // a below-run model carries only with a valid route record
  const tests = o.groups.filter((g) => !g.signature.startsWith("lint:") && g.signature !== "select-tests").length;
  const redo = unitRedo(isHaiku(cur) ? "haiku" : "sonnet", tests > 0 ? "code" : "harness") === "redo-sonnet"; // B4: a haiku unit with a code-owned failure is redone on sonnet
  const climbed = tests > 0 && (o.repeated || o.stall || redo) ? climb("run", cur, o.stall ? "stall" : "code_fail", o.reason) : null;
  return { pin: climbed?.to ?? (cur !== runModel ? cur : undefined), climbed };
}

/** R1-13: a verify stall may climb once, only on a code-owned failure and only when the router is active (a lint-only or harness-owned stall, or a user override, is unchanged). The same routedFix decides here and in the fix stage. */
export function stallClimb(runModel: string, out: StageOutputs, reason: string): UnitEscalation | null {
  if (!routerActive() || out["fix"]?.["stall_escalated"]) return null;
  const groups = (out["verify"]?.["failures_grouped"] as { signature: string }[] | undefined) ?? [];
  return routedFix(runModel, out, { repeated: false, stall: true, groups, reason }).climbed;
}

/** R1-09 floor for a per-call pin: with the advisor unavailable a haiku pin is raised to sonnet (section 4.4). */
export const floorNoAdvisor = (model: string | undefined, advisor: { available: boolean } | undefined): string | undefined => (model && advisor?.available === false && isHaiku(model) ? resolveModelAlias("sonnet") : model);
