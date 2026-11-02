// Auto routing, the default when no model is pinned: Haiku executes (implement and fix), a stronger model advises only where it
// pays, and every decision is recorded with its reason. Kept beside the ROUTER-1 ladder (unit_model.ts), outside the engine10 line
// budget. The advisor is the platform's own server-side advisor tool (Settings.advisorModel, attached in providers.ts
// planRouterSession), never a separate Loki session: the Haiku executor consults it inside its own session.
//   (a) plan time: a task sized large, or a normal task in a big repo, gets a plan session whose Haiku executor carries the advisor.
//   (b) the first failed verify on a code-owned failure: Haiku's fix round carries the advisor.
//   (c) two failed Haiku rounds (implement, fix 1) on a code-owned failure: the executor itself climbs to Sonnet. The same holds
//       when Haiku ends implement on a spec conflict it repeated after its one correction (and the Wall referee did not clear it):
//       one Sonnet implement session decides whether the conflict is real before the run is BLOCKED.
// At most two sessions per run carry the advisor (plan, fix 1). A user pin (--model / LOKI_SESSION_MODEL, LOKI_MODEL_OVERRIDE, a
// development-tier model, a model route), LOKI_ROUTER=1, LOKI_E10_CASCADE=1, a non-claude provider or LOKI_AUTO_ROUTE=0 turns auto
// off and the run model rules as before.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveClaudeModel } from "../../util/claude_model.ts";
import { modelRouteModel } from "../../providers/model_routes.ts";
import { routerEnabled } from "./flag.ts";
import { ROUTER_ADVISOR_MODEL } from "./advisor_probe.ts";
import type { RunContext, SessionResult, SessionRunOptions, StageName } from "../../engine10/types.ts";

type Env = Record<string, string | undefined>;
const on = (v: string | undefined): boolean => ["1", "on", "true"].includes((v ?? "").trim().toLowerCase());
const off = (v: string | undefined): boolean => ["0", "off", "false", "no"].includes((v ?? "").trim().toLowerCase());

/** Sessions per run that may carry the advisor: the plan session and the first fix round. */
export const AUTO_ADVISED_SESSIONS_MAX = 2;
/** Child-env marker for an auto-routed session (the child cannot tell auto from a pin: session.ts writes the tier models into its env). */
export const AUTO_ROUTED_ENV = "LOKI_AUTO_ROUTED";
/** Child-env key naming the advisor model for this one session; read by providers.ts planRouterSession. */
export const AUTO_ADVISOR_ENV = "LOKI_AUTO_ADVISOR_MODEL";
/** A normal task in a repo with more files than this (or a truncated repo map) plans with the advisor: finding the place to change is the hard part there. */
export const AUTO_BIG_REPO_FILES = 1500;
export const AUTO_LOG_FILE = "auto-route.jsonl";
/** Start-line fragment for an auto-routed run (route_block.ts routeStartLine). */
export const AUTO_START_LINE = "route: auto (Haiku executes; an advisor is attached to the plan of a large task and to the first fix round; Sonnet takes over after two failed Haiku rounds; --model pins one model)";

/** Why auto routing is off for this run, or null when it is on. Order: the most explicit user choice first. */
export function autoRouteOffReason(env: Env = process.env, provider = "claude"): string | null {
  if (provider !== "claude") return `provider ${provider}`;
  if (off(env["LOKI_AUTO_ROUTE"])) return "LOKI_AUTO_ROUTE=0";
  for (const k of ["LOKI_SESSION_MODEL", "LOKI_MODEL_OVERRIDE", "LOKI_CLAUDE_MODEL_DEVELOPMENT", "LOKI_MODEL_DEVELOPMENT"]) if ((env[k] ?? "").trim()) return `${k} pin`;
  if (modelRouteModel(env)) return "model route";
  if (routerEnabled(env)) return "LOKI_ROUTER=1";
  if (on(env["LOKI_E10_CASCADE"])) return "LOKI_E10_CASCADE=1";
  return null;
}
export const autoRouteActive = (env: Env = process.env, provider = "claude"): boolean => autoRouteOffReason(env, provider) === null;
/** The auto executor: Haiku. */
export const autoExecutor = (): string => resolveClaudeModel("haiku");
/** The executor after two failed Haiku rounds. */
export const autoClimbModel = (): string => resolveClaudeModel("sonnet");

/** The advisor model, or null when LOKI_AUTO_ADVISOR=off. Default: the router's advisor (Opus); LOKI_AUTO_ADVISOR=sonnet|opus fixes it. */
export function autoAdvisor(env: Env = process.env): string | null {
  const v = (env["LOKI_AUTO_ADVISOR"] ?? "").trim().toLowerCase();
  if (off(v)) return null;
  return v === "sonnet" || v === "opus" ? v : ROUTER_ADVISOR_MODEL;
}

export interface AutoDecision { decision: string; model: string; reason: string; advisor?: string | null }

/** (a) Plan time. Fires for a large task, or a normal task in a big repo; never for a small task. */
export function autoPlanDecision(size: string, map: { files: string[]; truncated?: boolean } | null, env: Env = process.env): AutoDecision & { fire: boolean } {
  const n = map?.files.length ?? 0;
  const why = size === "large" ? "task sized large" : size === "normal" && map?.truncated ? "repo map truncated at the file cap" : size === "normal" && n > AUTO_BIG_REPO_FILES ? `repo has ${n} files > ${AUTO_BIG_REPO_FILES}` : null;
  const adv = why ? autoAdvisor(env) : null;
  if (why && adv) return { fire: true, decision: "plan-advisor", model: autoExecutor(), advisor: adv, reason: `${why}: Haiku plans with the ${adv} advisor attached, then implements the plan` };
  return { fire: false, decision: "plan-executor", model: autoExecutor(), advisor: null, reason: why ? `${why}, but LOKI_AUTO_ADVISOR=off: Haiku plans alone` : `task sized ${size}: Haiku plans in its implement session, no advisor` };
}

/** A fix-stage failure group the code owns: not lint, not test selection (the same split fix.ts escalates on). */
export const codeOwned = (groups: readonly { signature: string }[]): number => groups.filter((g) => !g.signature.startsWith("lint:") && g.signature !== "select-tests").length;

/** (b) and (c) for one fix round. round is 1-based; stallPending marks the round a verify stall granted. */
export function autoFixDecision(round: number, codeFailures: number, stallPending: boolean, env: Env = process.env): AutoDecision & { advise: boolean } {
  if (codeFailures === 0) return { advise: false, decision: "fix-executor", model: autoExecutor(), reason: "lint-only or harness-owned failure: Haiku keeps the round, no advisor" };
  if (round >= 2 || stallPending) return { advise: false, decision: "fix-climb", model: autoClimbModel(), reason: "two Haiku rounds (implement, fix 1) failed on a code-owned failure: the executor climbs to Sonnet" };
  const adv = autoAdvisor(env);
  return adv
    ? { advise: true, decision: "fix-advisor", model: autoExecutor(), advisor: adv, reason: `first failed verify on a code-owned failure: Haiku's fix round carries the ${adv} advisor` }
    : { advise: false, decision: "fix-executor", model: autoExecutor(), reason: "first failed verify, LOKI_AUTO_ADVISOR=off: Haiku fixes alone" };
}

/** One auto-routed fix round: decide (b)/(c) and record it. The caller pins `model` (routeGrant when above the executor) and attaches `advisor`. */
export function autoFixRound(ctx: Pick<RunContext, "emit" | "runDir">, round: number, groups: readonly { signature: string }[], stallPending: boolean): { model: string; advisor: string | null; decision: string } {
  const d = autoFixDecision(round, codeOwned(groups), stallPending);
  recordAuto(ctx, "fix", d, { round });
  return { model: d.model, advisor: d.advise ? d.advisor ?? null : null, decision: d.decision };
}

/** The stall climb under auto: once, Haiku to Sonnet, only on a code-owned failure. Null when the round already ran above Haiku. */
export function autoStallClimb(out: Partial<Record<string, Record<string, unknown> | undefined>>, reason: string): { unit: string; from: string; to: string; trigger: "stall"; evidence: string } | null {
  if (out["fix"]?.["stall_escalated"]) return null;
  const groups = (out["verify"]?.["failures_grouped"] as { signature: string }[] | undefined) ?? [];
  const cur = String(out["fix"]?.["model"] ?? out["implement"]?.["model"] ?? autoExecutor());
  if (codeOwned(groups) === 0 || !cur.toLowerCase().includes("haiku")) return null;
  return { unit: "run", from: cur, to: autoClimbModel(), trigger: "stall", evidence: reason.slice(0, 300) };
}

/** (c) at implement: a spec conflict Haiku repeated after its correction gets one Sonnet implement session. Returns the session to use. */
export async function autoConflictClimb(ctx: RunContext, opts: SessionRunOptions, session: SessionResult & { stderrTail?: string }, ids: string[]): Promise<SessionResult & { stderrTail?: string }> {
  if (!autoRouteActive(process.env, ctx.provider) || !session.markers.specConflict || session.killed || !String(opts.model ?? ctx.model).toLowerCase().includes("haiku")) return session;
  const d: AutoDecision = { decision: "implement-climb", model: autoClimbModel(), reason: "Haiku ended implement on a spec conflict twice: one Sonnet session decides whether it is real" };
  recordAuto(ctx, "implement", d, { conflict: session.markers.specConflict.slice(0, 200) });
  const iterationId = `${ids[ids.length - 1]}-climb`; ids.push(iterationId);
  return ctx.sessions.run({ ...opts, iterationId, model: d.model, routeGrant: d.decision });
}

/** Event plus one line in <runDir>/auto-route.jsonl, the record the receipt reads. Best effort on the file. */
export function recordAuto(ctx: Pick<RunContext, "emit" | "runDir">, stage: StageName, d: AutoDecision & { fire?: boolean; advise?: boolean }, extra: Record<string, unknown> = {}): void {
  const { fire: _f, advise: _a, ...own } = d, rest = { ...own, ...extra };
  ctx.emit("route", stage, { mode: "auto", stage, ...rest });
  try { mkdirSync(ctx.runDir, { recursive: true }); appendFileSync(join(ctx.runDir, AUTO_LOG_FILE), `${JSON.stringify({ stage, ...rest })}\n`); } catch { /* the event still carries it */ }
}

/** The implement decision, recorded once per run when auto routes it. */
export function recordAutoImplement(ctx: Pick<RunContext, "emit" | "runDir" | "provider">, hasPlan: boolean): void {
  if (autoRouteActive(process.env, ctx.provider)) recordAuto(ctx, "implement", { decision: "implement-executor", model: autoExecutor(), reason: hasPlan ? "Haiku implements the plan" : "Haiku plans and implements in one session" });
}

/** Child env for one auto-routed claude session (session.ts childEnv): the marker, and the advisor key only on a session that asked for it. */
export function autoChildEnv(env: NodeJS.ProcessEnv, advisor: string | undefined): void {
  env[AUTO_ROUTED_ENV] = "1";
  if (advisor) env[AUTO_ADVISOR_ENV] = advisor; else delete env[AUTO_ADVISOR_ENV];
}

/** Receipt block: the auto decisions and the model each session of the run reported. Empty (key omitted) when auto did not route this run. */
export function autoRoutingReceipt(runDir: string, lokiRoot: string, iterIds: readonly string[]): { routing?: Record<string, unknown> } {
  const file = join(runDir, AUTO_LOG_FILE);
  if (!existsSync(file)) return {};
  const decisions: unknown[] = [];
  try { for (const l of readFileSync(file, "utf8").split("\n")) if (l.trim()) { try { decisions.push(JSON.parse(l)); } catch { /* a torn line is skipped */ } } } catch { return {}; }
  const sessions = iterIds.map((id) => {
    let rec: Record<string, unknown> = {};
    try { rec = JSON.parse(readFileSync(join(lokiRoot, "metrics", `result-cost-${id}.json`), "utf8")) as Record<string, unknown>; } catch { /* not recorded */ }
    const model = typeof rec["model"] === "string" && rec["model"] ? rec["model"] : "not recorded";
    const tele = Object.fromEntries(["requests_total", "requests_over_100k", "max_request_tokens", "advisor_calls", "advisor_output_tokens"].filter((k) => typeof rec[k] === "number").map((k) => [k, rec[k]]));
    return { iteration: id, model, ...tele };
  });
  return { routing: { mode: "auto", executor: autoExecutor(), advised_sessions_max: AUTO_ADVISED_SESSIONS_MAX, decisions, sessions } };
}
