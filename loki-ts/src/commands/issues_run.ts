// `loki issues run [owner/repo]`: mass pickup of a repo's open issues (MASS-1).
//   1. list open issues with the user's gh, skip any that already has an open Loki PR (head loki/issue-N, or a
//      loki/* PR whose body links the issue), so a rerun resumes and never duplicates;
//   2. show the count and an estimated cost range (T1 cost_preview) and require y/n (--yes for CI);
//   3. triage each issue with one cheap planning session (Engine Law L0: the model decides, no keyword rules);
//   4. run every actionable issue through the T7 queue (commands/queue.ts) as a normal `loki start owner/repo#N --pr`
//      run, so verify, seal, receipt and the PR push are the single-run path, unchanged;
//   5. print one live line per issue, then a digest table, also written to .loki/issues-run/<ts>/digest.md.
// Every external effect (gh, triage, runner, worktrees, prompt) is injectable so tests never call a provider.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { MAX_PARALLEL, makeDefaultRunner, queueAdd, queueRun, type ItemResult, type QueueDeps, type RunOpts, type RunResult } from "./queue.ts";
import { estimateFor, startText, type EstimateResult } from "../runner/router/cost_preview.ts";
import { calculateRateLimitBackoff, isRateLimited, parseRetryAfter } from "../runner/budget.ts";
import { safeGit } from "../util/safe_git.ts";
import { githubSlug } from "../runner/attempts.ts";

export interface GhIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
}

export type TriageDecision = "actionable" | "needs-info" | "too-large" | "unknown";
export interface Triage {
  decision: TriageDecision;
  reason: string;
}

export interface GhResult {
  rc: number;
  stdout: string;
  stderr: string;
}

export interface IssuesRunDeps {
  repoDir: string;
  lokiDir: string;
  gh: (args: readonly string[]) => GhResult;
  triage: (slug: string, issue: GhIssue) => Promise<Triage>;
  runner: QueueDeps["runner"];
  estimate: () => EstimateResult;
  confirm: (question: string) => Promise<boolean>;
  isTTY: boolean;
  worktree: { create: (n: number) => string; remove: (n: number, path: string) => void };
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  out: (s: string) => void;
  err: (s: string) => void;
}

export interface IssuesRunArgs {
  slug: string | null;
  label: string | null;
  limit: number;
  parallel: number;
  draft: boolean;
  dryRun: boolean;
  yes: boolean;
  comment: boolean;
}

const USAGE = "usage: loki issues run [owner/repo] [--label L] [--limit N] [--parallel K] [--draft] [--dry-run] [--yes] [--comment]\n";
const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DEFAULT_LIMIT = 100;
const RATE_LIMIT_RETRIES = 2;

export function parseIssuesArgs(args: readonly string[]): IssuesRunArgs | string {
  const a: IssuesRunArgs = { slug: null, label: null, limit: DEFAULT_LIMIT, parallel: 1, draft: false, dryRun: false, yes: false, comment: false };
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!;
    const val = (): string | null => (i + 1 < args.length ? args[++i]! : null);
    if (t === "--draft") a.draft = true;
    else if (t === "--dry-run") a.dryRun = true;
    else if (t === "--yes" || t === "-y") a.yes = true;
    else if (t === "--comment") a.comment = true;
    else if (t === "--label") {
      const v = val();
      if (!v) return "--label needs a value";
      a.label = v;
    } else if (t === "--limit" || t === "--parallel") {
      const v = Number(val());
      if (!Number.isInteger(v) || v < 1) return `${t} needs a positive integer`;
      if (t === "--parallel" && v > MAX_PARALLEL) return `--parallel is at most ${MAX_PARALLEL}`;
      if (t === "--limit") a.limit = v;
      else a.parallel = v;
    } else if (!t.startsWith("-") && a.slug === null && SLUG_RE.test(t)) a.slug = t;
    else return `unexpected argument: ${t}`;
  }
  return a;
}

/** The issue number a Loki PR already covers: head loki/issue-N, or a loki/* PR whose body links the issue. */
export function coveredIssues(slug: string, prs: readonly { headRefName?: string; body?: string }[]): Set<number> {
  const out = new Set<number>();
  const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const link = new RegExp(`(?:^|[^A-Za-z0-9_/#])(?:${esc})?#(\\d+)\\b|github\\.com/${esc}/issues/(\\d+)\\b`, "gi");
  for (const pr of prs) {
    const head = pr.headRefName ?? "";
    if (!head.startsWith("loki/")) continue;
    const m = /^loki\/issue-(\d+)$/.exec(head);
    if (m) out.add(Number(m[1]));
    for (const l of (pr.body ?? "").matchAll(link)) out.add(Number(l[1] ?? l[2]));
  }
  return out;
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

const clip = (s: string, n: number): string => {
  const one = s.replace(/[\x00-\x1f\x7f|]+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 3)}...` : one;
};

const lastLine = (s: string): string => s.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";

function originSlug(repoDir: string): string | null {
  try {
    return githubSlug(safeGit(repoDir, ["config", "--get", "remote.origin.url"]).trim());
  } catch {
    return null;
  }
}

interface Row {
  issue: number;
  title: string;
  triage: string;
  outcome: string;
  pr: string;
  cost: string;
  time: string;
}

export function renderIssuesDigest(slug: string, started: Date, finished: Date, rows: readonly Row[]): string {
  const L = [`# Loki issues run: ${slug}`, "", `Started: ${started.toISOString()}  `, `Finished: ${finished.toISOString()}`, ""];
  L.push("| Issue | Triage | Outcome | PR | Cost | Time |", "| --- | --- | --- | --- | --- | --- |");
  for (const r of rows) L.push(`| #${r.issue} ${clip(r.title, 60)} | ${r.triage} | ${r.outcome} | ${r.pr} | ${r.cost} | ${r.time} |`);
  if (rows.length === 0) L.push("| (none) | | | | | |");
  return L.join("\n") + "\n";
}

const secs = (s: number): string => (s < 90 ? `${Math.round(s)}s` : `${Math.round(s / 60)}m`);

export async function issuesRun(args: readonly string[], d: IssuesRunDeps): Promise<number> {
  const a = parseIssuesArgs(args);
  if (typeof a === "string") {
    d.err(`loki issues run: ${a}\n${USAGE}`);
    return 2;
  }
  const slug = a.slug ?? originSlug(d.repoDir);
  if (!slug) {
    d.err("loki issues run: no owner/repo given and origin is not a GitHub remote\n");
    return 2;
  }
  const started = d.now();

  // 1. list and dedupe (read-only gh calls, nothing billed)
  const list = d.gh(["issue", "list", "--repo", slug, "--state", "open", "--json", "number,title,body,labels", "--limit", String(a.limit), ...(a.label ? ["--label", a.label] : [])]);
  const raw = list.rc === 0 ? parseJson<{ number: number; title?: string; body?: string; labels?: { name?: string }[] }[]>(list.stdout) : null;
  if (!Array.isArray(raw)) {
    d.err(`loki issues run: gh issue list failed (rc ${list.rc}): ${clip(list.stderr || list.stdout, 300)}\n`);
    return 1;
  }
  const issues: GhIssue[] = raw.map((i) => ({ number: i.number, title: i.title ?? "", body: i.body ?? "", labels: (i.labels ?? []).map((l) => l.name ?? "") }));
  const prs = d.gh(["pr", "list", "--repo", slug, "--state", "open", "--json", "number,headRefName,body,url", "--limit", "500"]);
  const prList = prs.rc === 0 ? parseJson<{ headRefName?: string; body?: string }[]>(prs.stdout) : null;
  if (!Array.isArray(prList)) {
    // Fail closed: without the PR list a rerun could open a duplicate PR.
    d.err(`loki issues run: gh pr list failed (rc ${prs.rc}); refusing to run without the dedupe check\n`);
    return 1;
  }
  const covered = coveredIssues(slug, prList);
  const dupes = issues.filter((i) => covered.has(i.number));
  const todo = issues.filter((i) => !covered.has(i.number));

  d.out(`${slug}: ${issues.length} open issue${issues.length === 1 ? "" : "s"}${a.label ? ` labeled ${a.label}` : ""}, ${dupes.length} already ha${dupes.length === 1 ? "s" : "ve"} an open Loki PR, ${todo.length} to triage\n`);
  for (const i of dupes) d.out(`  skip #${i.number} (open Loki PR exists): ${clip(i.title, 70)}\n`);
  for (const i of todo) d.out(`  plan #${i.number}: ${clip(i.title, 70)}\n`);
  const est = d.estimate();
  const estLine = est.ok
    ? `estimated total: $${(est.est.usd[0] * todo.length).toFixed(2)}-$${(est.est.usd[1] * todo.length).toFixed(2)} for ${todo.length} issue${todo.length === 1 ? "" : "s"} (${startText(est)} per issue), plus one triage call each`
    : `estimated total: NOT AVAILABLE (${est.reason})`;
  d.out(`${estLine}\n`);
  if (todo.length === 0) {
    d.out("nothing to run\n");
    return 0;
  }
  if (a.dryRun) {
    d.out(`dry run: no triage calls, nothing spawned; parallel ${a.parallel}${a.draft ? ", draft PRs" : ""}\n`);
    return 0;
  }

  // 2. consent before anything billed
  if (!a.yes) {
    if (!d.isTTY) {
      d.err("loki issues run: refusing to start billed runs without a terminal to confirm; pass --yes to run unattended\n");
      return 2;
    }
    if (!(await d.confirm(`Triage and run ${todo.length} issue${todo.length === 1 ? "" : "s"} on ${slug}? [y/N] `))) {
      d.out("aborted, nothing run\n");
      return 1;
    }
  }

  // 3. triage (one planning call per issue)
  const rows = new Map<number, Row>();
  const actionable: GhIssue[] = [];
  for (const i of todo) {
    let t: Triage;
    try {
      t = await d.triage(slug, i);
    } catch (e) {
      t = { decision: "unknown", reason: `triage failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    d.out(`#${i.number} triage: ${t.decision}: ${clip(t.reason, 120)}\n`);
    if (t.decision === "actionable") {
      actionable.push(i);
      continue;
    }
    rows.set(i.number, { issue: i.number, title: i.title, triage: t.decision, outcome: `skipped: ${clip(t.reason, 120)}`, pr: "none", cost: "-", time: "-" });
    if (a.comment && t.decision !== "unknown") {
      const c = d.gh(["issue", "comment", String(i.number), "--repo", slug, "--body", `Loki triage: ${t.decision}. ${t.reason}`]);
      if (c.rc !== 0) d.err(`#${i.number}: triage comment failed (rc ${c.rc})\n`);
    }
  }

  // 4. the T7 queue, in a private queue dir so the user's own `loki queue` is never touched
  const stamp = started.toISOString().replace(/[:.]/g, "-");
  const runDir = join(d.lokiDir, "issues-run", stamp);
  mkdirSync(runDir, { recursive: true });
  const byRef = new Map(actionable.map((i) => [`${slug}#${i.number}`, i]));
  const sink = (): void => {};
  if (actionable.length > 0) {
    queueAdd([...byRef.keys()], { lokiDir: runDir, runner: d.runner, governor: noGovernor, now: d.now, out: sink, err: d.err });
    const runOne = async (ref: string, opts: RunOpts): Promise<RunResult> => {
      const n = byRef.get(ref)!.number;
      const wt = a.parallel > 1 ? d.worktree.create(n) : null;
      try {
        for (let attempt = 0; ; attempt++) {
          const res = await d.runner(ref, { ...opts, ...(wt ? { cwd: wt } : {}) });
          if (res.rc === 0 || attempt >= RATE_LIMIT_RETRIES || !isRateLimited(res.output)) return res;
          const wait = calculateRateLimitBackoff(parseRetryAfter(res.output));
          d.out(`#${n} provider rate limit, retrying in ${wait}s\n`);
          await d.sleep(wait * 1000);
        }
      } finally {
        if (wt) d.worktree.remove(n, wt);
      }
    };
    const onResult = (r: ItemResult): void => {
      const i = byRef.get(r.ref)!;
      const outcome = r.row.pr ? r.row.verdict : `${r.row.verdict}, no PR: ${clip(lastLine(r.res.output) || "no output", 140)}`;
      rows.set(i.number, { issue: i.number, title: i.title, triage: "actionable", outcome, pr: r.row.pr ?? "none", cost: r.row.cost, time: secs(r.seconds) });
      d.out(`#${i.number} ${r.row.verdict}  pr ${r.row.pr ?? "none"}  cost ${r.row.cost}  ${secs(r.seconds)}\n`);
    };
    for (const i of actionable) d.out(`#${i.number} running\n`);
    await queueRun([], { lokiDir: runDir, runner: runOne, governor: noGovernor, now: d.now, out: sink, err: d.err, parallel: a.parallel, draft: a.draft, onResult });
  }

  // 5. digest
  const ordered = todo.map((i) => rows.get(i.number)).filter((r): r is Row => r !== undefined);
  const text = renderIssuesDigest(slug, started, d.now(), ordered);
  try {
    writeFileSync(join(runDir, "digest.md"), text);
  } catch (e) {
    d.err(`loki issues run: could not write digest: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  d.out(`\n${text}\ndigest: ${join(runDir, "digest.md")}\n`);
  return 0;
}

// This path never consults the swarm usage governor; the y/n cost gate above is the consent.
const noGovernor = async (): Promise<{ ok: boolean; hold: boolean; reason: string }> => ({ ok: true, hold: false, reason: "not consulted" });

export const TRIAGE_RE = /^TRIAGE:\s*(actionable|needs-info|too-large)\s*\|\s*(.+)$/gm;

export function triageBrief(slug: string, i: GhIssue): string {
  return [
    "You are triaging one GitHub issue for an autonomous coding agent that would attempt it as a single pull request in this repository.",
    "Do not edit, create or delete any file. You may read the repository to judge scope.",
    "Decide exactly one: actionable (clear and small enough for one PR), needs-info (a maintainer must supply missing information first), too-large (needs several PRs or a design decision).",
    "End your reply with exactly one line in this form, and nothing after it:",
    "TRIAGE: <actionable|needs-info|too-large> | <one-line reason>",
    "",
    `Issue ${slug}#${i.number}: ${i.title}`,
    i.labels.length ? `Labels: ${i.labels.join(", ")}` : "",
    "",
    i.body.slice(0, 8000),
  ].join("\n");
}

/** The model's own TRIAGE line (the last one), or unknown. Parses the reply's format, never the issue's words. */
export function parseTriage(reply: string): Triage {
  const all = [...reply.matchAll(TRIAGE_RE)];
  const m = all[all.length - 1];
  return m ? { decision: m[1] as TriageDecision, reason: m[2]!.trim() } : { decision: "unknown", reason: "triage reply had no TRIAGE line" };
}

/** One fast-tier planning session through the engine's own session runner (engine10/session.ts). */
export function makeSessionTriage(repoDir: string, lokiDir: string, provider: string): IssuesRunDeps["triage"] {
  return async (slug, issue) => {
    const { createSessionRunner } = await import("../engine10/session.ts");
    const runner = createSessionRunner({ provider, lokiRoot: lokiDir });
    const r = (await runner.run({
      stage: "plan",
      brief: triageBrief(slug, issue),
      tier: "fast",
      iterationId: `issues-triage-${issue.number}-${Date.now()}`,
      limitS: 180,
      signal: new AbortController().signal,
      cwd: repoDir,
    })) as { exit: number | null; summary?: string };
    const t = parseTriage(r.summary ?? "");
    return t.decision === "unknown" ? { decision: "unknown", reason: `${t.reason} (session exit ${r.exit})` } : t;
  };
}

export function makeWorktrees(repoDir: string): IssuesRunDeps["worktree"] {
  let root: string | null = null;
  return {
    create: (n) => {
      root ??= mkdtempSync(join(tmpdir(), "loki-issues-"));
      const p = join(root, `issue-${n}`);
      // engine10 refuses a detached HEAD; loki/issue-N is the throwaway base, engine10 moves onto loki/<runId> for the PR.
      safeGit(repoDir, ["worktree", "add", "-B", `loki/issue-${n}`, p, "HEAD"]);
      return p;
    },
    remove: (n, p) => {
      try {
        safeGit(repoDir, ["worktree", "remove", "--force", p]);
        safeGit(repoDir, ["branch", "-D", `loki/issue-${n}`]);
      } catch {
        rmSync(p, { recursive: true, force: true }); // best effort; `git worktree prune` clears the record
      }
    },
  };
}

function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (ans) => {
    rl.close();
    res(/^y(es)?$/i.test(ans.trim()));
  }));
}

export async function runIssues(args: readonly string[], inject?: Partial<IssuesRunDeps>): Promise<number> {
  const sub = args[0];
  if (sub !== "run") {
    (inject?.err ?? ((s: string) => void process.stderr.write(s)))(USAGE);
    return 2;
  }
  const repoDir = inject?.repoDir ?? process.cwd();
  const lokiDir = inject?.lokiDir ?? process.env["LOKI_DIR"] ?? resolve(repoDir, ".loki");
  // gh and each `loki start` supervisor get the user's env, exactly as a direct `loki start --pr` would (the supervisor
  // withholds the token from its own worker). This process then withholds it, so the triage sessions never hold it.
  const userEnv: NodeJS.ProcessEnv = { ...process.env };
  if (!inject?.triage) (await import("../runner/github_token.ts")).withholdGithubTokens(process.env, () => {});
  const base = inject?.runner ?? makeDefaultRunner(lokiDir);
  const d: IssuesRunDeps = {
    repoDir,
    lokiDir,
    gh: inject?.gh ?? ((ghArgs) => {
      const r = spawnSync("gh", [...ghArgs], { cwd: repoDir, env: userEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { rc: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error) : "") };
    }),
    triage: inject?.triage ?? makeSessionTriage(repoDir, lokiDir, process.env["LOKI_PROVIDER"] ?? "claude"),
    runner: inject?.runner ?? ((ref, opts) => base(ref, { ...opts, env: userEnv })),
    estimate: inject?.estimate ?? (() => estimateFor(repoDir)),
    confirm: inject?.confirm ?? askYesNo,
    isTTY: inject?.isTTY ?? (!!process.stdin.isTTY && !!process.stdout.isTTY),
    worktree: inject?.worktree ?? makeWorktrees(repoDir),
    sleep: inject?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: inject?.now ?? (() => new Date()),
    out: inject?.out ?? ((s) => void process.stdout.write(s)),
    err: inject?.err ?? ((s) => void process.stderr.write(s)),
  };
  return issuesRun(args.slice(1), d);
}
