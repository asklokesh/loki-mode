// COST-WALL: the TS side of the child-session cost ledger. Mirrors loki_child_ledger_append in
// autonomy/lib/claude-flags.sh and the reader autonomy/lib/efficiency_cost.py read_child_ledger:
// one JSON line per provider child session in <lokiDir>/metrics/child-sessions.jsonl with
// phase, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, usd, source.
// usd is OMITTED (never 0) when the cost is unknown; the reader then reports a lower bound.
// cost_status "unmeasured" is an extra, reader-ignored marker on such lines.
// Not for engine10 stage sessions (SessionRunner): those already write efficiency/iteration-N.json,
// and a ledger line as well would count them twice.
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { calculateCostFromRecords } from "../runner/budget.ts";
import { neverRan, UNMETERED } from "../providers/provider_cost.ts";

export interface LedgerRecord {
  phase: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  usd?: number;
  run_id?: string; // the engine10 run that spawned this child; the run total sums only its own lines
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
    const file = join(dir, "child-sessions.jsonl"), runId = process.env["LOKI_E10_RUN_ID"];
    let lead = "";
    try { const fd = openSync(file, "r"); try { const sz = fstatSync(fd).size, b = Buffer.alloc(1); if (sz > 0 && readSync(fd, b, 0, 1, sz - 1) === 1 && b[0] !== 10) lead = "\n"; } finally { closeSync(fd); } } catch { /* no file yet */ } // a torn earlier write leaves no newline: start on a fresh line so it can never glue onto this record
    // run_id is the FIRST key, so a line cut short mid-write still names its run (sumChildLedger fails closed on any line it cannot parse).
    appendFileSync(file, `${lead}${JSON.stringify(runId && !rec.run_id ? { run_id: runId, ...rec } : rec.run_id ? { run_id: rec.run_id, ...rec } : rec)}\n`);
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

// Child sessions append to metrics/child-sessions.jsonl: the cross-review, reviewer, council, grill, docs and enrich calls and the SDK judge (see the appendChildLedger / withChildLedger / loki_child_ledger_append callers). Project-model and wall are NOT ledger writers.
// Only this run's lines count (run_id). A line with no dollar figure, or a $0 line with zero usage (E-69), is UNKNOWN, never 0.
// A ledger that exists but cannot be read is one UNKNOWN part. So is an unparseable line (a torn write) that could hold this run's record: one that names this run (or a prefix of its id, or carries a glued `{"run_id":` record start that does), a bare fragment that is a prefix of this run's record start (`{`, `{"ru`, `{"run_id"`) wherever it appears, one after this run's first own record, or a bare fragment at the end of the file (a write possibly still in flight). A torn fragment that names another run, or an unattributable one that is not such a prefix and ends before this run's first record, is skipped. The writer always starts on a fresh line, so a later append never glues onto a fragment.
const RUN_START = /\{"run_id":"([^"]*)("?)/g;
function mayHoldRun(line: string, runId: string, seenOwn: boolean, isLast: boolean): boolean {
  let any = false;
  for (const m of line.matchAll(RUN_START)) { any = true; if (m[2] === '"' ? m[1] === runId : runId.startsWith(m[1] ?? "")) return true; }
  if (any) return false;
  return `{"run_id":"${runId}"`.startsWith(line.trim()) || seenOwn || isLast; // a bare fragment that is a prefix of this run's record start (`{`, `{"ru`, `{"run_id"`) may be its torn record, wherever it sits
}
export interface ChildSums { usd: number | null; partialUsd: number; measured: number; total: number; inputTokens: number; outputTokens: number }
export function sumChildLedger(lokiRoot: string, runId: string): ChildSums {
  let lines: string[] = [], unreadable = false;
  try { lines = readFileSync(join(lokiRoot, "metrics", "child-sessions.jsonl"), "utf8").split("\n"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") unreadable = true; /* no ledger file: no children */ }
  let partialUsd = 0, measured = 0, inputTokens = 0, outputTokens = 0, total = unreadable ? 1 : 0, seenOwn = false, last = lines.length - 1;
  while (last >= 0 && !lines[last]!.trim()) last--;
  for (const [i, l] of lines.entries()) {
    if (!l.trim()) continue;
    let r: Record<string, unknown>;
    try { r = JSON.parse(l) as Record<string, unknown>; } catch { if (mayHoldRun(l, runId, seenOwn, i === last)) total++; continue; } // torn line: unknown unless it provably cannot hold this run's record
    if (!r || typeof r !== "object" || r["run_id"] !== runId) continue;
    total++; seenOwn = true;
    const usage = ["input_tokens", "output_tokens", "cache_creation_tokens", "cache_read_tokens"].reduce((t, k) => t + (isNum(r[k]) ? r[k] : 0), 0);
    inputTokens += isNum(r["input_tokens"]) ? r["input_tokens"] : 0; outputTokens += isNum(r["output_tokens"]) ? r["output_tokens"] : 0;
    if (isNum(r["usd"]) && r["usd"] >= 0 && !(r["usd"] === 0 && usage === 0)) { partialUsd += r["usd"]; measured++; }
  }
  return { usd: total === measured ? partialUsd : null, partialUsd, measured, total, inputTokens, outputTokens };
}

/** The ONE rule that adds a run's child sessions to its stage-session dollars. Receipt, run.completed, the console Cost line, Slack, status and handoff all go through it. Unknown on either side makes the total null; partial figures and counts keep the measured part. */
export function addChildren<T extends { usd: number | null; partialUsd: number; measuredCount: number; totalCount: number }>(c: T, k: ChildSums | null): T {
  if (!k || k.total === 0) return c;
  return { ...c, usd: c.usd !== null && k.usd !== null ? c.usd + k.usd : null, partialUsd: c.partialUsd + k.partialUsd, measuredCount: c.measuredCount + k.measured, totalCount: c.totalCount + k.total };
}

/** The children bucket of a run's cost: stage figures (tokens, per_model, per_stage, retry, savings) never include these. */
export interface ChildBucket { usd: number | null; partial_usd: number; sessions: number; measured: number; input_tokens: number; output_tokens: number }

/** A stage CostResult plus this run's children: usd/partialUsd/counts via addChildren, a truthful `children` bucket, and breakdown.usd = per_stage + children_usd. */
export function withChildren<T extends { usd: number | null; partialUsd: number; measuredCount: number; totalCount: number; breakdown?: { usd: number | null } }>(c: T, lokiRoot: string, runId?: string): T & { children?: ChildBucket } {
  const k = runId ? sumChildLedger(lokiRoot, runId) : null, r = addChildren(c, k);
  if (!k || k.total === 0) return r;
  return { ...r, children: { usd: k.usd, partial_usd: k.partialUsd, sessions: k.total, measured: k.measured, input_tokens: k.inputTokens, output_tokens: k.outputTokens }, ...(r.breakdown ? { breakdown: { ...r.breakdown, usd: r.usd, children_usd: k.usd } } : {}) };
}

type CostEv = { type: string; data: Record<string, unknown> };
/** Dollars of a set of cost events: null when there are none or any is unpriced. The ONE sum fold() and the run total share. */
export function costUsdOf(events: CostEv[]): number | null {
  let usd = 0, saw = false;
  for (const e of events) { if (e.type !== "cost") continue; saw = true; if (typeof e.data["usd"] !== "number") return null; usd += e.data["usd"]; }
  return saw ? usd : null;
}

/** Cost events without the attempts that never ran. A quota rerun reuses its iteration id, so the Nth cost event of a session id is attempt N, whose result-cost file was archived as <id>-q<N> (archivePriorCost); an attempt whose archive has the never-ran shape (the receipt drops it too, via liveArchivedCosts) is not part of the run's cost. */
export function liveCostEvents<T extends CostEv>(events: T[], lokiRoot?: string, unmetered = UNMETERED): T[] {
  if (!lokiRoot) return events;
  const seen = new Map<string, number>();
  return events.filter((e) => {
    const id = e.type === "cost" ? e.data["session_id"] : undefined;
    if (typeof id !== "string") return true;
    const n = (seen.get(id) ?? 0) + 1; seen.set(id, n);
    return !neverRan(join(lokiRoot, "metrics", `result-cost-${id}-q${n}.json`), unmetered);
  });
}

/** THE run cost from the event log: live stage cost events plus this run's children through addChildren. Receipt, run.completed, status, dashboard and the console Cost line all read it. */
export function runCost(events: (CostEv & { run?: string })[], lokiRoot?: string): { usd: number | null; partialUsd: number; measuredCount: number; totalCount: number } {
  const costs = liveCostEvents(events, lokiRoot).filter((e) => e.type === "cost"), priced = costs.filter((e) => typeof e.data["usd"] === "number");
  const stage = { usd: costUsdOf(costs), partialUsd: priced.reduce((t, e) => t + (e.data["usd"] as number), 0), measuredCount: priced.length, totalCount: costs.length };
  return addChildren(stage, lokiRoot && events[0]?.run ? sumChildLedger(lokiRoot, events[0].run) : null);
}

/** Child spend since this meter was created, for the dollar cap: pre-existing lines are already in the seeded prior spend. */
export function childSpendMeter(lokiRoot: string, runId: string): () => number {
  const base = sumChildLedger(lokiRoot, runId).partialUsd;
  return () => Math.max(sumChildLedger(lokiRoot, runId).partialUsd - base, 0);
}
