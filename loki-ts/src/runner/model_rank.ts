// EL-W0-06 (D86, FC-04, L1): model ordering for the cascade and escalation. Lives in runner/ to keep engine10 core under its line budget.
import { cascadeEnabled, cascadeImplementModel, resolveModelAlias } from "../engine10/sizing.ts";
import { PROVIDER_DEFAULT_MODEL } from "../engine10/session.ts";

/** L1: relative strength of a model id or alias; unknown ids rank top so they are never treated as weaker than the run model. */
export const modelRank = (m: string): number => { const id = resolveModelAlias(m).toLowerCase(); return ["haiku", "sonnet", "opus", "fable"].findIndex((t) => id.includes(t)) + (id.match(/haiku|sonnet|opus|fable/) ? 0 : 5); };
/** L1: the strongest model the provider offers by default (catalog opus alias; fable stays opt-in for cost); an escalated round is never below the run model. */
export const escalationModel = (runModel: string): string => (runModel !== PROVIDER_DEFAULT_MODEL && modelRank(runModel) > modelRank("opus") ? runModel : resolveModelAlias("opus")); // the provider-default label is a record, never a model id
/** L1: with the opt-in cascade on, the downgrade target; null when it would not be weaker than the run model (nothing is pinned). */
export function cascadeDowngrade(runModel: string, env = process.env): { from: string; to: string; note: string } | null {
  const to = cascadeImplementModel(env);
  return cascadeEnabled(env) && modelRank(to) < modelRank(runModel) ? { from: runModel, to, note: `model downgraded by cascade: ${runModel} -> ${to} (opt-in)` } : null;
}
