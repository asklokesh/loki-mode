// E-04: the P1 fetch child (ENGINE.md section 6). Credentialed, deterministic, no LLM: wraps autonomy/issue-providers.sh's `fetch_issue()` for the normalized title/body/labels, then (GitHub only) reads `state`, `closedByPullRequestsReferences` and `comments` (L039: trusted authors only, see isTrustedGithubComment) so Intake's already-done check (section 4 step 6) has real data to decide ALREADY_SATISFIED on. NormalizedIssue and Execer are local (types.ts declares neither); exec is injected so tests run with no gh/bash/network dependency.
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
  comments?: IssueComment[]; // L039: trusted comments only, oldest first, capped; also rendered into body
  comments_omitted?: number; // trusted comments dropped by the cap (oldest first)
  comments_excluded?: number; // comments left out by the trust rule: counted, never quoted
}
/** One comment intake kept. `association` is GitHub's authorAssociation, or the steer-actor list that trusted a Jira/Linear author. */
export interface IssueComment { author: string; association: string; created_at: string; body: string }
// L039 trust rule for GitHub comments: the same set and exclusions as autonomy/trigger-server.py steering
// (TRUSTED_ASSOCIATIONS, bot authors, LOKI_COMMENT_MARKER) and commands/verify_pr.ts. Minimized comments are
// hidden by a maintainer, so they are left out too.
export const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
export const LOKI_COMMENT_MARKER = "<!-- loki-"; // same marker as trigger-server.py: Loki-authored comments never count
export const COMMENTS_CAP_BYTES = 16_384;
interface GhComment { author?: { login?: string; is_bot?: boolean } | null; authorAssociation?: string; body?: string; createdAt?: string; isMinimized?: boolean }
export function isTrustedGithubComment(c: GhComment): boolean {
  const login = typeof c?.author?.login === "string" ? c.author.login : "";
  return TRUSTED_ASSOCIATIONS.has(String(c?.authorAssociation ?? "")) && login !== "" && !login.endsWith("[bot]")
    && c.author?.is_bot !== true && c.isMinimized !== true && typeof c.body === "string" && c.body.trim() !== ""
    && !c.body.includes(LOKI_COMMENT_MARKER);
}
const renderComment = (c: IssueComment): string => `Comment from ${c.author} (${c.association}${c.created_at ? `, ${c.created_at}` : ""}):\n${c.body.trim()}\n`;
/** Keeps the newest comments whose rendered text fits in `cap` bytes (one oversized newest comment is cut to fit), returned oldest first. */
export function capComments(list: IssueComment[], cap = COMMENTS_CAP_BYTES): { comments: IssueComment[]; omitted: number } {
  const kept: IssueComment[] = [];
  let used = 0;
  for (let k = list.length - 1; k >= 0; k--) {
    const c = list[k]!, n = Buffer.byteLength(renderComment(c));
    if (used + n <= cap) { kept.unshift(c); used += n; continue; }
    if (kept.length === 0) {
      const note = "\n[cut at the 16 KB comment cap]", room = cap - Buffer.byteLength(renderComment({ ...c, body: "" })) - Buffer.byteLength(note);
      if (room > 0) kept.unshift({ ...c, body: Buffer.from(c.body.trim()).subarray(0, room).toString("utf8").replace(/\uFFFD+$/, "") + note });
    }
    break;
  }
  return { comments: kept, omitted: list.length - kept.length };
}
/** Adds the trusted context to an issue: a comments array, and the labels and comments appended to body. Every stage builds its
 *  task text from title + body and quotes it as untrusted data (types.ts taskBlock), so this needs no stage change. No labels and
 *  no comments leaves body byte-identical. */
export function withIssueContext<T extends NormalizedIssue>(issue: T, trusted: IssueComment[], excluded: number): T {
  const { comments, omitted } = capComments(trusted);
  const parts: string[] = [];
  if (issue.labels.length > 0) parts.push(`Labels: ${issue.labels.join(", ")}\n`);
  if (comments.length > 0) {
    parts.push(`Comments from trusted authors, oldest first${omitted ? ` (${omitted} older comment(s) left out to stay within 16 KB)` : ""}:`);
    parts.push(...comments.map(renderComment));
  }
  const body = parts.length === 0 ? issue.body : `${issue.body.replace(/\s+$/, "")}${issue.body.trim() ? "\n\n" : ""}## Issue tracker context\n\n${parts.join("\n")}`.replace(/\s+$/, "");
  return { ...issue, body, comments, comments_omitted: omitted, comments_excluded: excluded };
}
export type Execer = (cmd: string, args: string[]) => string;
const ISSUE_PROVIDERS_SH = join(REPO_ROOT, "autonomy/issue-providers.sh");
// A hung gh or network stall must not block Intake: execFileSync kills the child on timeout and throws (ETIMEDOUT), the existing fetch failure. 60s default; env override is for tests.
export function defaultExec(cmd: string, args: string[]): string {
  const ms = Number(process.env.LOKI_FETCH_ISSUE_TIMEOUT_MS) || 60_000;
  return execFileSync(cmd, args, { encoding: "utf8", env: process.env, timeout: ms, killSignal: "SIGKILL" });
}
interface GithubExtra { state?: string; closedByPullRequestsReferences?: { merged?: boolean }[]; comments?: GhComment[] }
/** Fetches and normalizes one issue. Never runs an LLM; a failed GitHub  extra-fields lookup leaves state null (NOT PROVEN), never a false  already-done. */
export function fetchIssue(ref: string, execer: Execer = defaultExec): NormalizedIssue {
  const raw = execer("bash", ["-c", `source "${ISSUE_PROVIDERS_SH}" && fetch_issue "$1"`, "--", ref]);
  const base = JSON.parse(raw) as Omit<NormalizedIssue, "state" | "closed_by_merged_pr">;
  let state: string | null = null;
  let closedByMergedPr = false;
  let trusted: IssueComment[] = [], excluded = 0;
  if (base.provider === "github" && base.repo && base.number) {
    try {
      const extra = JSON.parse(
        execer("gh", ["issue", "view", String(base.number), "--repo", base.repo, "--json", "state,closedByPullRequestsReferences,comments"]),
      ) as GithubExtra;
      state = typeof extra.state === "string" ? extra.state.toLowerCase() : null;
      closedByMergedPr = Array.isArray(extra.closedByPullRequestsReferences)
        && extra.closedByPullRequestsReferences.some((pr) => pr?.merged === true);
      const all = Array.isArray(extra.comments) ? extra.comments : [];
      trusted = all.filter(isTrustedGithubComment).map((c) => ({ author: c.author!.login!, association: c.authorAssociation!, created_at: typeof c.createdAt === "string" ? c.createdAt : "", body: c.body! }));
      excluded = all.length - trusted.length;
    } catch {
      // gh unavailable or the lookup failed: leave state null, not a claim of "open".
    }
  }
  return withIssueContext({ ...base, state, closed_by_merged_pr: closedByMergedPr }, trusted, excluded);
}
/** CLI/child-process entry point for the future P1 wiring (E-03/E-11): writes  the normalized issue to `outFile` (Intake then reads it from `<runDir>/issue.json`). */
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
