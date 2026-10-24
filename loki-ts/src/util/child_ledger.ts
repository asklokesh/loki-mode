// COST-WALL: the TS side of the child-session cost ledger. Mirrors loki_child_ledger_append in
// autonomy/lib/claude-flags.sh and the reader autonomy/lib/efficiency_cost.py read_child_ledger:
// one JSON line per provider child session in <lokiDir>/metrics/child-sessions.jsonl with
// phase, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, usd, source.
// usd is OMITTED (never 0) when the cost is unknown; the reader then reports a lower bound.
// cost_status "unmeasured" is an extra, reader-ignored marker on such lines.
// Not for engine10 stage sessions (SessionRunner): those already write efficiency/iteration-N.json,
// and a ledger line as well would count them twice.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { calculateCostFromRecords } from "../runner/budget.ts";

export interface LedgerRecord {
  phase: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  usd?: number;
  source: string;
  cost_status?: "unmeasured";
  outcome?: string; // judge calls: ok | truncated | refused:<category> | context_exceeded | malformed | transport
  max_tokens?: number; // judge calls only: the request cap, to read against output_tokens
  prompt_tokens?: number; // judge calls: prompt size, see prompt_tokens_source
  prompt_tokens_source?: "measured" | "estimated"; // measured = count_tokens endpoint; estimated = calibrated chars/4, never a measurement
  token_ratio?: number; // judge calls: measured/estimated for this prompt (only when measured)
  thinking_clamp?: string; // judge calls only: "<from>-><to>@<effort> (max <level>)" when the thinking type was clamped for the effort
}

const n = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) ? v : 0);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A child session whose cost could not be read: usd omitted, flagged unmeasured. */
export function unmeasuredRecord(phase: string, model: string, source: string): LedgerRecord {
  return { phase, model, input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, source, cost_status: "unmeasured" };
}

/** From a claude `--output-format json` result (object or message list): total_cost_usd wins, else tokens priced by the shared table, else unmeasured. Null when it is not a result object. */
export function recordFromClaudeResult(phase: string, payload: unknown, source = "claude-json"): LedgerRecord | null {
  let d: unknown = payload;
  if (Array.isArray(d)) d = [...d].reverse().find((x) => x && typeof x === "object" && (x as Record<string, unknown>)["type"] === "result");
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const o = d as Record<string, unknown>, u = (o["usage"] && typeof o["usage"] === "object" ? o["usage"] : {}) as Record<string, unknown>;
  const mu = o["modelUsage"], model = mu && typeof mu === "object" && Object.keys(mu).length ? Object.keys(mu)[0]! : typeof o["model"] === "string" ? o["model"] : "";
  const rec: LedgerRecord = { phase, model, input_tokens: n(u["input_tokens"]), output_tokens: n(u["output_tokens"]), cache_creation_tokens: n(u["cache_creation_input_tokens"]), cache_read_tokens: n(u["cache_read_input_tokens"]), source };
  const usd = o["total_cost_usd"] ?? o["cost_usd"];
  if (isNum(usd)) rec.usd = usd;
  else if (rec.input_tokens + rec.output_tokens + rec.cache_creation_tokens + rec.cache_read_tokens > 0) {
    rec.usd = calculateCostFromRecords([{ model: model || undefined, input_tokens: rec.input_tokens, output_tokens: rec.output_tokens, cache_read_tokens: rec.cache_read_tokens, cache_creation_tokens: rec.cache_creation_tokens }]);
    rec.source = `${source}+priced`;
  } else rec.cost_status = "unmeasured";
  return rec;
}

/** From raw API usage (the SDK judge path, which has tokens but no dollar figure): priced by the shared table. */
export function recordFromUsage(phase: string, model: string, usage: Record<string, unknown> | null | undefined, source = "sdk-judge"): LedgerRecord {
  const u = usage ?? {};
  const rec: LedgerRecord = { phase, model, input_tokens: n(u["input_tokens"]), output_tokens: n(u["output_tokens"]), cache_creation_tokens: n(u["cache_creation_input_tokens"]), cache_read_tokens: n(u["cache_read_input_tokens"]), source };
  if (rec.input_tokens + rec.output_tokens + rec.cache_creation_tokens + rec.cache_read_tokens === 0) { rec.cost_status = "unmeasured"; return rec; }
  rec.usd = calculateCostFromRecords([{ model, input_tokens: rec.input_tokens, output_tokens: rec.output_tokens, cache_read_tokens: rec.cache_read_tokens, cache_creation_tokens: rec.cache_creation_tokens }]);
  return rec;
}

/** Append one line. Best effort: a ledger failure never fails the child session it describes. Returns whether a line was written. */
export function appendChildLedger(lokiDir: string, rec: LedgerRecord): boolean {
  try {
    const dir = join(lokiDir, "metrics");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "child-sessions.jsonl"), `${JSON.stringify(rec)}\n`);
    return true;
  } catch { return false; }
}

/** The shared spawn wrapper: runs a child runner and appends exactly one ledger line for it (result JSON cost if its stdout carries one, else unmeasured). A throwing child still gets its unmeasured line, then rethrows. */
export function withChildLedger<A extends unknown[], R extends { stdout: string }>(run: (...a: A) => Promise<R>, lokiDir: string, phase: string, model = ""): (...a: A) => Promise<R> {
  return async (...a: A): Promise<R> => {
    let r: R;
    try { r = await run(...a); } catch (e) { appendChildLedger(lokiDir, unmeasuredRecord(phase, model, "ts-spawn")); throw e; }
    let parsed: unknown = null;
    try { parsed = JSON.parse(r.stdout); } catch { /* plain text stdout: no cost to read */ }
    appendChildLedger(lokiDir, recordFromClaudeResult(phase, parsed, "ts-spawn") ?? unmeasuredRecord(phase, model, "ts-spawn"));
    return r;
  };
}
