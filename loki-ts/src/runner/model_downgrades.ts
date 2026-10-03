// EL-W0-06 (D86, FC-04, L1): an explicit weaker-than-default model pin is a downgrade. It is printed on the
// engine10 start line and recorded on run.started (key only when non-empty, so receipt hashes stay stable).
export interface ModelDowngrade { stage: string; model: string; reason: string }
export function modelDowngrades(provider: string, env: NodeJS.ProcessEnv = process.env): ModelDowngrade[] {
  if (provider !== "claude") return [];
  const weak = (m: string | undefined): m is string => !!m && /sonnet|haiku/i.test(m);
  if (weak(env.LOKI_MODEL_OVERRIDE)) return [{ stage: "all", model: env.LOKI_MODEL_OVERRIDE, reason: "LOKI_MODEL_OVERRIDE" }];
  const name = env.LOKI_CLAUDE_MODEL_DEVELOPMENT ? "LOKI_CLAUDE_MODEL_DEVELOPMENT" : "LOKI_MODEL_DEVELOPMENT";
  const m = env[name];
  return weak(m) ? [{ stage: "implement", model: m, reason: name }] : [];
}
