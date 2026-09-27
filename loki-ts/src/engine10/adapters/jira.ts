// loki-ts/src/engine10/adapters/jira.ts
//
// E-27: Jira read adapter (ENGINE.md section 16, section 13). Wraps
// autonomy/issue-providers.sh's fetch_jira_issue (:321) for a normalized
// issue. Read-only: no openPr, no notify, no write path anywhere in this
// file.
//
// Contract-gap note: adapters/types.ts (E-25) is not on main yet, so Adapter
// and NormalizedIssue are declared locally here per the slice card. Switch
// both to the shared `../adapters/types.ts` exports at merge. NormalizedIssue
// here types `number` as a string (a Jira key, e.g. "PROJ-123"), unlike
// fetch_issue.ts's numeric field for GitHub/GitLab; reconcile at merge too.
//
// exec is injected so tests run with no curl/network dependency (fakes).
import { execFileSync } from "node:child_process";

export interface Adapter {
  name: "github" | "gitlab" | "jira" | "slack";
  matches?(ref: string): boolean;
  fetchIssue?(ref: string): Promise<NormalizedIssue>;
  openPr?(req: unknown): Promise<{ url: string; draft: boolean }>;
  notify?(summary: unknown): Promise<void>;
}

export interface NormalizedIssue {
  provider: string;
  number: string;
  title: string;
  body: string;
  labels: string[];
  author: string;
  url: string;
  created_at: string;
  repo: string;
}

export type Execer = (cmd: string, args: string[]) => string;

const ISSUE_PROVIDERS_SH = new URL("../../../../autonomy/issue-providers.sh", import.meta.url).pathname;

// A Jira key ("PROJ-123") or a /browse/PROJ-123 URL, matching
// parse_issue_reference's own jira detection (issue-providers.sh:150-157).
const JIRA_KEY_RE = /^[A-Z][A-Z0-9]*-[0-9]+$/;
const JIRA_URL_RE = /\/browse\/([A-Z][A-Z0-9]*-[0-9]+)/;

export function matchesJira(ref: string): boolean {
  return JIRA_KEY_RE.test(ref) || JIRA_URL_RE.test(ref);
}

function defaultExec(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", env: process.env });
}

/** Fetches and normalizes one Jira issue. Never opens a PR, never notifies:
 *  read-only by construction (this function is the adapter's only export
 *  that talks to Jira). */
export function fetchIssue(ref: string, execer: Execer = defaultExec): NormalizedIssue {
  const raw = execer("bash", [
    "-c",
    `source "${ISSUE_PROVIDERS_SH}" && parse_issue_reference "$1" && fetch_jira_issue`,
    "--",
    ref,
  ]);
  return JSON.parse(raw) as NormalizedIssue;
}

/** execer defaults to the real shell; tests pass a fake so no curl/network
 *  call is ever made. */
export function createJiraAdapter(execer: Execer = defaultExec): Adapter {
  return {
    name: "jira",
    matches: matchesJira,
    fetchIssue: async (ref) => fetchIssue(ref, execer),
  };
}

export const jiraAdapter: Adapter = createJiraAdapter();
