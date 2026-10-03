// loki-ts/src/util/base_guard.ts -- FC-15: the one place the PR target is resolved and a claim is checked against it.
// A run starts from the base the user asked for; only the ALREADY_SATISFIED claim must rest on the PR target, never on
// commits that exist only in target..HEAD (Loki's own unmerged work or the user's own).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function git(repoDir: string, args: string[], timeout = 20000, extraEnv: Record<string, string> = {}): string | null {
  try {
    return execFileSync("git", args, { cwd: repoDir, encoding: "utf8", env: { ...process.env, ...extraEnv }, stdio: ["ignore", "pipe", "ignore"], timeout }).trim();
  } catch { return null; }
}
const exists = (repoDir: string, ref: string): boolean => git(repoDir, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]) !== null;

export interface ResolvedBase { ref: string; source: "flag" | "remote-default" | "local-default" }

/** PR-target precedence: explicit (LOKI_E10_BASE) fetched from origin, else origin's default branch, else a local main/master.
 *  Never a loki/* branch and never the working HEAD (this is the PR target, not the run's base). Fetches best effort, one 10s non-interactive fetch per resolved name
 *  (LOKI_E10_NO_FETCH=1 skips). Null: nothing resolvable. */
export function resolveBase(repoDir: string, explicit: string | undefined = process.env.LOKI_E10_BASE, fetchRemote = true): ResolvedBase | null {
  const fetch = (b: string): void => {
    if (!fetchRemote || process.env.LOKI_E10_NO_FETCH === "1" || git(repoDir, ["remote", "get-url", "origin"]) === null) return;
    git(repoDir, ["fetch", "-q", "origin", b], 10000, { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" });
  };
  const ex = explicit?.trim();
  if (ex && !ex.startsWith("loki/")) {
    fetch(ex);
    for (const c of [`origin/${ex}`, ex]) if (exists(repoDir, c)) return { ref: c, source: "flag" };
    return null;
  }
  const head = git(repoDir, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
  const names = [head ? head.replace(/^origin\//, "") : "", "main", "master"].filter((n) => n !== "");
  for (const n of names) if (exists(repoDir, `origin/${n}`) || exists(repoDir, n)) {
    fetch(n);
    if (exists(repoDir, `origin/${n}`)) return { ref: `origin/${n}`, source: "remote-default" };
  }
  for (const n of names) if (exists(repoDir, n)) return { ref: n, source: "local-default" };
  return null;
}

export interface UnmergedEvidence { branch: string | null; lokiOwn: boolean; commits: number; target: string; paths: string[] }

const ok = (repoDir: string, args: string[]): boolean => git(repoDir, args) !== null;

/** True when the commits on HEAD that are not on the target are really Loki's: one carries the engine's "Loki-Run:" commit
 *  trailer (stages/seal.ts), or a local receipt sealed head_sha != base_sha with commits of its own there. A branch merely
 *  named loki/*, or a zero-commit receipt (head_sha is the user's own tip), does not count. */
function lokiCommitsOnHead(repoDir: string, target: string): boolean {
  if ((git(repoDir, ["log", `${target}..HEAD`, "--format=%(trailers:key=Loki-Run,valueonly)"]) ?? "").trim() !== "") return true;
  const runsDir = join(repoDir, ".loki", "runs");
  if (!existsSync(runsDir)) return false;
  for (const id of readdirSync(runsDir)) {
    try {
      const rc = JSON.parse(readFileSync(join(runsDir, id, "receipt.json"), "utf8")) as { head_sha?: unknown; base_sha?: unknown };
      const sha = typeof rc.head_sha === "string" ? rc.head_sha : "", from = typeof rc.base_sha === "string" ? rc.base_sha : "";
      if (!/^[0-9a-f]{40}$/.test(sha) || !/^[0-9a-f]{40}$/.test(from) || sha === from) continue;
      if (ok(repoDir, ["merge-base", "--is-ancestor", sha, "HEAD"]) && !ok(repoDir, ["merge-base", "--is-ancestor", sha, target])
        && (Number(git(repoDir, ["rev-list", "--count", sha, `^${from}`, `^${target}`]) ?? "0") || 0) > 0) return true;
    } catch { /* no receipt: not a run record */ }
  }
  return false;
}

/** The ALREADY_SATISFIED claim must rest on the PR target. Null when none of the evidence paths differs between the target
 *  and HEAD (or no target resolves: cannot judge, keep the claim). Otherwise the evidence lives only in target..HEAD and the
 *  claim must not stand. startBranch is the branch the user started on (intake has since moved HEAD to the run branch); lokiOwn says those commits are really Loki's (a Loki-Run trailer or a receipt with commits). */
export function unmergedEvidence(repoDir: string, evidencePaths: string[], startBranch: string | null, target: ResolvedBase | null = resolveBase(repoDir)): UnmergedEvidence | null {
  if (!target) return null;
  const changed = new Set((git(repoDir, ["diff", "--name-only", target.ref, "HEAD"]) ?? "").split("\n").filter((l) => l !== ""));
  const paths = [...new Set(evidencePaths)].filter((p) => changed.has(p));
  if (paths.length === 0) return null;
  const branch = startBranch;
  const lokiOwn = lokiCommitsOnHead(repoDir, target.ref);
  return { branch, lokiOwn, commits: Number(git(repoDir, ["rev-list", "--count", `${target.ref}..HEAD`]) ?? "0") || 0, target: target.ref, paths };
}

/** Harness-owned informational reason (L5): never a refusal, never VERIFIED. */
export function unmergedEvidenceNote(u: UnmergedEvidence): string {
  return `work exists on ${u.branch ?? "HEAD"}, not on ${u.target} (${u.commits} commit(s)); open or resume it. The task is not reported as already satisfied because its evidence (${u.paths.slice(0, 3).join(", ")}${u.paths.length > 3 ? ` (+${u.paths.length - 3} more)` : ""}) is not on the PR target`;
}

/** Start-line fragment naming the PR target and the base the run starts from (no network). */
export function baseLine(repoDir: string): string {
  const t = resolveBase(repoDir, undefined, false);
  const b = git(repoDir, ["symbolic-ref", "-q", "--short", "HEAD"]) ?? "detached HEAD";
  return `PR target: ${t ? t.ref : "unresolved"}, base: ${b}`;
}

/** The recorded note from an intake stage.completed data object (null when absent). */
export function noteOf(intake: Record<string, unknown> | undefined): string | null {
  const m = (intake?.["unmerged_loki_work"] as { message?: unknown } | undefined)?.message;
  return typeof m === "string" && m !== "" ? m : null;
}
