// R1-05: ROUTER-1 core. Parses the Opus routing decision, resolves the executor, and holds the
// escalation state machine (docs/v11/ROUTER-1.md 4.1, 4.3, 4.4, 4.6). Pure: no I/O, no repo-shape or
// task-wording logic (L0). Model choice comes from the schema-checked JSON; harness logic is mechanism.
import type { ShapeDefault } from "./history.ts";

export type RouteExecutor = "haiku" | "sonnet";
export type RouteRisk = "low" | "medium" | "high";
export type RouteSource = "advisor" | "opus-plan" | "default" | "history";
export interface Route { executor: RouteExecutor; reason: string; risk: RouteRisk; source: RouteSource }
export interface ParsedRoute { route: Route; notProven: string | null }

const EXECUTORS: readonly string[] = ["haiku", "sonnet"];
const RISKS: readonly string[] = ["low", "medium", "high"];
const SOURCES: readonly string[] = ["advisor", "opus-plan"];
const MAX_REASON = 200;

/** Fallback when no valid route came back: the run default is Sonnet (founder refinement 21:45Z). */
export function defaultRoute(_advisorAvailable: boolean, reason = "no route returned"): Route {
  return { executor: "sonnet", source: "default", risk: "medium", reason };
}

/** Parse a route (JSON text, an object, or plan-scope.json content holding `route`). Invalid or missing -> default + NOT PROVEN (L2). */
export function parseRoute(input: unknown, advisorAvailable: boolean): ParsedRoute {
  const fail = (why: string): ParsedRoute => ({ route: defaultRoute(advisorAvailable), notProven: `NOT PROVEN (owner model): routing decision ${why}` });
  let v: unknown = input;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return fail("is not valid JSON"); } }
  if (typeof v !== "object" || v === null) return fail("is missing");
  const holder = v as Record<string, unknown>;
  const r = (typeof holder.route === "object" && holder.route !== null ? holder.route : holder) as Record<string, unknown>;
  if (typeof r.executor !== "string" || !EXECUTORS.includes(r.executor)) return fail("has an invalid executor");
  if (typeof r.risk !== "string" || !RISKS.includes(r.risk)) return fail("has an invalid risk");
  if (typeof r.reason !== "string" || r.reason.trim() === "" || r.reason.length > MAX_REASON) return fail("has an invalid reason");
  if (typeof r.source !== "string" || !SOURCES.includes(r.source)) return fail("has an invalid source");
  return { route: { executor: r.executor as RouteExecutor, reason: r.reason, risk: r.risk as RouteRisk, source: r.source as RouteSource }, notProven: null };
}

const RANK = ["haiku", "sonnet", "opus"];
const rankOf = (m: string): number => { const i = RANK.findIndex((t) => m.toLowerCase().includes(t)); return i < 0 ? RANK.length : i; };

export type ResolvedSource = "override" | RouteSource | "shape-default" | "no-advisor-floor" | "no-evidence";
export interface ResolveInput {
  route: Route;
  advisorAvailable: boolean;
  /** Shipped shape default (4.6); can only move the executor up. */
  shapeDefault?: ShapeDefault | null;
  /** Per-repo history floor (H4): "sonnet" when Haiku lost 2 of the last 3; can only move up. */
  historyFloor?: "haiku" | "sonnet";
  /** The exact model LOKI_ROUTER=0 would use for this stage. */
  priorDefaultModel: string;
  env?: Record<string, string | undefined>;
}
export interface Resolved { model: string; source: ResolvedSource; reason: string }

/** Explicit overrides win and bypass the router. */
function envOverride(env: Record<string, string | undefined>): string | null {
  for (const k of ["LOKI_MODEL_OVERRIDE", "LOKI_CLAUDE_MODEL_DEVELOPMENT", "LOKI_ROUTER_EXECUTOR"]) { const v = (env[k] ?? "").trim(); if (v) return v; }
  return null;
}

/** Strongest of: route, shape default, history floor, no-advisor floor. Evidence rungs never lower a model; never Haiku without the advisor. */
export function resolveExecutor(i: ResolveInput): Resolved {
  const ov = envOverride(i.env ?? {});
  if (ov) return { model: ov, source: "override", reason: "explicit model override" };
  let best: Resolved = { model: i.route.executor, source: i.route.source, reason: i.route.reason };
  const raise = (model: string, source: ResolvedSource, reason: string): void => { if (rankOf(model) > rankOf(best.model)) best = { model, source, reason }; };
  // CTO 21:40Z + founder 21:45Z: Haiku only when Opus routed it, the shape earned it (shipped "haiku" listing, floor not tripped) and the advisor is attached.
  const earnedHaiku = i.advisorAvailable && i.route.executor === "haiku" && i.route.source !== "default" && i.shapeDefault === "haiku" && i.historyFloor !== "sonnet";
  if (rankOf(best.model) === 0 && !earnedHaiku) raise("sonnet", "no-evidence", "no evidence the shape earned haiku: executor sonnet");
  if (i.shapeDefault === "sonnet") raise("sonnet", "shape-default", "shipped shape default");
  else if (i.shapeDefault === "prior-default") raise(i.priorDefaultModel, "shape-default", "shipped shape default: prior-default");
  if (i.historyFloor === "sonnet") raise("sonnet", "history", "Haiku lost 2 of the last 3 runs on this shape");
  if (!i.advisorAvailable) raise("sonnet", "no-advisor-floor", "advisor unavailable: executor fixed at sonnet");
  return best;
}

export type ExecState = { model: "haiku" | "sonnet" | "opus"; swapped: boolean };
export type EscalationEvent =
  | { kind: "code_fail_repeat" }
  | { kind: "escalate_marker" }
  | { kind: "spec_conflict" }
  | { kind: "stall" }
  | { kind: "limit_kill" }
  | { kind: "error"; owner: "harness" | "env" | "provider" | "code" };
export type EscalationAction = "none" | "swap-sonnet" | "swap-sonnet-retry" | "fix-on-opus" | "blocked" | "stalled";
export interface Transition { state: ExecState; action: EscalationAction }

/** Pure 4.3 state machine. Only a code-owned FAIL drives escalation (L5); at most one Haiku -> Sonnet swap per run. */
export function nextState(s: ExecState, e: EscalationEvent): Transition {
  const stay = (action: EscalationAction = "none"): Transition => ({ state: s, action });
  if (e.kind === "error") return stay();
  if (s.model === "haiku") {
    if (e.kind === "code_fail_repeat" || e.kind === "escalate_marker") return { state: { model: "sonnet", swapped: true }, action: "swap-sonnet" };
    return { state: { model: "sonnet", swapped: true }, action: "swap-sonnet-retry" }; // spec_conflict | stall | limit_kill
  }
  if (s.model === "sonnet") {
    if (e.kind === "spec_conflict") return stay("blocked");
    if (e.kind === "code_fail_repeat" || e.kind === "stall") return { state: { model: "opus", swapped: s.swapped }, action: "fix-on-opus" };
    return stay();
  }
  return e.kind === "code_fail_repeat" || e.kind === "stall" ? stay("stalled") : stay();
}
