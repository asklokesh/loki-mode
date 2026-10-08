// ROUTER-1 R1-09: session-runner routing helpers, kept outside the engine10 line budget. Every function is inert unless LOKI_ROUTER=1.
import { readFileSync } from "node:fs";
import { resolveModelAlias } from "../../engine10/sizing.ts";
import { ROUTER_COST_FIELDS, type SessionMarkers } from "../../engine10/types.ts";
import { routerEnabled } from "./flag.ts";
import { floorNoAdvisor, routerActive } from "./unit_model.ts";

/** The per-call model pin for a session child. Flag off, or a user model override set: the caller's pin exactly as pre-router (an override
 *  user sees identical behavior with the router on and off). Router active: the no-advisor executor floor (section 4.4) applies to the
 *  development tier, and a haiku pin is raised to sonnet when the advisor is unavailable. Mutates env only for the development floor. */
export function routerSessionPin(env: NodeJS.ProcessEnv, provider: string, advisor: { available: boolean } | undefined, opts: { model?: string; tier: string }): string | undefined {
  if (!routerActive()) return opts.model;
  if (provider === "claude" && advisor?.available === false && !process.env["LOKI_MODEL_DEVELOPMENT"] && !opts.model && opts.tier === "development") {
    env["LOKI_CLAUDE_MODEL_DEVELOPMENT"] = resolveModelAlias("sonnet");
    delete env["LOKI_E10_MODEL_DEFAULT"];
  }
  return floorNoAdvisor(opts.model, advisor);
}

/** LOKI_ESCALATE marker, parsed only under the flag so the flag-off marker shape is byte-identical. */
export function routerMarkers(stdout: string, base: SessionMarkers): SessionMarkers {
  if (!routerEnabled()) return base;
  const m = /^\W*LOKI_ESCALATE:\s*(.+)$/m.exec(stdout);
  return m ? { ...base, escalate: m[1]!.trim() } : base;
}

/** R1-09: only under the flag, only the fields the cost record (R1-08) actually carries. */
export function routedCostFields(dest: string): Record<string, number> {
  const out: Record<string, number> = {};
  if (!routerEnabled()) return out;
  try { const rec = JSON.parse(readFileSync(dest, "utf8")) as Record<string, unknown>; for (const k of ROUTER_COST_FIELDS) if (typeof rec[k] === "number") out[k] = rec[k] as number; } catch { /* no record or unreadable: no extra fields */ }
  return out;
}
