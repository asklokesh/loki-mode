// Work board column rules, derived only from GET /v1/runs fields (issue_ref, status, pr_url, verdict).
import type { RunRow } from "../../api";

export type ColumnId = "issue" | "running" | "pr" | "verified" | "notproven";

/**
 * A verdict decides first: VERIFIED is verified, any other verdict is NOT PROVEN.
 * No verdict yet: a PR url means the PR is open, a live run is running, and a run
 * that has not started (no started_at, not running) waits in the issue column.
 */
export function columnOf(r: RunRow): ColumnId {
  if (r.verdict) return r.verdict === "VERIFIED" ? "verified" : "notproven";
  if (r.pr_url) return "pr";
  if (r.status === "running" || r.started_at) return "running";
  return "issue";
}
