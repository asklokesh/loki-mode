// loki-ts/src/util/base_guard.ts -- FC-15: the one place a run's base is resolved and checked.
// A run must never judge "already done" (or diff, or seal) against Loki's own unmerged work.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function git(repoDir: string, args: string[], timeout = 20000): string | null {
  try {
    return execFileSync("git", args, { cwd: repoDir, encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "ignore"], timeout }).trim();
  } catch { return null; }
}
const exists = (repoDir: string, ref: string): boolean => git(repoDir, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]) !== null;

export interface ResolvedBase { ref: string; source: "flag" | "remote-default" | "local-default" }

/** Base precedence: explicit (LOKI_E10_BASE) fetched from origin, else origin's default branch, else a local main/master.
 *  Never a loki/* branch and never the working HEAD. Fetches best effort (LOKI_E10_NO_FETCH=1 skips). Null: nothing resolvable. */
export function resolveBase(repoDir: string, explicit: string | undefined = process.env.LOKI_E10_BASE): ResolvedBase | null {
  const fetch = (b: string): void => { if (process.env.LOKI_E10_NO_FETCH !== "1" && git(repoDir, ["remote", "get-url", "origin"]) !== null) git(repoDir, ["fetch", "-q", "origin", b], 30000); };
  const ex = explicit?.trim();
  if (ex && !ex.startsWith("loki/")) {
    fetch(ex);
    for (const c of [`origin/${ex}`, ex]) if (exists(repoDir, c)) return { ref: c, source: "flag" };
    return null;
  }
  const head = git(repoDir, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
  const names = [head ? head.replace(/^origin\//, "") : "", "main", "master"].filter((n) => n !== "");
  for (const n of names) {
    fetch(n);
    if (exists(repoDir, `origin/${n}`)) return { ref: `origin/${n}`, source: "remote-default" };
  }
  for (const n of names) if (exists(repoDir, n)) return { ref: n, source: "local-default" };
  return null;
}

export interface UnmergedLokiWork { runId: string | null; branch: string | null; commits: number; base: string }

const ok = (repoDir: string, args: string[]): boolean => git(repoDir, args) !== null;

/** Loki's own work reachable from HEAD but not on the base: a prior run receipt's head_sha (the run record), or the checked-out
 *  loki/* branch carrying commits ahead of base. Null when HEAD is clean of it or no base resolves (cannot judge, never refuse). */
export function unmergedLokiWork(repoDir: string, base: ResolvedBase | null = resolveBase(repoDir)): UnmergedLokiWork | null {
  if (!base) return null;
  const ahead = Number(git(repoDir, ["rev-list", "--count", `${base.ref}..HEAD`]) ?? "0") || 0;
  if (ahead === 0) return null;
  const branch = git(repoDir, ["symbolic-ref", "-q", "--short", "HEAD"]);
  const runsDir = join(repoDir, ".loki", "runs");
  if (existsSync(runsDir)) {
    for (const id of readdirSync(runsDir)) {
      try {
        const rc = JSON.parse(readFileSync(join(runsDir, id, "receipt.json"), "utf8")) as { head_sha?: unknown };
        const sha = typeof rc.head_sha === "string" ? rc.head_sha : "";
        if (/^[0-9a-f]{40}$/.test(sha) && !ok(repoDir, ["merge-base", "--is-ancestor", sha, base.ref]) && ok(repoDir, ["merge-base", "--is-ancestor", sha, "HEAD"])) return { runId: id, branch, commits: ahead, base: base.ref };
      } catch { /* no receipt: not a run record */ }
    }
  }
  if (branch !== null && branch.startsWith("loki/")) return { runId: branch.slice(5), branch, commits: ahead, base: base.ref };
  return null;
}

export function unmergedWorkReason(w: UnmergedLokiWork): string {
  return `this checkout${w.branch ? ` (branch ${w.branch})` : ""} already has Loki run ${w.runId ?? "?"}'s unmerged work (${w.commits} commit(s) not on ${w.base}); resume or review it, or check out ${w.base} and rerun. Refusing to judge the task against Loki's own unmerged work`;
}
