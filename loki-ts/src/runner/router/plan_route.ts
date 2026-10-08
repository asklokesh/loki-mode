// ROUTER-1 R1-10: plan-stage routing helpers, outside the engine10 line budget. Flag off: nothing here adds a key, a probe, a pin or a file.
import { MAX_SCOPE_BYTES, PLAN_SCOPE_FILE, readScopeText } from "../../util/run_cap.ts";
import { claudeCodeVersionForRoute } from "../providers.ts";
import { envOverride, parseUnits } from "./decision.ts";
import { probeAdvisor } from "./advisor_probe.ts";
import { routerEnabled } from "./flag.ts";
import { buildRouteRecord, writeRouteRecord } from "./route_record.ts";
import { shapeKeyForRun } from "./history.ts";

// R1-10: Opus is the router. The model picks each unit's executor; the harness only validates the schema (L0).
export const ROUTER_UNITS_INSTRUCTION = 'In the same JSON file (<scope>) also add "units": [{"id":"<unit id>","kind":"<short kind>","executor":"sonnet"|"haiku","reason":"<=200 chars"}], one entry per work unit of your plan. The default executor is sonnet. Assign haiku to a unit only when you judge it safe for that unit and say why in reason. Give the Wall acceptance-test unit the id "wall".';

type Pin = { model: string } | Record<string, never>;
export interface PlanRoute {
  routed: boolean;
  pinOpus: boolean;
  pin: Pin;
  pinFor: (onSonnet: boolean) => Pin;
  planModel: (fastModel: string) => string;
  units: () => Record<string, unknown>;
  record: (o: { planModel: string; planModelNote?: string | null; skipReason?: string }) => Record<string, unknown> | null;
}
const SONNET_PIN: Pin = { model: "sonnet" };

/**
 * routed: the flag. pinFor(onSonnet): FC-35 Opus is the router, so the router-on plan session runs on Opus (claude only, never over the
 * user's model bypass) and Sonnet only after the Opus session failed. units(): the parsed per-unit route stored on the plan output.
 * record(): writes <runDir>/route.json, the one route record the start line, receipt and PR line read.
 */
export async function planRoute(runDir: string, provider: string, env: NodeJS.ProcessEnv = process.env, repoDir = ""): Promise<PlanRoute> {
  const routed = routerEnabled(env);
  const advisorAvailable = routed ? probeAdvisor(env, provider, await claudeCodeVersionForRoute(env), runDir).available : false;
  const pinOpus = routed && provider === "claude" && envOverride(env) === null;
  const shapeKey = routed ? shapeKeyForRun(repoDir, runDir) : null;
  let cached: { units: ReturnType<typeof parseUnits>["units"]; notProven: string[] } | null = null;
  const parse = () => {
    if (cached) return cached;
    const rd = readScopeText(runDir);
    const scope: string | null = rd.status === "ok" ? rd.text : null;
    const bad: string | null = rd.status === "not_file" ? `NOT PROVEN (owner model): ${PLAN_SCOPE_FILE} is not a regular file; default sonnet`
      : rd.status === "too_big" ? `NOT PROVEN (owner model): ${PLAN_SCOPE_FILE} exceeds ${MAX_SCOPE_BYTES} bytes; default sonnet` : null;
    cached = bad ? { units: [], notProven: [bad] } : parseUnits(scope, advisorAvailable);
    return cached;
  };
  const out: PlanRoute = {
    routed,
    pinOpus,
    pin: pinOpus ? { model: "opus" } : {},
    pinFor: (onSonnet) => (onSonnet ? SONNET_PIN : out.pin),
    planModel: (fastModel) => (pinOpus ? "opus" : provider === "claude" ? fastModel : "provider default"),
    units: () => {
      if (!routed) return {};
      const parsed = parse();
      return { units: parsed.units, route_not_proven: parsed.notProven };
    },
    record: (o) => {
      if (!routed) return null;
      const parsed = o.skipReason ? { units: [], notProven: [] as string[] } : parse();
      const rec = buildRouteRecord({ units: parsed.units, notProven: parsed.notProven, planModel: o.planModel, planModelNote: o.planModelNote ?? null, shapeKey, skipReason: o.skipReason });
      writeRouteRecord(runDir, rec);
      return rec;
    },
  };
  return out;
}
