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
  /** Explicit env; callers pass it (no process.env default, so the function stays pure). */
  env: Record<string, string | undefined>;
}
export interface Resolved { model: string; source: ResolvedSource; reason: string }

/** User bypass: these win over the router and are recorded with source "override". LOKI_ROUTER_EXECUTOR is NOT one; it is a route input that passes every floor. */
export function envOverride(env: Record<string, string | undefined>): string | null {
  for (const k of ["LOKI_MODEL_OVERRIDE", "LOKI_CLAUDE_MODEL_DEVELOPMENT"]) { const v = (env[k] ?? "").trim(); if (v) return v; }
  return null;
}

/** Strongest of: route, shape default, history floor, no-advisor floor. Evidence rungs never lower a model; never Haiku without the advisor. */
export function resolveExecutor(i: ResolveInput): Resolved {
  const env = i.env ?? {};
  const ov = envOverride(env);
  if (ov) return { model: ov, source: "override", reason: "explicit model override" };
  let best: Resolved = { model: i.route.executor, source: i.route.source, reason: i.route.reason };
  const routerExec = (env.LOKI_ROUTER_EXECUTOR ?? "").trim();
  if (routerExec) best = { model: routerExec, source: "advisor", reason: "LOKI_ROUTER_EXECUTOR route input" };
  const raise = (model: string, source: ResolvedSource, reason: string): void => { if (rankOf(model) > rankOf(best.model)) best = { model, source, reason }; };
  // CTO 21:40Z + founder 21:45Z: Haiku only when Opus routed it, the shape earned it (shipped "haiku" listing, floor not tripped) and the advisor is attached.
  const earnedHaiku = i.advisorAvailable && rankOf(best.model) === 0 && best.source !== "default" && i.shapeDefault === "haiku" && i.historyFloor !== "sonnet";
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

// STEP 2 (founder 21:45Z): per-unit routing. Opus assigns an executor per work unit; the harness
// never decides by task type, it only validates the schema and applies mechanism (L0).
export interface UnitRoute { id: string; kind: string; executor: RouteExecutor; reason: string }
export interface ParsedUnits { units: UnitRoute[]; notProven: string[] }
/** The Wall acceptance-test unit has this fixed id; the id is a contract, not a wording match. */
export const WALL_UNIT_ID = "wall";

export const MAX_UNITS = 200;
export const MAX_UNIT_FIELD = 64;
const UNIT_ID = /^[A-Za-z0-9_.-]+$/;
const RESERVED_IDS: readonly string[] = ["__proto__", "constructor", "prototype"]; // the pattern alone admits these

/** Parse `units` from route JSON (string or object). Missing, invalid, duplicate-id or over-cap units become sonnet + NOT PROVEN; advisor unavailable raises haiku to sonnet. */
export function parseUnits(input: unknown, advisorAvailable: boolean): ParsedUnits {
  let v: unknown = input;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return { units: [], notProven: ["NOT PROVEN (owner model): per-unit routes are not valid JSON; default sonnet"] }; } }
  const raw = typeof v === "object" && v !== null ? (v as Record<string, unknown>).units : undefined;
  if (!Array.isArray(raw)) return { units: [], notProven: ["NOT PROVEN (owner model): no per-unit routes returned; default sonnet"] };
  if (raw.length === 0) return { units: [], notProven: ["NOT PROVEN (owner model): empty per-unit routes; default sonnet"] };
  if (raw.length > MAX_UNITS) return { units: [], notProven: [`NOT PROVEN (owner model): ${raw.length} per-unit routes exceed the cap of ${MAX_UNITS}; default sonnet`] };
  const idOf = (u: unknown): string | null => {
    const id = typeof u === "object" && u !== null ? (u as Record<string, unknown>).id : undefined;
    return typeof id === "string" && id.length <= MAX_UNIT_FIELD && UNIT_ID.test(id) && !RESERVED_IDS.includes(id) ? id : null;
  };
  const seen = new Map<string, number>();
  for (const u of raw) { const id = idOf(u); if (id !== null) seen.set(id, (seen.get(id) ?? 0) + 1); }
  const units: UnitRoute[] = []; const notProven: string[] = [];
  raw.forEach((u, idx) => {
    const r = (typeof u === "object" && u !== null ? u : {}) as Record<string, unknown>;
    const goodId = idOf(u);
    const id = goodId ?? `#${idx}`; // "#" never matches UNIT_ID: no collision with a real id
    const kindOk = typeof r.kind === "string" && r.kind.length <= MAX_UNIT_FIELD;
    const dup = goodId !== null && (seen.get(goodId) ?? 0) > 1;
    const ok = goodId !== null && !dup && kindOk && typeof r.executor === "string" && EXECUTORS.includes(r.executor)
      && typeof r.reason === "string" && r.reason.trim() !== "" && r.reason.length <= MAX_REASON;
    if (!ok) { units.push({ id, kind: kindOk ? (r.kind as string) : "", executor: "sonnet", reason: dup ? "duplicate unit id" : "invalid unit route" }); notProven.push(`NOT PROVEN (owner model): unit ${id} route ${dup ? "has a duplicate id" : "invalid"}; sonnet`); return; }
    const raised = r.executor === "haiku" && !advisorAvailable;
    units.push({ id, kind: r.kind as string, executor: raised ? "sonnet" : (r.executor as RouteExecutor), reason: raised ? "advisor unavailable: raised to sonnet" : (r.reason as string) });
  });
  return { units, notProven };
}

/** A haiku unit that fails a code-owned check is redone on sonnet; harness, env and provider failures never escalate (L5). */
export function unitRedo(executor: RouteExecutor, owner: "harness" | "env" | "provider" | "code"): "redo-sonnet" | "none" {
  return executor === "haiku" && owner === "code" ? "redo-sonnet" : "none";
}

/** Opus assigned the Wall acceptance tests to haiku: an Opus advisor review of the Wall must be recorded before implement. */
export const wallReviewRequired = (units: readonly UnitRoute[]): boolean => units.some((u) => u.id === WALL_UNIT_ID && u.executor === "haiku");
