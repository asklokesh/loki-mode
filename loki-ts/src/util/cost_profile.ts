// TEN-COST-01: opt-in cost profile. `loki start --cost lean` / LOKI_COST_PROFILE=lean turns on the
// already-built, flag-gated cost levers together. It only fills unset variables, so explicit user env wins.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const COST_PROFILES: Record<string, Record<string, string>> = {
  lean: { LOKI_ROUTER: "1", LOKI_E10_TRIM: "1" },
  off: {},
};

export class CostProfileError extends Error {}

/** The env patch for a profile name: only variables not already set in `env`. Unset or 'off' gives {}. */
export function resolveCostProfile(name: string | undefined, env: NodeJS.ProcessEnv): Record<string, string> {
  const n = (name ?? "").trim().toLowerCase();
  if (n === "") return {};
  const levers = COST_PROFILES[n];
  if (!levers) throw new CostProfileError(`unknown cost profile '${name}' (expected lean or off)`);
  const patch: Record<string, string> = {};
  for (const [k, v] of Object.entries(levers)) {
    if (env[k] === undefined || env[k] === "") patch[k] = v;
  }
  return patch;
}

/** Apply the profile through `applyEnv`, record the levers in <lokiDir>/cost-profile.json, and return the one-line start note ('' when off or unset). */
export function applyCostProfile(
  name: string | undefined,
  env: NodeJS.ProcessEnv,
  applyEnv: (k: string, v: string) => void,
  lokiDir?: string,
): string {
  const patch = resolveCostProfile(name, env);
  const n = (name ?? "").trim().toLowerCase();
  if (n === "" || n === "off") return "";
  for (const [k, v] of Object.entries(patch)) applyEnv(k, v);
  const levers = Object.keys(patch);
  if (lokiDir) {
    try {
      mkdirSync(lokiDir, { recursive: true });
      const kept = Object.keys(COST_PROFILES[n]!).filter((k) => !(k in patch));
      writeFileSync(join(lokiDir, "cost-profile.json"), JSON.stringify({ profile: n, applied: patch, kept_user_env: kept }, null, 2) + "\n");
    } catch {
      // the record is best effort; the note below still names the levers
    }
  }
  return `cost profile ${n}: ${levers.length ? levers.map((k) => `${k}=${patch[k]}`).join(" ") : "all levers already set by env"}`;
}
