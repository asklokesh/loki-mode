// R1-05: the ROUTER-1 feature flag. Unset = off while the router is being built (flipped by R1-19).
export type RouterMode = "off" | "on" | "opt-out";

/** `0` is the explicit opt-out to pre-router behavior; `1` turns the router on; unset is off in this build. */
export function routerMode(env: Record<string, string | undefined> = process.env): RouterMode {
  const v = (env.LOKI_ROUTER ?? "").trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off") return "opt-out";
  if (v === "1" || v === "true" || v === "on") return "on";
  return "off";
}

/** True only when the router is explicitly on. Off and opt-out both keep the pre-router path. */
export const routerEnabled = (env: Record<string, string | undefined> = process.env): boolean => routerMode(env) === "on";
