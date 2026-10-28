// EL-W0-06 (D86, FC-04, L1): model ordering for the cascade and escalation. Lives in runner/ to keep engine10 core under its line budget.
import { cascadeEnabled, cascadeImplementModel, resolveModelAlias } from "../engine10/sizing.ts";
import { PROVIDER_DEFAULT_MODEL, sessionPinModel } from "../engine10/session.ts";
import { nextState, type EscalationEvent } from "./router/decision.ts";

/** L1: relative strength of a model id or alias; unknown ids rank top so they are never treated as weaker than the run model. */
export const modelRank = (m: string): number => { const id = resolveModelAlias(m).toLowerCase(); return ["haiku", "sonnet", "opus", "fable"].findIndex((t) => id.includes(t)) + (id.match(/haiku|sonnet|opus|fable/) ? 0 : 5); };
/** L1: the strongest model the provider offers by default (catalog opus alias; fable stays opt-in for cost); an escalated round is never below the run model, and an explicit LOKI_SESSION_MODEL pin is never escalated past. */
export const escalationModel = (runModel: string): string => (sessionPinModel() ? runModel : runModel !== PROVIDER_DEFAULT_MODEL && modelRank(runModel) > modelRank("opus") ? runModel : resolveModelAlias("opus")); // the provider-default label is a record, never a model id
/** L1: with the opt-in cascade on, the downgrade target; null when it would not be weaker than the run model (nothing is pinned). */
export function cascadeDowngrade(runModel: string, env = process.env): { from: string; to: string; note: string } | null {
  const to = cascadeImplementModel(env);
  return cascadeEnabled(env) && modelRank(to) < modelRank(runModel) ? { from: runModel, to, note: `model downgraded by cascade: ${runModel} -> ${to} (opt-in)` } : null;
}
/** TEN-COST-16: LOKI_IMPLEMENT_HAIKU_FIRST=1/on/true opts the first implement session onto the cheapest tier. OFF by default (Law L1). */
export const haikuFirstEnabled = (env = process.env): boolean => ["1", "on", "true"].includes((env["LOKI_IMPLEMENT_HAIKU_FIRST"] ?? "").toLowerCase());
/** TEN-COST-16: the haiku-first pin for the first implement session only; null when off or when the run model is not stronger. Fix rounds never use it: a failed verify always escalates to the run model, so no haiku attempt that failed verify ships. */
export function haikuFirstDowngrade(runModel: string, env = process.env): { from: string; to: string; note: string } | null {
  const to = resolveModelAlias("haiku");
  return haikuFirstEnabled(env) && modelRank(to) < modelRank(runModel) ? { from: runModel, to, note: `model downgraded by haiku-first: ${runModel} -> ${to} (opt-in; a failed verify escalates to ${runModel})` } : null;
}
/** Auxiliary stage pins (project model, Wall re-author, already-done) never run above the run's own model: a haiku run keeps them on haiku. An explicit user pin (any env key in pinKeys set) is returned exactly; an unknown run model ranks top, so nothing is capped. */
export const capToRunTier = (pin: string, runModel: string, pinKeys: readonly string[], env = process.env): string => pinKeys.some((k) => !!env[k]) || !runModel || modelRank(pin) <= modelRank(runModel) ? pin : runModel;
const klass = (m: string): string => resolveModelAlias(m).toLowerCase();
export type EscalationTrigger = "code_fail" | "escalate_marker" | "spec_conflict" | "limit_kill" | "stall";
export interface UnitEscalation { unit: string; from: string; to: string; trigger: EscalationTrigger; evidence: string }
const EVENT: Record<EscalationTrigger, EscalationEvent> = { code_fail: { kind: "code_fail_repeat" }, escalate_marker: { kind: "escalate_marker" }, spec_conflict: { kind: "spec_conflict" }, limit_kill: { kind: "limit_kill" }, stall: { kind: "stall" } };
/** ROUTER-1: per work unit ("run" for a single-unit run) ladder step, driven by decision.ts nextState. Only code-owned evidence reaches this (a harness-owned failure never does). A SPEC_CONFLICT confirmed on sonnet is BLOCKED, not a climb. decision.ts lacks one case, kept here: LOKI_ESCALATE on a run that already sits on sonnet goes to opus. Opus and unknown ids return null (never lowered). */
export function climb(unit: string, current: string, trigger: EscalationTrigger, evidence: string): UnitEscalation | null {
  const k = klass(current);
  const model = k.includes("haiku") ? "haiku" : k.includes("sonnet") ? "sonnet" : null;
  if (!model) return null;
  const t = nextState({ model, swapped: false }, EVENT[trigger]);
  const next = t.action === "none" || t.action === "blocked" || t.action === "stalled" ? (model === "sonnet" && trigger === "escalate_marker" ? "opus" : null) : t.state.model;
  return next && next !== model ? { unit, from: current, to: resolveModelAlias(next), trigger, evidence: evidence.slice(0, 300) } : null;
}
