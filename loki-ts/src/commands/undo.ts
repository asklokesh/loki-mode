// UNDO-1: `loki undo <run-id> --plan`. Strictly read-only: verifies the run's receipt, then prints what an undo
// would do (UNDO-2 applies it). Every git call goes through safe_git and is checked against READ_ONLY_GIT, so a
// future edit that adds a mutating subcommand throws here instead of changing the user's repo.
import { suggestWord } from "../cli/registry.ts";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { lokiDir } from "../util/paths.ts";
import { safeGitSpawn } from "../util/safe_git.ts";
import { verifyReceipt, type Verdict } from "../engine10/verify_cmd.ts";
import { readEvents } from "../engine10/events.ts";
import { isEnvelope, runIdGuard } from "../features/receipt_dsse.ts";
import type { ApplyGit } from "./undo_apply.ts";
import { formatAge } from "./queue.ts";

/** The only git subcommands this file may run. None writes a ref, the index or the working tree. */
export const READ_ONLY_GIT: ReadonlySet<string> = new Set(["rev-parse", "log", "merge-base", "for-each-ref", "symbolic-ref", "rev-list", "cat-file", "show"]);

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
  diffstat?: string; // --dry-run only: what reverting the plan's commits would remove
}

/** A receipt's refs are attacker-influenced (an unsigned receipt is accepted with --allow-unsigned): only a hex object id may reach git. */
const SHA_RE = /^[0-9a-f]{7,64}$/;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** True when `id` is a safe single-segment run id (no separators, no leading dot, no ".."). */
export const isRunId = (id: string): boolean => RUN_ID_RE.test(id) && !id.includes("..");

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
  applyGit?: ApplyGit; // UNDO-2: mutating runner, injected in tests to record argv
  confirm?: (prompt: string) => Promise<boolean>;
  closePr?: (url: string) => { ok: boolean; message: string };
  undoDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date; // --list age column
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
    ...(p.diffstat !== undefined ? ["diffstat that undo would revert:", p.diffstat === "" ? "  (empty)" : p.diffstat.replace(/\s+$/, "").replace(/^/gm, "  ")] : []),
    (p.diffstat !== undefined ? "dry run" : "plan only") + ": nothing was changed. To apply: LOKI_UNDO=1 loki undo " + p.run_id,
  ];
  return o.join("\n") + "\n";
}

/** --dry-run: per-commit `git show --stat` (read-only) for every commit the plan would revert or drop. */
export function dryRunDiffstat(p: UndoPlan, repoDir: string, git: GitRunner): string {
  return p.commits.map((c) => {
    const r = git(repoDir, ["show", "--stat", "--format=", "--end-of-options", c.sha]);
    return `${c.sha.slice(0, 12)} ${c.subject}\n${r.stdout.replace(/\s+$/, "")}`;
  }).join("\n");
}

const USAGE = "Usage: loki undo --list   (recent runs that can be undone: run id, verdict, files changed, age; newest first)\n       loki undo <run-id> --plan [--json] [--allow-unsigned]\n       loki undo <run-id> --dry-run [--json] [--allow-unsigned]   (plan plus the diffstat undo would revert; changes nothing)\n       LOKI_UNDO=1 loki undo <run-id> [--yes] [--close-pr]\nVerify the run's receipt, then print (--plan) or carry out (apply) what undoing the run does.\nApply reverts commits already on the default branch on a new branch and deletes an unmerged local run branch; it never rewrites history or force-pushes.\nWithout --yes apply asks first and, with no terminal, stays a dry run. A tampered or unsigned receipt is always refused.\nExit: 0 done or planned, 1 receipt tampered or undo failed, 2 usage, refusal or receipt unchecked, 3 receipt unsigned (refused), 66 unknown run.\n";
const EXIT_BY_VERDICT: Record<Verdict, number> = { VERIFIED: 0, UNSIGNED: 3, TAMPERED: 1, UNCHECKED: 2 };

type Loaded = { plan: UndoPlan } | { rc: number };

async function loadPlan(runId: string, allowUnsigned: boolean, deps: UndoDeps, git: GitRunner): Promise<Loaded> {
  const err = deps.err ?? ((s: string) => void process.stderr.write(s));
  if (!RUN_ID_RE.test(runId) || runId.includes("..")) { err(`loki undo: invalid run id '${runId}'\n`); return { rc: 2 }; }
  const runsRoot = deps.runsRoot ?? join(lokiDir(), "runs");
  const receiptPath = join(runsRoot, runId, "receipt.json");
  if (!existsSync(receiptPath)) { err(`loki undo: unknown run '${runId}' (no ${receiptPath})\n`); return { rc: 66 }; }
  const bound = runIdGuard(receiptPath, runId); // same run-id binding as loki verify: a receipt copied from another run is refused
  if (bound) { err(`loki undo: receipt verdict TAMPERED; refusing\n  ${bound}\n`); return { rc: EXIT_BY_VERDICT.TAMPERED }; }
  const result = await verifyReceipt(receiptPath);
  if (!(result.verdict === "UNSIGNED" && allowUnsigned) && result.verdict !== "VERIFIED") {
    err(`loki undo: receipt verdict ${result.verdict}; refusing\n${result.reasons.map((r) => `  ${r}\n`).join("")}`);
    return { rc: EXIT_BY_VERDICT[result.verdict] };
  }
  const refs = receiptRefs(receiptPath);
  if (!refs) { err("loki undo: receipt base_sha/head_sha missing or not hex object ids\n"); return { rc: 2 }; }
  const repoDir = deps.repoDir ?? dirname(lokiDir());
  return { plan: buildPlan(runId, result.verdict, refs, repoDir, prUrlOf(join(runsRoot, runId, "events.jsonl")), git) };
}

const LIST_MAX = 20;

/** --list: newest-first table of runs with a receipt. Read-only: verifies each receipt and counts files via read-only `log --name-only`. */
async function listRuns(deps: UndoDeps, git: GitRunner, out: (s: string) => void): Promise<number> {
  const runsRoot = deps.runsRoot ?? join(lokiDir(), "runs");
  const repoDir = deps.repoDir ?? dirname(lokiDir());
  const now = (deps.now ?? (() => new Date()))();
  let found: { id: string; path: string; mtime: number }[] = [];
  try {
    for (const id of readdirSync(runsRoot)) {
      const path = join(runsRoot, id, "receipt.json");
      if (!RUN_ID_RE.test(id) || id.includes("..") || !existsSync(path)) continue;
      found.push({ id, path, mtime: statSync(path).mtimeMs });
    }
  } catch { /* no runs dir */ }
  found.sort((a, b) => b.mtime - a.mtime || (a.id < b.id ? -1 : 1));
  found = found.slice(0, LIST_MAX);
  if (found.length === 0) { out("no runs to undo\n"); return 0; }
  const rows: string[][] = [["RUN", "VERDICT", "FILES", "AGE"]];
  for (const r of found) {
    const refs = receiptRefs(r.path);
    let files = "-";
    if (refs) {
      const l = git(repoDir, ["log", "--name-only", "--format=", "--end-of-options", `${refs.base}..${refs.head}`]);
      if (l.status === 0) files = String(new Set(l.stdout.split("\n").map((x) => x.trim()).filter(Boolean)).size);
    }
    const verdict = runIdGuard(r.path, r.id) ? "TAMPERED" : (await verifyReceipt(r.path)).verdict;
    rows.push([r.id, verdict, files, formatAge(new Date(r.mtime).toISOString(), now)]);
  }
  const w = [0, 1, 2].map((i) => Math.max(...rows.map((row) => row[i]!.length)));
  out(rows.map((row) => `${row.map((c, i) => (i < 3 ? c.padEnd(w[i]!) : c)).join("  ")}\n`).join(""));
  return 0;
}

export async function runUndo(args: readonly string[], deps: UndoDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => void process.stdout.write(s)), err = deps.err ?? ((s: string) => void process.stderr.write(s));
  if (args[0] === "--help" || args[0] === "-h" || args.length === 0) { out(USAGE); return args.length === 0 ? 2 : 0; }
  const known = new Set(["--list", "--plan", "--json", "--allow-unsigned", "--yes", "--close-pr", "--dry-run", "--help"]);
  const bad = args.find((x) => x.startsWith("-") && !known.has(x));
  if (bad !== undefined) {
    const hint = suggestWord(bad, [...known]);
    err(`loki undo: unknown flag ${bad} (see loki undo --help)\n${hint ? `Did you mean '${hint}'?\n` : ""}`);
    return 2;
  }
  if (args.includes("--help")) { out(USAGE); return 0; }
  if (args.includes("--list")) {
    if (args.length !== 1) { err(`loki undo: --list takes no other arguments\n${USAGE}`); return 2; }
    return listRuns(deps, deps.git ?? defaultRunner, out);
  }
  const pos = args.filter((x) => !x.startsWith("-"));
  if (pos.length !== 1) { err(`loki undo: exactly one run-id is required\n${USAGE}`); return 2; }
  const runId = pos[0]!;
  const dryRun = args.includes("--dry-run");
  const planOnly = args.includes("--plan") || dryRun;
  if (!planOnly && (args.includes("--allow-unsigned") || args.includes("--json"))) { err("loki undo: --allow-unsigned and --json apply to --plan only; apply never accepts an unsigned receipt\n"); return 2; }
  if (planOnly && (args.includes("--yes") || args.includes("--close-pr"))) { err("loki undo: --yes and --close-pr cannot be combined with --plan or --dry-run\n"); return 2; }
  if (!isRunId(runId)) { err(`loki undo: invalid run id '${runId}'\n`); return 2; }
  if (!planOnly && (deps.env ?? process.env)["LOKI_UNDO"] !== "1") { err("loki undo: applying an undo is behind LOKI_UNDO=1 until reviewed; use --plan to preview\n"); return 2; }
  const loaded = await loadPlan(runId, planOnly && args.includes("--allow-unsigned"), deps, deps.git ?? defaultRunner);
  if ("rc" in loaded) return loaded.rc;
  if (dryRun) loaded.plan.diffstat = dryRunDiffstat(loaded.plan, deps.repoDir ?? dirname(lokiDir()), deps.git ?? defaultRunner);
  if (planOnly) { out(args.includes("--json") ? JSON.stringify(loaded.plan, null, 2) + "\n" : renderPlan(loaded.plan)); return 0; }
  const { applyUndo } = await import("./undo_apply.ts");
  const undoDir = deps.undoDir ?? join(lokiDir(), "undo");
  return applyUndo(loaded.plan, { repoDir: deps.repoDir ?? dirname(lokiDir()), undoDir, yes: args.includes("--yes"), closePr: args.includes("--close-pr"), read: deps.git ?? defaultRunner, git: deps.applyGit, confirm: deps.confirm, closePrFn: deps.closePr, out, err });
}
