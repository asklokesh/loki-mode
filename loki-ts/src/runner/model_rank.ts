// EL-W0-06 (D86, FC-04, L1): model ordering for the cascade and escalation. Lives in runner/ to keep engine10 core under its line budget.
import { cascadeEnabled, cascadeImplementModel, resolveModelAlias } from "../engine10/sizing.ts";
import { PROVIDER_DEFAULT_MODEL } from "../engine10/session.ts";
import { nextState, type EscalationEvent } from "./router/decision.ts";

/** L1: relative strength of a model id or alias; unknown ids rank top so they are never treated as weaker than the run model. */
export const modelRank = (m: string): number => { const id = resolveModelAlias(m).toLowerCase(); return ["haiku", "sonnet", "opus", "fable"].findIndex((t) => id.includes(t)) + (id.match(/haiku|sonnet|opus|fable/) ? 0 : 5); };
/** L1: the strongest model the provider offers by default (catalog opus alias; fable stays opt-in for cost); an escalated round is never below the run model. */
export const escalationModel = (runModel: string): string => (runModel !== PROVIDER_DEFAULT_MODEL && modelRank(runModel) > modelRank("opus") ? runModel : resolveModelAlias("opus")); // the provider-default label is a record, never a model id
/** L1: with the opt-in cascade on, the downgrade target; null when it would not be weaker than the run model (nothing is pinned). */
export function cascadeDowngrade(runModel: string, env = process.env): { from: string; to: string; note: string } | null {
  const to = cascadeImplementModel(env);
  return cascadeEnabled(env) && modelRank(to) < modelRank(runModel) ? { from: runModel, to, note: `model downgraded by cascade: ${runModel} -> ${to} (opt-in)` } : null;
}
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
