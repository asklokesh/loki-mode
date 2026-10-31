// EL-W0-06 (D86, FC-04, L1/L7): every model pin weaker than the run's default is a downgrade. They are printed on the
// engine10 start line and recorded on run.started (key only when non-empty, so receipt hashes stay stable).
import { cascadeEnabled, cascadeImplementModel, planMode, resolveModelAlias, wallEnabled, wallModel } from "../engine10/sizing.ts";
import { cascadeDowngrade, haikuFirstEnabled } from "./model_rank.ts";
import { PROVIDER_DEFAULT_MODEL } from "../util/claude_model.ts";
import { routerEnabled } from "./router/flag.ts"; import { leanEnabled, routerActive } from "./router/unit_model.ts"; import { envOverride } from "./router/decision.ts"; // FC-35: with the router on the plan session is pinned to Opus, so "plan sonnet (fast tier)" is not a downgrade
export interface ModelDowngrade { stage: string; model: string; reason: string }
const weak = (m: string | undefined): m is string => !!m && /sonnet|haiku/i.test(m);
/** Model the plan session's fast tier resolves to (mirrors session.ts childEnv: only LOKI_MODEL_OVERRIDE rewrites the tier). */
export function fastTierModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.LOKI_MODEL_OVERRIDE || env.LOKI_CLAUDE_MODEL_FAST || env.LOKI_MODEL_FAST || (env.LOKI_ALLOW_HAIKU === "true" ? "haiku" : "sonnet");
}
export function modelDowngrades(provider: string, env: NodeJS.ProcessEnv = process.env, runModel: string = env.LOKI_CLAUDE_MODEL_DEVELOPMENT || env.LOKI_MODEL_DEVELOPMENT || PROVIDER_DEFAULT_MODEL): ModelDowngrade[] {
  if (provider !== "claude") return [];
  if (weak(env.LOKI_MODEL_OVERRIDE)) return [{ stage: "all", model: env.LOKI_MODEL_OVERRIDE, reason: "LOKI_MODEL_OVERRIDE" }];
  const devName = env.LOKI_CLAUDE_MODEL_DEVELOPMENT ? "LOKI_CLAUDE_MODEL_DEVELOPMENT" : "LOKI_MODEL_DEVELOPMENT";
  if (weak(env[devName])) return [{ stage: "implement", model: env[devName]!, reason: devName }]; // the run itself is weak: auxiliaries are not weaker
  const out: ModelDowngrade[] = [];
  if (cascadeEnabled(env)) out.push({ stage: "implement,fix", model: cascadeImplementModel(env), reason: "LOKI_E10_CASCADE opt-in" });
  if (haikuFirstEnabled(env)) { // TEN-COST-16: same precedence as implement.ts (router, then cascade, then haiku-first); an overridden opt-in is named, never silent
    if (routerEnabled(env)) out.push({ stage: "implement", model: "router-chosen", reason: "LOKI_IMPLEMENT_HAIKU_FIRST overridden by the router" });
    else if (cascadeDowngrade(runModel, env)) out.push({ stage: "implement", model: cascadeImplementModel(env), reason: "LOKI_IMPLEMENT_HAIKU_FIRST overridden by LOKI_E10_CASCADE" }); // only when the cascade really pins (implement.ts: cascadeDowngrade ?? haikuFirstDowngrade)
    else out.push({ stage: "implement", model: resolveModelAlias("haiku"), reason: "LOKI_IMPLEMENT_HAIKU_FIRST opt-in" });
  }
  if (leanEnabled(env) && routerActive(env)) out.push({ stage: "implement", model: resolveModelAlias("sonnet"), reason: "LOKI_LEAN opt-in (small and normal units; one rung up after a failed verify)" }); // LEAN-5: named, never silent
  const fast = env.LOKI_MODEL_OVERRIDE ? undefined : env.LOKI_CLAUDE_MODEL_FAST || env.LOKI_MODEL_FAST || (env.LOKI_ALLOW_HAIKU === "true" ? "haiku" : "sonnet");
  if (planMode(env) !== "never" && weak(fast) && !(routerEnabled(env) && envOverride(env) === null)) out.push({ stage: "plan", model: fast, reason: "fast tier" });
  const wall = wallModel(env);
  if (wallEnabled(env) && weak(wall)) out.push({ stage: "wall", model: wall, reason: "Wall pin" });
  if (weak(wall)) out.push({ stage: "already_done", model: wall, reason: "already-done check pin" });
  return out;
}
