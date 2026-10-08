// UNDO-2: carry out the UNDO-1 plan. Reverts commits already on the default branch on a NEW branch built in a throwaway
// linked worktree (so the user's branch, index and working tree are never touched), and deletes an unmerged local run
// branch by compare-and-delete of the ref. History is never rewritten, nothing is pushed, no force flag is ever passed.
// Every precondition is checked before the first mutation; a pre-undo ref keeps the deleted tip reachable.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { durableWriteThenRename } from "../util/atomic.ts";
import { safeGitSpawn } from "../util/safe_git.ts";
import type { GitRunner, UndoPlan } from "./undo.ts";

export type ApplyGit = (repoDir: string, args: readonly string[]) => { status: number; stdout: string; stderr: string };

/** Subcommands apply may run. The mutating ones are only worktree, revert and update-ref, each used in a fixed shape below. */
export const APPLY_GIT: ReadonlySet<string> = new Set(["rev-parse", "status", "symbolic-ref", "rev-list", "worktree", "revert", "update-ref"]);
const FORBIDDEN_ARG = /^(--force|-f|-D|--hard|--force-with-lease|--mirror|--delete)$/;

const defaultApplyGit: ApplyGit = (repoDir, args) => {
  const r = safeGitSpawn(repoDir, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { status: r.status ?? 128, stdout: typeof r.stdout === "string" ? r.stdout : "", stderr: typeof r.stderr === "string" ? r.stderr : "" };
};

export interface ApplyOpts {
  repoDir: string; undoDir: string; yes: boolean; closePr: boolean;
  read: GitRunner; git?: ApplyGit; confirm?: (prompt: string) => Promise<boolean>;
  closePrFn?: (url: string) => { ok: boolean; message: string };
  out: (s: string) => void; err: (s: string) => void;
}

interface Step { step: string; ok: boolean; detail: string }

// gh needs PATH, HOME and its own auth (token or config dir); nothing else from the parent env reaches the child.
const GH_ENV_KEYS = ["PATH", "HOME", "GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_CONFIG_DIR", "XDG_CONFIG_HOME", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];

export function ghCloseEnv(parent: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of GH_ENV_KEYS) { const v = parent[k]; if (typeof v === "string") env[k] = v; }
  return env;
}

function defaultClosePr(url: string): { ok: boolean; message: string } {
  const r = spawnSync("gh", ["pr", "close", url], { encoding: "utf8", env: ghCloseEnv(process.env) });
  return { ok: r.status === 0, message: (r.stderr || r.stdout || r.error?.message || "").trim() };
}

async function defaultConfirm(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await rl.question(`${prompt} [y/N] `)).trim()); } finally { rl.close(); }
}

export async function applyUndo(plan: UndoPlan, o: ApplyOpts): Promise<number> {
  const rawGit = o.git ?? defaultApplyGit;
  const git: ApplyGit = (dir, args) => {
    const sub = args.find((a) => !a.startsWith("-")) ?? "";
    if (!APPLY_GIT.has(sub)) throw new Error(`undo apply: refusing git subcommand '${sub}'`);
    if (args.some((a) => FORBIDDEN_ARG.test(a))) throw new Error(`undo apply: refusing forbidden git flag in ${args.join(" ")}`);
    return rawGit(dir, args);
  };
  const steps: Step[] = [];
  const recordPath = join(o.undoDir, `${plan.run_id}.json`);
  const started = new Date().toISOString();
  let preUndo: Record<string, string | null> = {};
  const finish = (status: "applied" | "failed" | "refused" | "nothing", rc: number, reason?: string): number => {
    try {
      durableWriteThenRename(recordPath, JSON.stringify({ run_id: plan.run_id, status, reason: reason ?? null, started_at: started, finished_at: new Date().toISOString(), pre_undo: preUndo, plan: { branch: plan.branch, commits: plan.commits.map((c) => ({ sha: c.sha, state: c.state })), actions: plan.actions }, steps }, null, 2) + "\n");
    } catch (e) { o.err(`loki undo: could not write ${recordPath}: ${(e as Error).message}\n`); }
    if (reason) o.err(`loki undo: ${status}: ${reason}\n`);
    return rc;
  };
  const refuse = (reason: string): number => finish("refused", 2, reason);

  const HEX = /^[0-9a-f]{40,64}$/;
  if (plan.commits.some((c) => !HEX.test(c.sha))) return refuse("plan holds a commit id that is not a full hex object id");
  if (plan.commits.length === 0) { o.out("nothing to undo: no commit in the range carries this run's Loki-Run trailer\n"); return finish("nothing", 0); }
  const merged = plan.commits.filter((c) => c.state === "on-default"), open = plan.commits.filter((c) => c.state !== "on-default");
  if (!plan.default_branch) return refuse("default branch could not be determined");
  if (plan.warnings.some((w) => w.startsWith("cannot list"))) return refuse("the run's commits are missing from this repository");

  // Preconditions: all reads, before the first mutation.
  const dirty = git(o.repoDir, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty.status !== 0) return refuse("cannot read the working tree status");
  if (dirty.stdout.trim() !== "") return refuse("the working tree has uncommitted changes to tracked files; commit or stash them first");
  const cur = git(o.repoDir, ["symbolic-ref", "-q", "--short", "HEAD"]).stdout.trim();
  const sha = (ref: string): string | null => { const r = git(o.repoDir, ["rev-parse", "--verify", "-q", "--end-of-options", ref]); return r.status === 0 ? r.stdout.trim() : null; };
  const branchTip = plan.branch_local ? sha(`refs/heads/${plan.branch}`) : null;
  if (open.length > 0 && plan.branch_local) {
    if (plan.branch_extra_commits > 0) return refuse(`${plan.branch} has ${plan.branch_extra_commits} commit(s) after the run's head (not this run's work); refusing to delete it`);
    if (cur === plan.branch) return refuse(`${plan.branch} is the checked-out branch; switch to another branch first (undo never touches your current branch)`);
    const wts = git(o.repoDir, ["worktree", "list", "--porcelain"]).stdout;
    if (wts.split("\n").some((l) => l === `branch refs/heads/${plan.branch}`)) return refuse(`${plan.branch} is checked out in another worktree`);
    if (branchTip === null) return refuse(`cannot resolve ${plan.branch}`);
  }
  const undoBranch = `loki/undo-${plan.run_id}`;
  if (merged.length > 0 && sha(`refs/heads/${undoBranch}`) !== null) return refuse(`branch ${undoBranch} already exists; an undo of this run was already applied or attempted`);
  const startSha = sha(plan.default_branch);
  if (merged.length > 0 && startSha === null) return refuse(`cannot resolve ${plan.default_branch}`);
  preUndo = { head: sha("HEAD"), current_branch: cur || null, default_branch_tip: startSha, run_branch_tip: branchTip, undo_ref: branchTip ? `refs/loki/undo/${plan.run_id}/branch` : null };

  const text = plan.actions.map((a) => `  - ${a}`).join("\n");
  o.out(`undo of run ${plan.run_id}:\n${text}\n`);
  if (!o.yes) {
    const ok = await (o.confirm ?? defaultConfirm)("Apply this undo?");
    if (!ok) { o.out("dry run: nothing was changed (pass --yes to apply without a prompt)\n"); return 0; }
  }

  // Pre-undo ref: the deleted tip stays reachable, so the undo itself can be undone.
  if (branchTip && open.length > 0) {
    const r = git(o.repoDir, ["update-ref", preUndo["undo_ref"]!, branchTip]);
    steps.push({ step: "record-pre-undo-ref", ok: r.status === 0, detail: preUndo["undo_ref"]! });
    if (r.status !== 0) return finish("failed", 1, `could not record the pre-undo ref: ${r.stderr.trim()}`);
  }

  if (merged.length > 0) {
    const wt = mkdtempSync(join(tmpdir(), "loki-undo-wt-"));
    let addedBranch = false, failure: string | null = null;
    try {
      const add = git(o.repoDir, ["worktree", "add", "-q", "-b", undoBranch, wt, startSha!]);
      if (add.status !== 0) failure = `could not create the undo worktree: ${add.stderr.trim()}`;
      else {
        addedBranch = true;
        const rev = git(wt, ["revert", "--no-edit", "--end-of-options", ...merged.map((c) => c.sha)]);
        if (rev.status !== 0) { git(wt, ["revert", "--abort"]); failure = `git revert failed (${rev.stderr.trim().split("\n")[0] ?? "conflict"}); nothing was changed`; }
      }
    } finally {
      const rm = existsSync(wt) ? git(o.repoDir, ["worktree", "remove", wt]) : { status: 0, stdout: "", stderr: "" };
      if (rm.status !== 0 && existsSync(wt)) rmSync(wt, { recursive: true, force: true }); // our own mkdtemp dir, exact path
      git(o.repoDir, ["worktree", "prune"]);
    }
    if (failure) {
      if (addedBranch) { const tip = sha(`refs/heads/${undoBranch}`); if (tip) git(o.repoDir, ["update-ref", "-d", `refs/heads/${undoBranch}`, tip]); }
      steps.push({ step: "revert", ok: false, detail: failure });
      return finish("failed", 1, failure);
    }
    steps.push({ step: "revert", ok: true, detail: `${merged.length} commit(s) reverted on ${undoBranch}` });
    o.out(`reverted ${merged.length} commit(s) on new branch ${undoBranch} (merge or open a PR from it when ready)\n`);
  }

  if (open.length > 0 && plan.branch_local) {
    const r = git(o.repoDir, ["update-ref", "-d", `refs/heads/${plan.branch}`, branchTip!]); // compare-and-delete: fails if the branch moved
    steps.push({ step: "delete-branch", ok: r.status === 0, detail: plan.branch });
    if (r.status !== 0) return finish("failed", 1, `could not delete ${plan.branch}: ${r.stderr.trim()}`);
    o.out(`deleted local branch ${plan.branch} (tip kept at ${preUndo["undo_ref"]})\n`);
  }

  if (o.closePr) {
    if (!plan.pr_url) steps.push({ step: "close-pr", ok: true, detail: "no PR recorded for this run" });
    else {
      const r = (o.closePrFn ?? defaultClosePr)(plan.pr_url);
      steps.push({ step: "close-pr", ok: r.ok, detail: r.ok ? plan.pr_url : r.message });
      if (!r.ok) return finish("failed", 1, `could not close ${plan.pr_url}: ${r.message}`);
      o.out(`closed ${plan.pr_url}\n`);
    }
  }
  o.out(`undo recorded at ${recordPath}\n`);
  return finish("applied", 0);
}
