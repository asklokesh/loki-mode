// loki-ts/src/engine10/adapters/github.ts -- E-25 GitHub adapter (ENGINE.md sections 13/15).
// fetchIssue reuses fetch_issue.ts; openPr reuses engine10-push.sh through argv only -- every
// field of the request is one argv element, never interpolated into a shell string -- so a hostile
// issue title can never reach a shell.
import { spawnSync } from "node:child_process";
import type { Execer, NormalizedIssue } from "../fetch_issue.ts";
import { fetchIssue } from "../fetch_issue.ts";
import type { Adapter, PrRequest, PrResult } from "./types.ts";
/** Injectable for tests; defaults to the real script next to this checkout
 *  (same relative depth as stages/pr.ts's DEFAULT_PUSH_SH). */
export const DEFAULT_PUSH_SH = new URL("../../../../autonomy/lib/engine10-push.sh", import.meta.url).pathname;
// Mirrors autonomy/issue-providers.sh parse_issue_reference's github branch
// (:118-:127): a github.com issue URL, "owner/repo#123", or a bare "#123"/"123".
const GITHUB_URL_RE = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+(?:$|[/?#])/;
const OWNER_REPO_RE = /^[^/\s#]+\/[^/\s#]+#\d+$/;
const BARE_NUMBER_RE = /^#?\d+$/;
function matches(ref: string): boolean {
  return GITHUB_URL_RE.test(ref) || OWNER_REPO_RE.test(ref) || BARE_NUMBER_RE.test(ref);
}
const PR_URL_RE = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/;
function lastNonEmptyLine(s: string): string {
  const lines = s.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  return lines[lines.length - 1] ?? "";
}
export interface GithubAdapterOptions {
  /** Injectable for tests; see fetch_issue.ts's Execer. */
  execer?: Execer;
  /** Injectable for tests; defaults to DEFAULT_PUSH_SH. */
  pushScriptPath?: string;
}
async function openPr(req: PrRequest, opts: GithubAdapterOptions): Promise<PrResult> {
  const scriptPath = opts.pushScriptPath ?? DEFAULT_PUSH_SH;
  const argv = ["push-pr", req.repoDir, req.branch, req.title, req.bodyFile];
  if (req.draft) argv.push("--draft");
  const result = spawnSync("bash", [scriptPath, ...argv], { env: process.env, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`engine10-push.sh push-pr failed (exit ${result.status}): ${(result.stderr ?? "").trim()}`);
  }
  const url = lastNonEmptyLine(result.stdout ?? "");
  if (!PR_URL_RE.test(url)) {
    throw new Error(`engine10-push.sh push-pr printed no valid PR URL (got: ${url || "(empty)"})`);
  }
  return { url, draft: req.draft };
}
/** Factory so tests can inject an execer and a stub push script; production
 *  callers use the pre-built `githubAdapter` below. */
export function makeGithubAdapter(opts: GithubAdapterOptions = {}): Adapter {
  return {
    name: "github",
    matches,
    fetchIssue: async (ref: string): Promise<NormalizedIssue> => fetchIssue(ref, opts.execer),
    openPr: (req: PrRequest) => openPr(req, opts),
  };
}
export const githubAdapter: Adapter = makeGithubAdapter();
