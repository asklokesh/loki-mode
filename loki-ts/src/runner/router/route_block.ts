// loki-ts/src/runner/router/route_block.ts -- R1-15 receipt/start-line/PR-line route block (pure, no I/O).
// --- R1-15: router route block (ROUTER-1.md sections 4.1-4.4, L7). Pure; everything here is inert unless the
// router flag is on, so with LOKI_ROUTER unset the start line, receipt and PR body are byte-identical to before.
// Route facts (executor, advisor, escalations, units) are read defensively from the implement stage output
// (`route`, written by R1-11) and the R1-08 cost fields; when the router is on but nothing was recorded the
// block says "not routed" with the reason, never a guessed executor.
import { routerEnabled } from "./flag.ts";
export interface RouteEscalation { trigger: string; from: string; to: string; evidence: string }
/** One row per work unit. A per-run route renders as the single unit "run". */
export interface RouteUnit { id: string; executor: string; assigned_by: string; reason: string; escalations: RouteEscalation[] }
export interface RouteBlock {
  routed: boolean;
  units: RouteUnit[];
  executor: string | null;
  advisor: string | null; // advisor model, or null when unavailable
  advisor_unavailable_reason: string | null;
  reason: string;
  source: string | null;
  shape_key: string | null;
  shape_parity: string;
  escalations: RouteEscalation[];
  requests_total: number;
  requests_over_100k: number;
  over_100k_share: number | null; // requests_over_100k / requests_total, null when no request was recorded
  advisor_calls: number;
  advisor_input_tokens: number;
  advisor_output_tokens: number;
}
const ALIAS: Record<string, string> = { haiku: "haiku-5.5", sonnet: "sonnet-5.5", opus: "opus-5.5" };
const modelLabel = (m: string): string => ALIAS[m] ?? m;

/** Section 4.4 unavailability, from the environment only. Null when the advisor can be attached. */
export function advisorUnavailableReason(env: Record<string, string | undefined>, provider: string): string | null {
  if (provider !== "claude") return `provider ${provider} has no advisor tool`;
  if (env["CLAUDE_CODE_USE_BEDROCK"] || env["CLAUDE_CODE_USE_VERTEX"] || env["CLAUDE_CODE_USE_FOUNDRY"]) return "advisor tool is unsupported on Bedrock, Vertex and Foundry";
  if ((env["LOKI_ROUTER_ADVISOR"] ?? "").trim().toLowerCase() === "off") return "LOKI_ROUTER_ADVISOR=off";
  return null;
}

/** Start-line fragment: executor and advisor state, no silent reduction. Null when the router is off. */
export function routeStartLine(env: Record<string, string | undefined>, provider: string): string | null {
  if (!routerEnabled(env)) return null;
  const why = advisorUnavailableReason(env, provider);
  if (why) return `route: executor ${modelLabel((env["LOKI_ROUTER_EXECUTOR"] ?? "").trim() || "sonnet")}, advisor unavailable: ${why}`;
  return `route: executor ${modelLabel((env["LOKI_ROUTER_EXECUTOR"] ?? "").trim() || "haiku")}, advisor opus: Opus routes at plan time`;
}

const n0 = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const s0 = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
function toEsc(raw: unknown): RouteEscalation[] {
  const esc = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
  return esc.map((e) => ({ trigger: s0(e["trigger"]) ?? "unknown", from: modelLabel(s0(e["from"]) ?? "?"), to: modelLabel(s0(e["to"]) ?? "?"), evidence: s0(e["evidence"]) ?? "none recorded" }));
}
// Assigned by Opus unless the route names another source (shape-default, history floor, default).
const assignedBy = (src: string | null, explicit: unknown): string => s0(explicit) ?? (src === null || src === "opus" ? "opus" : src);

/** Build the receipt route block. Null when the router is off (key omitted, receipt hash stable). */
export function buildRouteBlock(
  env: Record<string, string | undefined>,
  provider: string,
  route: Record<string, unknown> | undefined,
  telemetry: Partial<Record<"requests_total" | "requests_over_100k" | "advisor_calls" | "advisor_input_tokens" | "advisor_output_tokens", number>> | undefined,
): RouteBlock | null {
  if (!routerEnabled(env)) return null;
  const executor = s0(route?.["executor"]);
  const unavailable = s0(route?.["advisor_unavailable_reason"]) ?? advisorUnavailableReason(env, provider);
  const total = n0(telemetry?.requests_total);
  const over = n0(telemetry?.requests_over_100k);
  const shape = s0(route?.["shape_key"]);
  const escalations = toEsc(route?.["escalations"]);
  const source = s0(route?.["source"]);
  const reason = s0(route?.["reason"]) ?? (executor ? "no reason recorded" : "no route recorded by implement");
  const rawUnits = Array.isArray(route?.["units"]) ? (route["units"] as Array<Record<string, unknown>>) : [];
  const units: RouteUnit[] = rawUnits.length > 0
    ? rawUnits.map((u, i) => ({ id: s0(u["id"]) ?? String(i + 1), executor: modelLabel(s0(u["executor"]) ?? "unknown"), assigned_by: assignedBy(s0(u["source"]) ?? source, u["assigned_by"]), reason: s0(u["reason"]) ?? "no reason recorded", escalations: toEsc(u["escalations"]) }))
    : executor ? [{ id: "run", executor: modelLabel(executor), assigned_by: assignedBy(source, route?.["assigned_by"]), reason, escalations }] : [];
  return {
    routed: executor !== null || units.length > 0,
    units,
    executor: executor ? modelLabel(executor) : units[0]?.executor ?? null,
    advisor: unavailable ? null : modelLabel(s0(route?.["advisor"]) ?? "opus"),
    advisor_unavailable_reason: unavailable,
    reason,
    source,
    shape_key: shape,
    shape_parity: shape ? `NOT PROVEN (no B9 row for shape ${shape})` : "NOT PROVEN (no shape key recorded)",
    escalations: units.length > 0 ? units.flatMap((u) => u.escalations) : escalations,
    requests_total: total,
    requests_over_100k: over,
    over_100k_share: total > 0 ? Math.round((over / total) * 10000) / 10000 : null,
    advisor_calls: n0(telemetry?.advisor_calls),
    advisor_input_tokens: n0(telemetry?.advisor_input_tokens),
    advisor_output_tokens: n0(telemetry?.advisor_output_tokens),
  };
}

const pct = (r: RouteBlock): string => (r.over_100k_share === null ? "n/a (no requests recorded)" : `${(r.over_100k_share * 100).toFixed(1)}%`);

/** One line for the PR body: the route, advisor tokens and the over-100K share. */
export function routePrLine(r: RouteBlock): string {
  if (!r.routed) return `Route: not routed (${r.reason})`;
  const adv = r.advisor ? `advisor ${r.advisor}` : "advisor unavailable";
  return `Route: executor ${r.executor}, ${adv}; advisor tokens ${r.advisor_input_tokens} in / ${r.advisor_output_tokens} out; over 100K: ${r.requests_over_100k} of ${r.requests_total} requests (${pct(r)})`;
}

/** Receipt markdown lines for the route block. */
export function routeReceiptLines(r: RouteBlock): string[] {
  if (!r.routed) return [`- Route: not routed (${r.reason})`, `- Route shape_parity: ${r.shape_parity}`];
  return [
    `- Route: executor ${r.executor}, ${r.advisor ? `advisor ${r.advisor}` : `advisor unavailable: ${r.advisor_unavailable_reason}`}: ${r.reason}`,
    `- Route shape_key: ${r.shape_key ?? "unknown"}  shape_parity: ${r.shape_parity}`,
    `- Route escalations: ${r.escalations.length === 0 ? "none" : r.escalations.map((e) => `${e.from} -> ${e.to} (${e.trigger}; evidence ${e.evidence})`).join("; ")}`,
    `- Route advisor: ${r.advisor_calls} calls, ${r.advisor_input_tokens} in / ${r.advisor_output_tokens} out tokens`,
    ...r.units.map((u) => `- Route unit ${u.id}: executor ${u.executor}, assigned by ${u.assigned_by}: ${u.reason}; escalation: ${u.escalations.length === 0 ? "none" : u.escalations.map((e) => `${e.from} -> ${e.to} (${e.trigger})`).join(", ")}`),
    `- Route requests over 100K: ${r.requests_over_100k} of ${r.requests_total} (${pct(r)})`,
  ];
}

/** NOT PROVEN lines the route block owes the receipt (L2, L5): the advisor owner is the provider. */
export function routeNotProven(r: RouteBlock): string[] {
  return [
    ...(r.advisor_unavailable_reason ? [`advisor: NOT PROVEN (owner provider): ${r.advisor_unavailable_reason}`] : []),
    `route.shape_parity: ${r.shape_parity}`,
  ];
}

/** Insert the route line directly under the verdict line; a body with no route line is returned untouched. */
export function withRouteLine(body: string, line: string | null): string {
  if (!line) return body;
  const lines = body.split("\n");
  const i = lines.findIndex((l) => l.startsWith("Verdict:"));
  if (i < 0) return body;
  lines.splice(i + 1, 0, line);
  return lines.join("\n");
}
