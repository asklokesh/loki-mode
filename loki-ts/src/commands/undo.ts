// UNDO-1: `loki undo <run-id> --plan`. Strictly read-only: verifies the run's receipt, then prints what an undo
// would do (UNDO-2 applies it). Every git call goes through safe_git and is checked against READ_ONLY_GIT, so a
// future edit that adds a mutating subcommand throws here instead of changing the user's repo.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { lokiDir } from "../util/paths.ts";
import { safeGitSpawn } from "../util/safe_git.ts";
import { verifyReceipt, type Verdict } from "../engine10/verify_cmd.ts";
import { readEvents } from "../engine10/events.ts";
import { isEnvelope } from "../features/receipt_dsse.ts";

/** The only git subcommands this file may run. None writes a ref, the index or the working tree. */
export const READ_ONLY_GIT: ReadonlySet<string> = new Set(["rev-parse", "log", "merge-base", "for-each-ref", "symbolic-ref", "rev-list", "cat-file"]);

export type GitRunner = (repoDir: string, args: readonly string[]) => { status: number; stdout: string };

export type CommitState = "on-default" | "pushed" | "local-only";
export interface PlanCommit { sha: string; subject: string; state: CommitState }
export interface UndoPlan {
  run_id: string;
  verdict: Verdict;
  base_sha: string;
  head_sha: string;
  branch: string;
  branch_local: boolean;
  remote_branches: string[];
  default_branch: string | null;
  pr_url: string | null;
  commits: PlanCommit[];
  excluded_other_runs: number;
  branch_extra_commits: number;
  actions: string[];
  warnings: string[];
}

/** A receipt's refs are attacker-influenced (an unsigned receipt is accepted with --allow-unsigned): only a hex object id may reach git. */
const SHA_RE = /^[0-9a-f]{7,64}$/;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const defaultRunner: GitRunner = (repoDir, args) => {
  const r = safeGitSpawn(repoDir, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return { status: r.status ?? 128, stdout: typeof r.stdout === "string" ? r.stdout : "" };
};

export interface UndoDeps {
  git?: GitRunner; // injected in tests to record argv
  repoDir?: string;
  runsRoot?: string;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

function receiptRefs(path: string): { base: string; head: string } | null {
  try {
    let j = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (isEnvelope(j)) j = (JSON.parse(Buffer.from(j.payload, "base64").toString()) as { predicate?: Record<string, unknown> }).predicate ?? {};
    const base = j["base_sha"], head = j["head_sha"];
    return typeof base === "string" && typeof head === "string" && SHA_RE.test(base) && SHA_RE.test(head) ? { base, head } : null;
  } catch { return null; }
}

function prUrlOf(eventsPath: string): string | null {
  let url: string | null = null;
  for (const e of readEvents(eventsPath)) if (e.type === "run.completed" && typeof e.data["pr_url"] === "string" && e.data["pr_url"] !== "") url = e.data["pr_url"] as string;
  return url;
}

/** Build the plan from an already verified receipt's refs. Pure reads. */
export function buildPlan(runId: string, verdict: Verdict, refs: { base: string; head: string }, repoDir: string, prUrl: string | null, git: GitRunner): UndoPlan {
  const g: GitRunner = (dir, args) => {
    if (!READ_ONLY_GIT.has(args[0] ?? "")) throw new Error(`undo plan: refusing non-read-only git subcommand '${args[0]}'`);
    return git(dir, args);
  };
  const warnings: string[] = [];
  const branch = `loki/${runId}`;
  const lines = (s: string): string[] => s.split("\n").map((l) => l.trim()).filter(Boolean);

  let defaultBranch: string | null = null;
  const sym = g(repoDir, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
  if (sym.status === 0 && sym.stdout.trim()) defaultBranch = sym.stdout.trim();
  else for (const c of ["main", "master"]) if (g(repoDir, ["rev-parse", "--verify", "-q", "--end-of-options", `refs/heads/${c}`]).status === 0) { defaultBranch = c; break; }
  if (!defaultBranch) warnings.push("default branch could not be determined; commits are reported as not on the default branch");

  const range = g(repoDir, ["log", "--format=%H%x1f%s%x1f%(trailers:key=Loki-Run,valueonly,separator=%x2c)%x1e", "--end-of-options", `${refs.base}..${refs.head}`]);
  if (range.status !== 0) warnings.push(`cannot list ${refs.base}..${refs.head} in this repository (commits missing locally)`);
  const commits: PlanCommit[] = [];
  let excluded = 0;
  for (const rec of range.stdout.split("\x1e")) {
    const [sha, subject, trailers] = rec.trim().split("\x1f");
    if (!sha) continue;
    if (!(trailers ?? "").split(",").map((t) => t.trim()).includes(runId)) { excluded++; continue; }
    const onDefault = defaultBranch !== null && g(repoDir, ["merge-base", "--is-ancestor", "--end-of-options", sha, defaultBranch]).status === 0;
    let state: CommitState = "local-only";
    if (onDefault) state = "on-default";
    else {
      const remotes = g(repoDir, ["for-each-ref", "--format=%(refname)", "--contains", sha, "refs/remotes"]);
      if (lines(remotes.stdout).some((r) => !r.endsWith("/HEAD"))) state = "pushed";
    }
    commits.push({ sha, subject: subject ?? "", state });
  }

  const branchLocal = g(repoDir, ["rev-parse", "--verify", "-q", "--end-of-options", `refs/heads/${branch}`]).status === 0;
  const remoteBranches = lines(g(repoDir, ["for-each-ref", "--format=%(refname:short)", "refs/remotes"]).stdout).filter((r) => r.endsWith(`/${branch}`));
  let extra = 0;
  if (branchLocal) {
    const n = g(repoDir, ["rev-list", "--count", "--end-of-options", `${refs.head}..refs/heads/${branch}`]);
    extra = n.status === 0 ? Number.parseInt(n.stdout.trim(), 10) || 0 : 0;
    if (extra > 0) warnings.push(`${branch} has ${extra} commit(s) after the run's head; undo would refuse to delete it`);
  }

  const merged = commits.filter((c) => c.state === "on-default"), open = commits.filter((c) => c.state !== "on-default");
  const actions: string[] = [];
  if (commits.length === 0) actions.push("nothing to undo: no commit in the range carries this run's Loki-Run trailer");
  if (merged.length > 0) actions.push(`revert ${merged.length} commit(s) already on ${defaultBranch}, newest first, on a new branch (git revert --no-edit; history is never rewritten)`);
  if (open.length > 0 && branchLocal) actions.push(`delete local branch ${branch} (${open.length} commit(s) not on ${defaultBranch ?? "the default branch"})`);
  if (open.length > 0 && !branchLocal) actions.push(`${open.length} commit(s) not on ${defaultBranch ?? "the default branch"} but local branch ${branch} is gone; nothing to delete`);
  if (remoteBranches.length > 0) actions.push(`remote branch ${remoteBranches.join(", ")} would be left in place (undo never pushes or force-pushes)`);
  if (prUrl) actions.push(`PR ${prUrl} would be closed only with --close-pr`);
  return { run_id: runId, verdict, base_sha: refs.base, head_sha: refs.head, branch, branch_local: branchLocal, remote_branches: remoteBranches, default_branch: defaultBranch, pr_url: prUrl, commits, excluded_other_runs: excluded, branch_extra_commits: extra, actions, warnings };
}

export function renderPlan(p: UndoPlan): string {
  const o: string[] = [
    `run: ${p.run_id}`,
    `receipt: ${p.verdict}`,
    `range: ${p.base_sha.slice(0, 12)}..${p.head_sha.slice(0, 12)}`,
    `branch: ${p.branch} (${p.branch_local ? "exists locally" : "not found locally"})`,
    `default branch: ${p.default_branch ?? "unknown"}`,
    `pr: ${p.pr_url ?? "none recorded"}`,
    `commits (${p.commits.length}, ${p.excluded_other_runs} from other runs excluded):`,
    ...p.commits.map((c) => `  ${c.sha.slice(0, 12)} ${c.state.padEnd(10)} ${c.subject}`),
    "plan:",
    ...p.actions.map((a) => `  - ${a}`),
    ...p.warnings.map((w) => `warning: ${w}`),
    "dry plan only: nothing was changed. Apply is not available yet.",
  ];
  return o.join("\n") + "\n";
}

const USAGE = "Usage: loki undo <run-id> --plan [--json] [--allow-unsigned]\nVerify the run's receipt, then print what undoing the run would do. Changes nothing.\nExit: 0 plan printed, 1 receipt tampered, 2 usage or receipt unchecked, 3 receipt unsigned (refused), 66 unknown run.\n";
const EXIT_BY_VERDICT: Record<Verdict, number> = { VERIFIED: 0, UNSIGNED: 3, TAMPERED: 1, UNCHECKED: 2 };

export async function runUndo(args: readonly string[], deps: UndoDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => void process.stdout.write(s)), err = deps.err ?? ((s: string) => void process.stderr.write(s));
  if (args[0] === "--help" || args[0] === "-h" || args.length === 0) { out(USAGE); return args.length === 0 ? 2 : 0; }
  const flags = new Set(["--plan", "--json", "--allow-unsigned"]);
  const pos = args.filter((a) => !a.startsWith("--")), bad = args.filter((a) => a.startsWith("--") && !flags.has(a));
  if (bad.length > 0 || pos.length !== 1) { err(`loki undo: ${bad.length > 0 ? `unknown flag ${bad[0]}` : "exactly one run-id is required"}\n${USAGE}`); return 2; }
  if (!args.includes("--plan")) { err("loki undo: only --plan is available; applying an undo is not implemented yet\n"); return 2; }
  const runId = pos[0]!;
  if (!RUN_ID_RE.test(runId) || runId.includes("..")) { err(`loki undo: invalid run id '${runId}'\n`); return 2; }
  const runsRoot = deps.runsRoot ?? join(lokiDir(), "runs");
  const receiptPath = join(runsRoot, runId, "receipt.json");
  if (!existsSync(receiptPath)) { err(`loki undo: unknown run '${runId}' (no ${receiptPath})\n`); return 66; }

  const result = await verifyReceipt(receiptPath);
  if (result.verdict === "UNSIGNED" && args.includes("--allow-unsigned")) { /* accepted: integrity intact, attestation absent */ }
  else if (result.verdict !== "VERIFIED") {
    err(`loki undo: receipt verdict ${result.verdict}; refusing to plan\n${result.reasons.map((r) => `  ${r}\n`).join("")}`);
    return EXIT_BY_VERDICT[result.verdict];
  }
  const refs = receiptRefs(receiptPath);
  if (!refs) { err("loki undo: receipt base_sha/head_sha missing or not hex object ids\n"); return 2; }
  const repoDir = deps.repoDir ?? dirname(lokiDir());
  const plan = buildPlan(runId, result.verdict, refs, repoDir, prUrlOf(join(runsRoot, runId, "events.jsonl")), deps.git ?? defaultRunner);
  out(args.includes("--json") ? JSON.stringify(plan, null, 2) + "\n" : renderPlan(plan));
  return 0;
}
