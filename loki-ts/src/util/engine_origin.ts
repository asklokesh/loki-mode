// loki-ts/src/util/engine_origin.ts -- run-marker and origin-URL helpers the v10 supervisor uses
// (moved out of engine10/supervisor.ts to keep the core under its line cap, D29/D33).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteText } from "./atomic.ts";
import { safeGit } from "./safe_git.ts";
import { run, type ShellOpts, type ShellResult } from "./shell.ts";

export function eventsRelPath(runId: string): string {
  return `.loki/runs/${runId}/events.jsonl`;
}
export function writeEngineMarker(repoDir: string, runId: string): void { // EV-1 marker, atomic (temp file in the same dir, then rename)
  const dir = join(repoDir, ".loki");
  atomicWriteText(join(dir, "engine.json"), JSON.stringify({ engine: "v10", run_id: runId, events: eventsRelPath(runId) }) + "\n");
}
export function readOriginUrl(repoDir: string): string | null {
  try {
    const url = safeGit(repoDir, ["config", "--get", "remote.origin.url"]).trim();
    return url || null;
  } catch {
    return null;
  }
}
export function githubRepoFromUrl(url: string | null): string | null {
  const m = url?.match(/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return m?.[1] ?? null;
}
async function sh(argv: readonly string[], opts: ShellOpts): Promise<ShellResult> { try { return await run(argv, opts); } catch { return { stdout: "", stderr: "", exitCode: 127 }; } } // run() throws when argv[0] does not resolve; treated as a failed read
export type PublishMode = "pr" | "fork_pr" | "fork_branch" | "branch" | "local_branch";
export const PUBLISH_REASONS = ["the repository is archived", "the repository is disabled", "pull requests are disabled on this repository", "you have no push access and the repository does not allow forks", "the repository accepts pull requests from collaborators only and you have no push access"] as const; // the closed set readPublish accepts back from the run dir
export interface PublishPlan { mode: PublishMode; reason: string | null; warning: string | null; compare: string | null }
/** R100-022: what the GitHub API says about publishing to this repo. Pure: `repo` is the parsed `gh api repos/<o>/<r>` body. Null when the body carries no permission data (unauthenticated or unreadable), so no claim is made. */
export function classifyPublish(repoSlug: string, repo: Record<string, any>, login: string | null = null): PublishPlan | null {
  const perms = repo["permissions"]; if (!perms || typeof perms !== "object" || typeof perms.push !== "boolean") return null;
  const name = repoSlug.split("/")[1] ?? ""; // compare root: the repo itself when we can push to it, else the caller's fork (default fork name = repo name); null when the fork owner is unknown
  const mk = (mode: PublishMode, reason: string | null, instead: string): PublishPlan => { const compare = mode === "branch" ? `https://github.com/${repoSlug}/compare` : mode === "fork_branch" && login ? `https://github.com/${login}/${name}/compare` : null; return { mode, reason, compare, warning: reason === null ? null : `publish: a PR cannot be opened on ${repoSlug}: ${reason}. The run still does the work and seals; it will ${instead}${compare ? ` (compare URL: ${compare}/<branch>)` : ""}.` }; };
  const push = perms.push === true;
  if (repo["archived"] === true || repo["disabled"] === true) return mk("local_branch", PUBLISH_REASONS[repo["archived"] === true ? 0 : 1], "keep the result on the local branch");
  if (repo["has_pull_requests"] === false) return push ? mk("branch", PUBLISH_REASONS[2], "push the branch to the repository and print a compare URL") : mk("fork_branch", PUBLISH_REASONS[2], "push the branch to your fork and print a compare URL");
  if (push) return mk("pr", null, "");
  if (repo["allow_forking"] === false) return mk("local_branch", PUBLISH_REASONS[3], "keep the result on the local branch");
  if (repo["pull_request_creation_policy"] === "collaborators_only") return mk("fork_branch", PUBLISH_REASONS[4], "push the branch to your fork and print a compare URL");
  return mk("fork_pr", null, "");
}
/** One bounded gh read of the repo (plus the login when a fork is needed); null when it cannot be read or parsed. */
export async function probePublish(originUrl: string, env: Record<string, string>): Promise<PublishPlan | null> {
  const slug = githubRepoFromUrl(originUrl); if (!slug) return null;
  const r = await sh(["gh", "api", `repos/${slug}`], { env, timeoutMs: 10000 }); if (r.exitCode !== 0) return null;
  let repo: Record<string, any>; try { repo = JSON.parse(r.stdout) as Record<string, any>; } catch { return null; }
  const first = classifyPublish(slug, repo); if (first?.mode !== "fork_branch") return first;
  const u = await sh(["gh", "api", "user", "--jq", ".login"], { env, timeoutMs: 10000 }); const login = u.exitCode === 0 && /^[A-Za-z0-9-]+$/.test(u.stdout.trim()) ? u.stdout.trim() : null; // fork owner, needed only for the compare URL
  return classifyPublish(slug, repo, login);
}
/** Adds `publish` to <runDir>/preflight.json only when a PR will not open directly, so a full-access run's file is unchanged. */
export function recordPublish(runDir: string, plan: PublishPlan): void {
  if (plan.mode === "pr") return;
  try { const f = join(runDir, "preflight.json"); const j = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {}; writeFileSync(f, JSON.stringify({ ...j, publish: plan.mode, ...(plan.reason ? { publish_reason: plan.reason } : {}), ...(plan.compare ? { publish_compare: plan.compare } : {}) }) + "\n"); } catch { /* evidence, never a gate */ }
}
/** R100-022: what preflight recorded about publishing, read back from <runDir>/preflight.json. The file is agent-writable (FC-AGENT-WRITABLE-FILE-SIGNED-INTO-RECEIPT), so only closed-set values come back: the mode from PublishMode minus pr and fork_pr, the reason from PUBLISH_REASONS, the compare URL only when it is a github.com compare base for the origin repo name (and the origin owner for mode branch). Null for a normal run, a missing key, an unknown mode or an unreadable file. */
export function readPublish(runDir: string, repoDir: string): { mode: PublishMode; reason?: string; compare?: string } | null {
  try {
    const j = JSON.parse(readFileSync(join(runDir, "preflight.json"), "utf8")) as { publish?: unknown; publish_reason?: unknown; publish_compare?: unknown };
    const mode = (["branch", "fork_branch", "local_branch"] as const).find((m) => m === j.publish); if (!mode) return null;
    const reason = PUBLISH_REASONS.find((r) => r === j.publish_reason);
    const slug = githubRepoFromUrl(readOriginUrl(repoDir)), cm = typeof j.publish_compare === "string" ? j.publish_compare.match(/^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([^/\s]+)\/compare$/) : null;
    const compare = cm && slug && cm[2] === slug.split("/")[1] && (mode === "fork_branch" || cm[1] === slug.split("/")[0]) ? cm[0] : undefined;
    return { mode, ...(reason ? { reason } : {}), ...(compare ? { compare } : {}) };
  } catch { return null; }
}
/** R100-022: the receipt body's additive `publish` block. Empty for a full-access run, so its receipt_sha256 is unchanged. */
export const publishReceiptBlock = (runDir: string, repoDir: string): { publish?: { mode: string; reason?: string; compare?: string } } => { const p = readPublish(runDir, repoDir); return p ? { publish: p } : {}; };
/** R100-022: when preflight recorded that a PR cannot open here, say what the run delivers instead (the branch, plus a compare URL when the owner is known). Empty for a normal run or an unreadable file. */
export function publishFallback(runDir: string, repoDir: string, branch: string, base?: string | null): string {
  const p = readPublish(runDir, repoDir);
  if (!p) return "";
  const cmp = p.compare ? ` Compare: ${p.compare}/${base ? `${base}...` : ""}${branch}` : "";
  return ` | publish expectation set at intake (${p.mode}${p.reason ? `: ${p.reason}` : ""}). The work is on branch ${branch}.${cmp}`;
}
