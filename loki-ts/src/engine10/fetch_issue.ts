// E-04: the P1 fetch child (ENGINE.md section 6). Credentialed, deterministic, no LLM: wraps
// autonomy/issue-providers.sh's `fetch_issue()` for the normalized title/body/labels, then
// (GitHub only) reads `state` and `closedByPullRequestsReferences` so Intake's already-done check
// (section 4 step 6) has real data to decide ALREADY_SATISFIED on. NormalizedIssue and Execer are
// local (types.ts declares neither); exec is injected so tests run with no gh/bash/network dependency.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../util/paths.ts";
export interface NormalizedIssue {
  provider: string;
  number: number;
  title: string;
  body: string;
  labels: string[];
  author: string;
  url: string;
  created_at: string;
  repo: string;
  state: string | null; // lowercased; null when not determinable (non-GitHub, or the lookup failed)
  closed_by_merged_pr: boolean;
}
export type Execer = (cmd: string, args: string[]) => string;
const ISSUE_PROVIDERS_SH = join(REPO_ROOT, "autonomy/issue-providers.sh");
export function defaultExec(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", env: process.env });
}
interface GithubExtra {
  state?: string;
  closedByPullRequestsReferences?: { merged?: boolean }[];
}
/** Fetches and normalizes one issue. Never runs an LLM; a failed GitHub
 *  extra-fields lookup leaves state null (NOT PROVEN), never a false
 *  already-done. */
export function fetchIssue(ref: string, execer: Execer = defaultExec): NormalizedIssue {
  const raw = execer("bash", ["-c", `source "${ISSUE_PROVIDERS_SH}" && fetch_issue "$1"`, "--", ref]);
  const base = JSON.parse(raw) as Omit<NormalizedIssue, "state" | "closed_by_merged_pr">;
  let state: string | null = null;
  let closedByMergedPr = false;
  if (base.provider === "github" && base.repo && base.number) {
    try {
      const extra = JSON.parse(
        execer("gh", ["issue", "view", String(base.number), "--repo", base.repo, "--json", "state,closedByPullRequestsReferences"]),
      ) as GithubExtra;
      state = typeof extra.state === "string" ? extra.state.toLowerCase() : null;
      closedByMergedPr = Array.isArray(extra.closedByPullRequestsReferences)
        && extra.closedByPullRequestsReferences.some((pr) => pr?.merged === true);
    } catch {
      // gh unavailable or the lookup failed: leave state null, not a claim of "open".
    }
  }
  return { ...base, state, closed_by_merged_pr: closedByMergedPr };
}
/** CLI/child-process entry point for the future P1 wiring (E-03/E-11): writes
 *  the normalized issue to `outFile` (Intake then reads it from `<runDir>/issue.json`). */
export function fetchIssueToFile(ref: string, outFile: string, exec: Execer = defaultExec): NormalizedIssue {
  const issue = fetchIssue(ref, exec);
  writeFileSync(outFile, JSON.stringify(issue));
  return issue;
}
if (import.meta.main && import.meta.path.endsWith("fetch_issue.ts")) {
  const [ref, outFile] = process.argv.slice(2);
  if (!ref || !outFile) {
    console.error("usage: fetch_issue.ts <ref> <outFile>");
    process.exit(1);
  }
  fetchIssueToFile(ref, outFile);
}
