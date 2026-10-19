// loki-ts/src/util/base_guard.ts -- FC-15: the one place the PR target is resolved and a claim is checked against it.
// A run starts from the base the user asked for; only the ALREADY_SATISFIED claim must rest on the PR target, never on
// commits that exist only in target..HEAD (Loki's own unmerged work or the user's own).
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { listRunIds } from "../commands/run_status.ts";
import { safeGit } from "./safe_git.ts";

function git(repoDir: string, args: string[], timeout = 20000, extraEnv: Record<string, string> = {}): string | null {
  try {
    return safeGit(repoDir, args, { env: { ...process.env, ...extraEnv }, timeout, allowToken: args[0] === "fetch" }).trim(); // fetch may need credentials; everything else is token-free
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
  for (const id of listRunIds(runsDir)) {
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

export interface StackedSkip { branch: string; target: string; commits: number; base_sha: string; message: string }

/** FC-STACKED-ON-LOKI-RUN: when every commit in target..HEAD carries the Loki-Run trailer, HEAD is an earlier run's unaccepted output and a
 *  new run must not inherit it. Returns the PR target tip to branch from instead (not the merge-base: a squash-merged run must see its work on the target). Null (keep HEAD as the base) when the range is empty,
 *  holds any commit without the trailer (the operator built on it deliberately), the target does not resolve, or the target tip cannot be read. */
export function stackedOnLokiRun(repoDir: string, target: ResolvedBase | null = resolveBase(repoDir)): StackedSkip | null {
  if (!target || process.env.LOKI_PR_BASE) return null; // a stacked slice (loki issues run) builds on its parent's run branch on purpose
  const branch = git(repoDir, ["symbolic-ref", "-q", "--short", "HEAD"]);
  if (!branch || !/^loki\/e10-/.test(branch)) return null; // only an engine run branch (loki/${runId}, supervisor.ts); never main (fast-forward accept), loki/epic-*, loki/group-*, loki/unit-* or a user branch
  const log = git(repoDir, ["log", `${target.ref}..HEAD`, "--format=%x01%(trailers:key=Loki-Run,valueonly)"]);
  if (log === null) return null;
  const chunks = log.split("\x01").slice(1);
  if (chunks.length === 0 || chunks.some((c) => c.trim() === "")) return null;
  const mb = git(repoDir, ["rev-parse", "--verify", "-q", `${target.ref}^{commit}`]);
  if (!mb || !/^[0-9a-f]{40}$/.test(mb)) return null;
  return { branch, target: target.ref, commits: chunks.length, base_sha: mb, message: `skipped ${chunks.length} unaccepted Loki commit(s) on ${branch}; merge them first to build on them; base moved to the ${target.ref} tip, which may include upstream commits not yet pulled locally` };
}

/** Start-line fragment naming the PR target and the base the run starts from (no network). Agrees with intake via stackedOnLokiRun. */
export function baseLine(repoDir: string): string {
  const t = resolveBase(repoDir, undefined, false);
  const sk = stackedOnLokiRun(repoDir, t);
  const b = git(repoDir, ["symbolic-ref", "-q", "--short", "HEAD"]) ?? "detached HEAD";
  return `PR target: ${t ? t.ref : "unresolved"}, base: ${sk ? `${sk.target} (${sk.message})` : b}`;
}

/** The recorded note from an intake stage.completed data object (null when absent). */
export function noteOf(intake: Record<string, unknown> | undefined): string | null {
  const m = (intake?.["unmerged_loki_work"] as { message?: unknown } | undefined)?.message ?? (intake?.["stacked_loki_skip"] as { message?: unknown } | undefined)?.message;
  return typeof m === "string" && m !== "" ? m : null;
}

/** FC-ZERO-ON-BASE: true when dependency dirs under `pkgDir` can resolve into `repoDir` (a workspace symlink in node_modules or @scope/*, a .venv .pth, *.egg-link or direct_url.json naming the repo), so a base rerun that links them would run head sources. Anything unreadable counts as true (fail closed). */
export function depsSeeHead(pkgDir: string, repoDir: string): boolean {
  const root = realpathSync(repoDir), inside = (p: string): boolean => { try { const r = realpathSync(p); return r === root || r.startsWith(root + "/"); } catch { return true; } };
  const link = (p: string): boolean => lstatSync(p).isSymbolicLink() && inside(p);
  try {
    const nm = join(pkgDir, "node_modules");
    for (const e of readdirSync(nm).map((n) => join(nm, n))) if (link(e) || (!lstatSync(e).isSymbolicLink() && lstatSync(e).isDirectory() && readdirSync(e).some((s) => link(join(e, s))))) return true;
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") return true; }
  try {
    const walk = (d: string, depth: number): boolean => readdirSync(d, { withFileTypes: true }).some((x) => (x.isDirectory() && depth < 4 && walk(join(d, x.name), depth + 1)) || (/\.pth$|\.egg-link$|^direct_url\.json$/.test(x.name) && readFileSync(join(d, x.name), "utf8").includes(root)));
    return walk(join(pkgDir, ".venv"), 0);
  } catch (e) { return (e as NodeJS.ErrnoException).code !== "ENOENT"; }
}
