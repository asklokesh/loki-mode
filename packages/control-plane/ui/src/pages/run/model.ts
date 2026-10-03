// Pure helpers for the run page. Each one reads only what the API returned; a missing value stays null and the view prints "unmeasured".
import { effectiveVerdict, type RunRow } from "../../api";
import type { TimelineLine } from "./timeline";

export const UNMEASURED = "unmeasured";

/** What a stage does, in plain English. The words describe the stage; outcome, reason, time, model and cost come from the run's events. */
const STAGE_BLURB: Record<string, string> = {
  intake: "Read the issue and its comments",
  plan: "Named the files and tests in scope",
  implement: "Edited the code in an isolated worktree",
  fix: "Fixed what the failing checks reported",
  verify: "Ran the repo tests against the change",
  commit: "Committed the change to the run branch",
  wall: "Checked the run against its time budget",
  seal: "Signed a receipt with the diff hash",
  "deep-verify": "Full suite and secret scan after the PR opens",
};

export function describeLine(l: TimelineLine): string {
  const tail = l.detail ? ` (${l.detail})` : "";
  if (l.kind === "run") return `Run started${l.detail ? ` for ${l.detail}` : ""}`;
  if (l.kind === "pr") return `Opened a ${l.outcome === "draft" ? "draft " : ""}pull request${tail}`;
  if (l.kind === "receipt") return `Sealed the receipt, ${l.outcome}`;
  if (l.kind === "verdict") return `Run finished with verdict ${l.outcome}`;
  const base = STAGE_BLURB[l.label] ?? `Stage ${l.label}`;
  if (l.outcome === "failed") return `${base}: failed${tail}`;
  if (l.outcome === "skipped") return `${base}: skipped${tail}`;
  if (l.outcome === "running") return `${base}: in progress`;
  return `${base}${tail}`;
}

/** HH:MM:SS (UTC) of an ISO timestamp, or null. */
export function clock(ts: string | null | undefined): string | null {
  const n = ts ? Date.parse(ts) : NaN;
  return Number.isNaN(n) ? null : new Date(n).toISOString().slice(11, 19);
}

export interface ChangedFile { path: string; added: number; removed: number; kind: "added" | "deleted" | "modified" }

/** Changed files from a unified diff. Counts come from the +/- lines; nothing is estimated. */
export function parseDiffFiles(patch: string): ChangedFile[] {
  const out: ChangedFile[] = [];
  let cur: ChangedFile | null = null;
  for (const line of patch.split("\n")) {
    const g = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (g) { cur = { path: g[2]!, added: 0, removed: 0, kind: "modified" }; out.push(cur); continue; }
    if (!cur) continue;
    if (line.startsWith("new file mode")) cur.kind = "added";
    else if (line.startsWith("deleted file mode")) cur.kind = "deleted";
    else if (line.startsWith("+++") || line.startsWith("---")) continue;
    else if (line.startsWith("+")) cur.added++;
    else if (line.startsWith("-")) cur.removed++;
  }
  return out;
}

/** An owner for a NOT PROVEN item, only when the receipt text names one ("owner: x", "[x] ..." or "(owner x)"). Otherwise null: the API carries no owner field. */
export function notProvenItem(raw: string): { text: string; owner: string | null } {
  const a = /^\s*\[([^\]]{1,40})\]\s*(.*)$/.exec(raw);
  if (a) return { owner: a[1]!, text: a[2]! };
  const b = /^(.*?)[\s,;(-]*\(?owner[:\s]+([A-Za-z0-9_@./-]{1,40})\)?\s*$/i.exec(raw);
  if (b) return { owner: b[2]!, text: b[1]! };
  return { owner: null, text: raw };
}

export function stageProgress(stages: Array<{ status: string }>): { n: number; m: number; running: boolean } {
  const m = stages.length;
  const running = stages.some((s) => s.status === "started");
  const done = stages.filter((s) => s.status !== "started").length;
  return { n: Math.min(m, done + (running ? 1 : 0)), m, running };
}

export function elapsedLabel(s: number | null | undefined): string {
  if (typeof s !== "number") return UNMEASURED;
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s` : `${s.toFixed(1)}s`;
}

export interface DiffStatLike { base: string; head: string; files: { path: string; added: number | null; removed: number | null }[]; added: number; removed: number }

/** Changed files with counts. The unified diff wins; else the server's receipt-and-git numstat; else null (unmeasured). A binary file keeps null counts. */
export function changedFilesFor(patch: string | null | undefined, stat: DiffStatLike | null | undefined): { files: { path: string; added: number | null; removed: number | null; kind: ChangedFile["kind"] }[]; source: "patch" | "git" } | null {
  const fromPatch = patch ? parseDiffFiles(patch) : [];
  if (fromPatch.length) return { files: fromPatch, source: "patch" };
  if (stat && stat.files.length) return { files: stat.files.map((f) => ({ ...f, kind: "modified" as const })), source: "git" };
  return null;
}

const evObj = (d: unknown): Record<string, unknown> => (d && typeof d === "object" ? (d as Record<string, unknown>) : {});
const evStr = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const clip = (s: string, n = 120): string => (s.length > n ? `${s.slice(0, n - 3)}...` : s);
const TIME_REASON = /time ?limit|timed out|time budget|over cap/i;
interface WhyEvent { type: string; stage: string | null; data: unknown }

/** One plain-English line for a run that did not verify, built only from real events: failing checks (last result per check),
 *  stage failure or skip reasons, and fix rounds whose session was killed at its time limit. Null when the events name no cause. */
export function whyLine(events: WhyEvent[]): string | null {
  const checks = new Map<string, { result: string; why: string | null }>();
  const stageWhy: string[] = [];
  let fixLimit = 0;
  for (const e of events) {
    const d = evObj(e.data);
    if (e.type === "test.result") {
      const name = evStr(d["name"]);
      if (name) checks.set(name, { result: String(d["result"] ?? ""), why: evStr(d["first_error"]) ?? evStr(d["reason"]) });
    } else if (e.type === "stage.completed" && e.stage === "fix" && d["killed"] === true) fixLimit++;
    else if ((e.type === "stage.failed" || e.type === "stage.skipped") && e.stage) {
      const r = evStr(d["reason"]);
      if (r && e.stage !== "fix") stageWhy.push(`${e.stage}: ${clip(r)}`);
      else if (r && TIME_REASON.test(r)) fixLimit++;
    }
  }
  const parts: string[] = [];
  const failing = [...checks].filter(([, c]) => c.result === "fail");
  if (failing.length) parts.push(`verify: ${failing.slice(0, 3).map(([n, c]) => (c.why ? `${n} ${clip(c.why, 90)}` : `${n} failed`)).join("; ")}${failing.length > 3 ? `; ${failing.length - 3} more` : ""}`);
  const notRun = [...checks].filter(([, c]) => c.result === "not_run");
  if (!failing.length && notRun.length) parts.push(`verify: ${notRun.slice(0, 3).map(([n, c]) => (c.why ? `${n} not run (${clip(c.why, 60)})` : `${n} not run`)).join("; ")}`);
  for (const s of stageWhy.slice(0, 2)) if (!parts.some((p) => p.includes(s))) parts.push(s);
  if (fixLimit) parts.push(`${fixLimit} fix round${fixLimit === 1 ? "" : "s"} hit time limits`);
  return parts.length ? parts.join("; ") : null;
}

export interface ReceiptFacts {
  verdict: string | null; diffSha: string | null; base: string | null; head: string | null;
  checks: { total: number; pass: number; fail: number; notRun: number } | null;
}

/** Facts from a parsed receipt.json; any field the receipt lacks is null. */
export function receiptFacts(raw: string | null | undefined): ReceiptFacts | null {
  if (!raw) return null;
  let j: Record<string, unknown>;
  try { const x = JSON.parse(raw); if (!x || typeof x !== "object") return null; j = x as Record<string, unknown>; } catch { return null; }
  const cs = Array.isArray(j["checks"]) ? (j["checks"] as unknown[]).map(evObj) : null;
  const n = (r: string) => (cs ?? []).filter((c) => c["result"] === r).length;
  return {
    verdict: evStr(j["verdict"]), diffSha: evStr(j["diff_sha256"]), base: evStr(j["base_sha"]), head: evStr(j["head_sha"]),
    checks: cs ? { total: cs.length, pass: n("pass") + n("flaky"), fail: n("fail"), notRun: n("not_run") } : null,
  };
}

/** The Why line for a finished run whose display verdict is not VERIFIED or ALREADY_SATISFIED; null for a good or unfinished run. A non-good run whose events name no cause says so. */
export function whyForRun(d: RunRow, events: WhyEvent[]): string | null {
  const ev = d.verdict ? effectiveVerdict(d) ?? d.verdict : null;
  if (!ev || ev.startsWith("VERIFIED") || ev.startsWith("ALREADY_SATISFIED")) return null;
  const integrity = d.integrity_reasons?.[0];
  return ((ev === "TAMPERED" || ev === "UNVERIFIED") && integrity ? `integrity: ${integrity}` : whyLine(events)) ?? `${UNMEASURED}: the run's events name no failing check or stage reason`;
}
