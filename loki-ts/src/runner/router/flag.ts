// R1-05: the ROUTER-1 feature flag. Unset = off while the router is being built (flipped by R1-19).
export type RouterMode = "off" | "on" | "auto" | "opt-out";

/** `0` is the explicit opt-out to pre-router behavior; `1` turns the router on; `auto` turns it on with the auto preset; unset is off in this build. */
export function routerMode(env: Record<string, string | undefined> = process.env): RouterMode {
  const v = (env.LOKI_ROUTER ?? "").trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off") return "opt-out";
  if (v === "1" || v === "true" || v === "on") return "on";
  if (v === "auto") return "auto";
  return "off";
}

/** True only when the router is explicitly on (1, or the auto preset). Off and opt-out both keep the pre-router path. */
export const routerEnabled = (env: Record<string, string | undefined> = process.env): boolean => { const m = routerMode(env); return m === "on" || m === "auto"; };

/**
 * LOKI_ROUTER=auto: the router with the auto preset. The executor (implement and fix) is LOKI_ROUTER_EXECUTOR, else Haiku, else Sonnet
 * when LOKI_ALLOW_HAIKU=false. The Opus plan session runs only on a hard task (sizing.ts hardReason). The advisor stays scoped to plan
 * and fix. Everything else (climb ladder, stall climb, spec-conflict redo, route record, receipt route block) is the router's own.
 */
export const routerPreset = (env: Record<string, string | undefined> = process.env): boolean => routerMode(env) === "auto";
export function presetExecutor(env: Record<string, string | undefined> = process.env): { model: string; reason: string } {
  const fixed = (env.LOKI_ROUTER_EXECUTOR ?? "").trim();
  if (fixed) return { model: fixed, reason: "LOKI_ROUTER=auto, executor from LOKI_ROUTER_EXECUTOR" };
  return env.LOKI_ALLOW_HAIKU === "false"
    ? { model: "sonnet", reason: "LOKI_ROUTER=auto with LOKI_ALLOW_HAIKU=false: Sonnet executes implement and fix" }
    : { model: "haiku", reason: "LOKI_ROUTER=auto: Haiku executes implement and fix" };
}

/**
 * #246: the advisor alone, without executor routing. LOKI_ADVISOR=1 attaches the Opus advisor to a session and changes nothing else,
 * so a parity run can compare advisor on against router off. Unset or 0 is off: the default flips only on a measured win
 * (benchmarks/bench/equivalence_report.py advisor verdict).
 */
export function advisorOnlyEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.LOKI_ADVISOR ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

/** True when a session plan applies: the router is on, or the advisor was asked for on its own. */
export const sessionPlanEnabled = (env: Record<string, string | undefined> = process.env): boolean => routerEnabled(env) || advisorOnlyEnabled(env);
