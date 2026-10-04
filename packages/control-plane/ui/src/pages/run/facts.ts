// Receipt facts and the Why line for the run page (RELEASE-11 A4b).
// receipt.json is the source of truth. An adapter reads every receipt version (field aliases, checks as a list or a map); the run's own events
// stand in only when the receipt file cannot be reached. "unmeasured" is printed only when a readable receipt lacks the field.
import { effectiveVerdict, type RunDetailResponse } from "../../api";
import { displayOutcome, stripAnsi } from "../../display";
import { UNMEASURED, whyLine } from "./model";

interface EventLike { type: string; stage: string | null; data: unknown }
const obj = (d: unknown): Record<string, unknown> => (d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : {});
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const pick = (o: Record<string, unknown>, keys: string[]): string | null => { for (const k of keys) { const v = text(o[k]); if (v) return v; } return null; };

export interface CheckCounts { total: number; pass: number; fail: number; notRun: number }
export interface ReceiptFacts { verdict: string | null; diffSha: string | null; base: string | null; head: string | null; checks: CheckCounts | null }
/** read: the receipt parsed (a missing field is genuinely absent); unreachable: the file could not be read here; loading: not answered yet. */
export type FactsState = "read" | "unreachable" | "loading";

const RESULT: Record<string, "pass" | "fail" | "not_run"> = { pass: "pass", passed: "pass", ok: "pass", success: "pass", flaky: "pass", fail: "fail", failed: "fail", failure: "fail", error: "fail", not_run: "not_run", skipped: "not_run", skip: "not_run" };
const resultOf = (c: unknown): "pass" | "fail" | "not_run" | null => {
  const o = obj(c);
  const r = typeof c === "string" ? c : text(o["result"]) ?? text(o["status"]) ?? text(o["outcome"]);
  return r ? RESULT[r.toLowerCase()] ?? null : null;
};
const count = (rs: Array<"pass" | "fail" | "not_run" | null>): CheckCounts => ({ total: rs.length, pass: rs.filter((r) => r === "pass").length, fail: rs.filter((r) => r === "fail").length, notRun: rs.filter((r) => r === "not_run").length });

/** The adapter: facts from receipt.json of any version. Every field the receipt lacks is null. Null when the text is not a receipt object. */
export function receiptFacts(raw: string | null | undefined): ReceiptFacts | null {
  if (!raw) return null;
  let j: Record<string, unknown>;
  try { const x = JSON.parse(raw); if (!x || typeof x !== "object" || Array.isArray(x)) return null; j = x as Record<string, unknown>; } catch { return null; }
  const git = obj(j["git"]), diff = obj(j["diff"]);
  const list = Array.isArray(j["checks"]) ? (j["checks"] as unknown[]) : Array.isArray(j["tests"]) ? (j["tests"] as unknown[]) : null;
  const map = !list && j["checks"] && typeof j["checks"] === "object" ? Object.values(obj(j["checks"])) : null;
  const rs = list ?? map;
  return {
    verdict: pick(j, ["verdict", "result", "outcome"]),
    diffSha: pick(j, ["diff_sha256", "diff_hash", "diff_sha"]) ?? pick(diff, ["sha256", "hash"]),
    base: pick(j, ["base_sha", "base", "base_commit"]) ?? pick(git, ["base", "base_sha"]),
    head: pick(j, ["head_sha", "head", "head_commit"]) ?? pick(git, ["head", "head_sha"]),
    checks: rs ? count(rs.map(resultOf)) : null,
  };
}

/** What the run's own events say, used only when the receipt file is unreachable: the commit head, any recorded base, and the last result per check. */
export function eventFacts(events: EventLike[]): ReceiptFacts {
  let head: string | null = null, base: string | null = null;
  const last = new Map<string, "pass" | "fail" | "not_run" | null>();
  for (const e of events) {
    const d = obj(e.data);
    if (e.type === "stage.completed" && e.stage === "commit") head = pick(d, ["head_sha"]) ?? head;
    base = pick(d, ["base_sha"]) ?? base;
    if (e.type === "test.result") { const n = text(d["name"]); if (n) last.set(n, resultOf(d)); }
  }
  return { verdict: null, diffSha: null, base, head, checks: last.size ? count([...last.values()]) : null };
}

/** The facts the Evidence section shows, and whether a missing one is absent from a read receipt or just out of reach. */
export function evidenceFacts(receiptJson: string | null | undefined, events: EventLike[]): { facts: ReceiptFacts; state: FactsState } {
  if (receiptJson === undefined) return { facts: { verdict: null, diffSha: null, base: null, head: null, checks: null }, state: "loading" };
  const read = receiptFacts(receiptJson);
  if (read) return { facts: read, state: "read" };
  return { facts: eventFacts(events), state: "unreachable" };
}

/** Text for one fact: its value, else "unmeasured" (the receipt was read and lacks it), else an honest reason it cannot be shown. */
export function factText(value: string | null, state: FactsState): string {
  if (value) return value;
  return state === "read" ? UNMEASURED : state === "loading" ? "loading" : "receipt file not reachable from this Control Plane";
}

export type RunDetail = RunDetailResponse & { stop_reason?: string | null; own_rules_block?: boolean };

export const OWN_RULES_TEXT = "Loki's own rules stopped this run (fixed in 10.10.3). Retry on the latest version.";

/** The display label for a run's verdict (tamper and integrity rules applied); never an enum string. */
export function runOutcome(d: RunDetail) {
  return displayOutcome(d.verdict ? effectiveVerdict(d) ?? d.verdict : null);
}

/** The one-sentence Why for a finished run: the terminal stop reason, fully ANSI-stripped. Integrity wording for tampered or unverified runs. Null when nothing stopped short. */
export function whyForRun(d: RunDetail): string | null {
  const ev = d.verdict ? effectiveVerdict(d) ?? d.verdict : null;
  if (!ev) return null;
  const integrity = d.integrity_reasons?.[0];
  if ((ev === "TAMPERED" || ev === "UNVERIFIED") && integrity) return stripAnsi(`The receipt did not pass the integrity check: ${integrity}`);
  return d.stop_reason ? stripAnsi(d.stop_reason).replace(/\s+/g, " ").trim() : null;
}

/** The unprocessed output behind "Show raw": the model's full conflict text and the verify failure line, exactly as recorded. */
export function rawWhy(events: EventLike[]): string | null {
  const conflict = events.find((e) => e.type === "stage.completed" && e.stage === "implement");
  const c = text(obj(conflict?.data)["spec_conflict_reason"]);
  const verify = whyLine(events.map((e) => ({ type: e.type, stage: e.stage, data: e.data })));
  const parts = [c, verify].filter((x): x is string => !!x);
  return parts.length ? parts.join("\n\n") : null;
}

/** R3: a one-line summary taken from the real stop reason. A run that failed with no verify evidence never says it "did not pass verification". */
export function summaryLine(run: { verdict: string | null; stop_reason?: string | null; hadVerify?: boolean }): string | null {
  if (run.stop_reason) return stripAnsi(run.stop_reason).replace(/\s+/g, " ").trim();
  if (run.verdict === "FAILED") return run.hadVerify ? "The run did not pass verification." : "The run failed before verification ran.";
  return null;
}
