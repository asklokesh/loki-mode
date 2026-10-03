// Pure helpers for the run page. Each one reads only what the API returned; a missing value stays null and the view prints "unmeasured".
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
