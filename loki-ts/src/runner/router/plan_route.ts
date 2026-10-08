// ROUTER-1 R1-10: plan-stage routing helpers, outside the engine10 line budget. Flag off: nothing here adds a key, a probe or a pin.
import { MAX_SCOPE_BYTES, PLAN_SCOPE_FILE, readScopeText } from "../../util/run_cap.ts";
import { claudeCodeVersionForRoute } from "../providers.ts";
import { envOverride, parseUnits } from "./decision.ts";
import { probeAdvisor } from "./advisor_probe.ts";
import { routerEnabled } from "./flag.ts";

// R1-10: Opus is the router. The model picks each unit's executor; the harness only validates the schema (L0).
export const ROUTER_UNITS_INSTRUCTION = 'In the same JSON file (<scope>) also add "units": [{"id":"<unit id>","kind":"<short kind>","executor":"sonnet"|"haiku","reason":"<=200 chars"}], one entry per work unit of your plan. The default executor is sonnet. Assign haiku to a unit only when you judge it safe for that unit and say why in reason. Give the Wall acceptance-test unit the id "wall".';

/** routed: the flag; pin: Opus plans itself when the advisor is unavailable (claude provider only, never over a user model bypass); units(): the parsed per-unit route record stored on the plan output. */
export async function planRoute(runDir: string, provider: string, env: NodeJS.ProcessEnv = process.env): Promise<{ routed: boolean; pin: { model: string } | Record<string, never>; units: () => Record<string, unknown> }> {
  const routed = routerEnabled(env);
  const advisorAvailable = routed ? probeAdvisor(env, provider, await claudeCodeVersionForRoute(env), runDir).available : false;
  const pinOpus = routed && !advisorAvailable && provider === "claude" && envOverride(env) === null;
  return {
    routed,
    pin: pinOpus ? { model: "opus" } : {},
    units: () => {
      if (!routed) return {};
      const rd = readScopeText(runDir);
      const scope: string | null = rd.status === "ok" ? rd.text : null;
      const bad: string | null = rd.status === "not_file" ? `NOT PROVEN (owner model): ${PLAN_SCOPE_FILE} is not a regular file; default sonnet`
        : rd.status === "too_big" ? `NOT PROVEN (owner model): ${PLAN_SCOPE_FILE} exceeds ${MAX_SCOPE_BYTES} bytes; default sonnet` : null;
      if (bad) return { units: [], route_not_proven: [bad] };
      const parsed = parseUnits(scope, advisorAvailable);
      return { units: parsed.units, route_not_proven: parsed.notProven };
    },
  };
}
