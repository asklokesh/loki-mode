// EL-W0-06 (D86, FC-04, L1/L7): every model pin weaker than the run's default is a downgrade. They are printed on the
// engine10 start line and recorded on run.started (key only when non-empty, so receipt hashes stay stable).
import { cascadeEnabled, cascadeImplementModel, planMode, wallEnabled, wallModel } from "../engine10/sizing.ts";
import { routerEnabled } from "./router/flag.ts"; import { envOverride } from "./router/decision.ts"; // FC-34: with the router on the plan session is pinned to Opus, so "plan sonnet (fast tier)" is not a downgrade
export interface ModelDowngrade { stage: string; model: string; reason: string }
const weak = (m: string | undefined): m is string => !!m && /sonnet|haiku/i.test(m);
/** Model the plan session's fast tier resolves to (mirrors session.ts childEnv: only LOKI_MODEL_OVERRIDE rewrites the tier). */
export function fastTierModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.LOKI_MODEL_OVERRIDE || env.LOKI_CLAUDE_MODEL_FAST || env.LOKI_MODEL_FAST || (env.LOKI_ALLOW_HAIKU === "true" ? "haiku" : "sonnet");
}
export function modelDowngrades(provider: string, env: NodeJS.ProcessEnv = process.env): ModelDowngrade[] {
  if (provider !== "claude") return [];
  if (weak(env.LOKI_MODEL_OVERRIDE)) return [{ stage: "all", model: env.LOKI_MODEL_OVERRIDE, reason: "LOKI_MODEL_OVERRIDE" }];
  const devName = env.LOKI_CLAUDE_MODEL_DEVELOPMENT ? "LOKI_CLAUDE_MODEL_DEVELOPMENT" : "LOKI_MODEL_DEVELOPMENT";
  if (weak(env[devName])) return [{ stage: "implement", model: env[devName]!, reason: devName }]; // the run itself is weak: auxiliaries are not weaker
  const out: ModelDowngrade[] = [];
  if (cascadeEnabled(env)) out.push({ stage: "implement,fix", model: cascadeImplementModel(env), reason: "LOKI_E10_CASCADE opt-in" });
  const fast = env.LOKI_MODEL_OVERRIDE ? undefined : env.LOKI_CLAUDE_MODEL_FAST || env.LOKI_MODEL_FAST || (env.LOKI_ALLOW_HAIKU === "true" ? "haiku" : "sonnet");
  if (planMode(env) !== "never" && weak(fast) && !(routerEnabled(env) && envOverride(env) === null)) out.push({ stage: "plan", model: fast, reason: "fast tier" });
  const wall = wallModel(env);
  if (wallEnabled(env) && weak(wall)) out.push({ stage: "wall", model: wall, reason: "Wall pin" });
  if (weak(wall)) out.push({ stage: "already_done", model: wall, reason: "already-done check pin" });
  return out;
}
