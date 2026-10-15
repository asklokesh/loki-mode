// OC-OUTPUT: one shared end-of-run summary, same format as autonomy/lib/run-summary.sh
// (legacy engine). Pure formatting; callers supply already-measured facts. Null is never shown as 0.
import { safeGit } from "../util/safe_git.ts";
import type { Outcome } from "./output.ts";

export type RunResult = "verified" | "done-unverified" | "failed" | "stopped";

export interface RunSummaryInput {
  result: RunResult;
  filesChanged: number | null;
  insertions?: number | null;
  deletions?: number | null;
  costUsd: number | null;
  costEstimated?: boolean;
  elapsedS: number;
  receiptPath?: string | null;
  next: string;
}

/** Map engine10's Outcome to the four user-facing results. */
export function resultOf(outcome: Outcome): RunResult {
  if (outcome === "VERIFIED" || outcome === "ALREADY_SATISFIED") return "verified";
  if (outcome === "PARTIAL") return "done-unverified";
  if (outcome === "BUDGET_STOP" || outcome === "BLOCKED" || outcome === "STALLED") return "stopped";
  return "failed";
}

/** The one "next:" suggestion. */
export function nextOf(result: RunResult, filesChanged: number | null): string {
  if (result === "verified") return filesChanged ? "loki diff" : "loki status";
  if (result === "done-unverified") return "loki verify";
  if (result === "stopped") return "loki status";
  return filesChanged ? "loki undo" : "loki doctor";
}

function dur(s: number): string {
  const n = Math.max(0, Math.round(s));
  return n < 60 ? `${n}s` : `${Math.floor(n / 60)}m${String(n % 60).padStart(2, "0")}s`;
}

export function useColor(env: NodeJS.ProcessEnv = process.env, isTty: boolean = !!process.stdout.isTTY): boolean {
  return isTty && env.NO_COLOR === undefined;
}

export function summaryObject(i: RunSummaryInput): Record<string, unknown> {
  return { result: i.result, files_changed: i.filesChanged, insertions: i.insertions ?? null, deletions: i.deletions ?? null, cost_usd: i.costUsd, cost_estimated: !!i.costEstimated, elapsed_s: Math.round(i.elapsedS), receipt: i.receiptPath ?? null, next: i.next };
}

export function formatRunSummary(i: RunSummaryInput, opts: { json?: boolean; color?: boolean } = {}): string {
  if (opts.json) return `${JSON.stringify(summaryObject(i))}\n`;
  const paint = (code: number, t: string): string => (opts.color ? `\u001b[${code}m${t}\u001b[0m` : t);
  const tone = i.result === "verified" ? 32 : i.result === "done-unverified" ? 33 : 31;
  const files = i.filesChanged == null ? "unknown" : `${i.filesChanged} changed${i.insertions != null && i.deletions != null ? ` (+${i.insertions} -${i.deletions})` : ""}`;
  const cost = i.costUsd == null ? "not measured" : `$${i.costUsd.toFixed(2)}${i.costEstimated ? " (estimated)" : ""}`;
  const lines = [
    `Result:   ${paint(tone, i.result)}`,
    `Files:    ${files}`,
    `Cost:     ${cost}`,
    `Elapsed:  ${dur(i.elapsedS)}`,
    ...(i.receiptPath ? [`Receipt:  ${i.receiptPath}`] : []),
    `next:     ${i.next}  (or: loki chat --attach)`,
  ];
  return `${lines.join("\n")}\n`;
}

/** Best-effort diff stat of the run range; null when git cannot answer. */
export function diffStat(repoDir: string, base: string | null): { files: number; ins: number; del: number } | null {
  if (!base) return null;
  try {
    const s = safeGit(repoDir, ["diff", "--shortstat", `${base}..HEAD`, "--", ".", ":(exclude).loki"]);
    const g = (re: RegExp): number => Number(re.exec(s)?.[1] ?? 0);
    return { files: g(/(\d+) files? changed/), ins: g(/(\d+) insertion/), del: g(/(\d+) deletion/) };
  } catch {
    return null;
  }
}
