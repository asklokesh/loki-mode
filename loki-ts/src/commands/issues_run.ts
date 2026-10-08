// `loki issues run [owner/repo]`: mass pickup of a repo's open issues (MASS-1).
//   1. list open issues with the user's gh, skip any that already has an open Loki PR (head loki/issue-N, or a
//      loki/* PR whose body links the issue), so a rerun resumes and never duplicates;
//   2. show the count and an estimated cost range (T1 cost_preview) and require y/n (--yes for CI);
//   3. triage each issue with one cheap planning session (Engine Law L0: the model decides, no keyword rules);
//   4. run every actionable issue through the T7 queue (commands/queue.ts) as a normal `loki start owner/repo#N --pr`
//      run, so verify, seal, receipt and the PR push are the single-run path, unchanged;
//   5. print one live line per issue, then a digest table, also written to .loki/issues-run/<ts>/digest.md.
// MASS-2: a too-large issue is split by the model into stacked slices (commands/issues_epic.ts) unless --no-split.
// Every external effect (gh, triage, runner, worktrees, prompt) is injectable so tests never call a provider.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { MAX_PARALLEL, makeDefaultRunner, queueAdd, queueRun, type ItemResult, type QueueDeps, type RunOpts, type RunResult } from "./queue.ts";
import { estimateFor, startText, type EstimateResult } from "../runner/router/cost_preview.ts";
import { makeSessionDecompose, parseDecomposition, planComment, renderEpicTree, runEpicSlices, sliceTask, type Decomposition, type Slice, type SliceResult } from "./issues_epic.ts";
import { calculateRateLimitBackoff, isRateLimited, parseRetryAfter } from "../runner/budget.ts";
import { safeGit } from "../util/safe_git.ts";
import { githubSlug } from "../runner/attempts.ts";
import { resolveModel } from "../engine10/session.ts";

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
  decompose: (slug: string, issue: GhIssue, triageReason: string) => Promise<string>; // the model's JSON split, validated here
  runner: QueueDeps["runner"];
  estimate: () => EstimateResult;
  confirm: (question: string) => Promise<boolean>;
  isTTY: boolean;
  worktree: { create: (name: string, base: string) => string; remove: (name: string, path: string) => void };
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
  split: boolean;
}

const USAGE = "usage: loki issues run [owner/repo] [--label L] [--limit N] [--parallel K] [--draft] [--dry-run] [--yes] [--comment] [--no-split]\n";
const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DEFAULT_LIMIT = 100;
const RATE_LIMIT_RETRIES = 2;

export function parseIssuesArgs(args: readonly string[]): IssuesRunArgs | string {
  const a: IssuesRunArgs = { slug: null, label: null, limit: DEFAULT_LIMIT, parallel: 1, draft: false, dryRun: false, yes: false, comment: false, split: true };
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!;
    const val = (): string | null => (i + 1 < args.length ? args[++i]! : null);
    if (t === "--draft") a.draft = true;
    else if (t === "--dry-run") a.dryRun = true;
    else if (t === "--yes" || t === "-y") a.yes = true;
    else if (t === "--comment") a.comment = true;
    else if (t === "--no-split") a.split = false;
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
  const per = perRun(est);
  const extra = a.split ? ", plus one triage call each and one Opus split call per too-large issue" : ", plus one triage call each";
  const estLine = per
    ? `estimated total: ${per.tilde}$${(per.usd[0] * todo.length).toFixed(2)}-$${(per.usd[1] * todo.length).toFixed(2)} for ${todo.length} issue${todo.length === 1 ? "" : "s"} (${startText(est)} per issue)${extra}`
    : `estimated total: NOT AVAILABLE (${est.ok ? "" : est.reason})`;
  d.out(`${estLine}\n`);
  if (todo.length === 0) {
    d.out("nothing to run\n");
    return 0;
  }
  if (a.dryRun) {
    d.out(`dry run: no triage calls, nothing spawned; parallel ${a.parallel}${a.draft ? ", draft PRs" : ""}${a.split ? "" : ", no split"}\n`);
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

  // 3. triage (one planning call per issue); MASS-2: a too-large issue gets one split call
  const rows = new Map<number, Row>();
  const actionable: GhIssue[] = [];
  const epics: { issue: GhIssue; reason: string; plan: Extract<Decomposition, { ok: true }> }[] = [];
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
    let skipReason = t.reason;
    if (t.decision === "too-large" && a.split) {
      let p: Decomposition;
      try {
        p = parseDecomposition(await d.decompose(slug, i, t.reason));
      } catch (e) {
        p = { ok: false, reason: `split call failed: ${e instanceof Error ? e.message : String(e)}` };
      }
      if (p.ok) {
        epics.push({ issue: i, reason: t.reason, plan: p });
        d.out(`#${i.number} split into ${p.slices.length} slices: ${p.slices.map((s) => s.id + (p.parent[s.id] ? `<-${p.parent[s.id]}` : "")).join(", ")}\n`);
        continue;
      }
      d.out(`#${i.number} split refused: ${clip(p.reason, 160)}\n`);
      skipReason = `split refused: ${p.reason}`;
    }
    rows.set(i.number, { issue: i.number, title: i.title, triage: t.decision, outcome: `skipped: ${clip(skipReason, 120)}`, pr: "none", cost: "-", time: "-" });
    if (a.comment && t.decision !== "unknown") {
      const c = d.gh(["issue", "comment", String(i.number), "--repo", slug, "--body", `Loki triage: ${t.decision}. ${t.reason}`]);
      if (c.rc !== 0) d.err(`#${i.number}: triage comment failed (rc ${c.rc})\n`);
    }
  }

  // MASS-2: per-epic estimate (slices x the per-run estimate) and a second consent before any slice runs
  if (epics.length > 0) {
    let slices = 0;
    for (const e of epics) {
      const n = e.plan.slices.length;
      slices += n;
      d.out(per
        ? `epic #${e.issue.number}: ${n} slices x ${per.tilde}$${per.usd[0].toFixed(2)}-$${per.usd[1].toFixed(2)}${per.label} = ${per.tilde}$${(per.usd[0] * n).toFixed(2)}-$${(per.usd[1] * n).toFixed(2)}\n`
        : `epic #${e.issue.number}: ${n} slices x NOT AVAILABLE (${est.ok ? "" : est.reason})\n`);
    }
    const q = `Run ${actionable.length} issue${actionable.length === 1 ? "" : "s"} and ${slices} slices in ${epics.length} epic${epics.length === 1 ? "" : "s"} on ${slug}? [y/N] `;
    if (!a.yes && !(await d.confirm(q))) {
      d.out("aborted after triage, nothing run\n");
      return 1;
    }
    if (a.comment) {
      for (const e of epics) {
        const c = d.gh(["issue", "comment", String(e.issue.number), "--repo", slug, "--body", planComment(e.reason, e.plan.slices)]);
        if (c.rc !== 0) d.err(`#${e.issue.number}: plan comment failed (rc ${c.rc})\n`);
      }
    }
  }

  // 4. the T7 queue, in a private queue dir so the user's own `loki queue` is never touched
  const stamp = started.toISOString().replace(/[:.]/g, "-");
  const runDir = join(d.lokiDir, "issues-run", stamp);
  mkdirSync(runDir, { recursive: true });
  const byRef = new Map(actionable.map((i) => [`${slug}#${i.number}`, i]));
  const sink = (): void => {};
  // One run with the rate-limit backoff; a worktree run keeps its receipt under runDir before the worktree goes.
  const runWithRetry = async (label: string, ref: string, opts: RunOpts, wt: string | null): Promise<RunResult> => {
    for (let attempt = 0; ; attempt++) {
      const res = await d.runner(ref, { ...opts, ...(wt ? { cwd: wt } : {}) });
      if (wt && res.runId) keepReceipt(wt, res.runId, runDir, d.err);
      if (res.rc === 0 || attempt >= RATE_LIMIT_RETRIES || !isRateLimited(res.output)) return res;
      const wait = calculateRateLimitBackoff(parseRetryAfter(res.output));
      d.out(`${label} provider rate limit, retrying in ${wait}s\n`);
      await d.sleep(wait * 1000);
    }
  };
  if (actionable.length > 0) {
    queueAdd([...byRef.keys()], { lokiDir: runDir, runner: d.runner, governor: noGovernor, now: d.now, out: sink, err: d.err });
    const runOne = async (ref: string, opts: RunOpts): Promise<RunResult> => {
      const n = byRef.get(ref)!.number;
      const wt = a.parallel > 1 ? d.worktree.create(`issue-${n}`, "HEAD") : null;
      try {
        return await runWithRetry(`#${n}`, ref, opts, wt);
      } finally {
        if (wt) d.worktree.remove(`issue-${n}`, wt);
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

  // MASS-2: each epic's slices, one at a time in dependency order, through the same runner and the run's own PR stage
  const trees: string[] = [];
  for (const e of epics) {
    const n = e.issue.number;
    const t0 = Date.now();
    const runSlice = async (s: Slice, k: number, base: string | null): Promise<SliceResult> => {
      const name = `epic-${n}-s${k + 1}`;
      const parent = e.plan.parent[s.id] ?? null;
      d.out(`#${n} ${s.id} running${base ? ` (stacked on ${base})` : ""}\n`);
      let wt: string;
      try {
        wt = d.worktree.create(name, base ?? "HEAD");
      } catch (err) {
        return { id: s.id, title: s.title, parent, outcome: `FAILED (worktree: ${clip(err instanceof Error ? err.message : String(err), 100)})`, pr: null, cost: "-", branch: null };
      }
      let res: RunResult;
      try {
        const opts: RunOpts = { pr: true, draft: true, prRefs: `${slug}#${n}`, logName: name, ...(base ? { prBase: base } : {}) };
        res = await runWithRetry(`#${n} ${s.id}`, sliceTask(slug, e.issue, s, k, e.plan.slices.length, parent), opts, wt);
      } catch (err) {
        res = { rc: 1, output: `runner threw: ${err instanceof Error ? err.message : String(err)}` };
      } finally {
        d.worktree.remove(name, wt);
      }
      const pr = PR_URL_RE.exec(res.output)?.[0] ?? null;
      const verdict = res.verdict || (res.rc === 0 ? "COMPLETED (no proof verdict)" : `FAILED (exit ${res.rc})`);
      const r: SliceResult = { id: s.id, title: s.title, parent, outcome: verdict, pr, cost: typeof res.costUsd === "number" ? `$${res.costUsd.toFixed(2)}` : "NOT RECORDED", branch: res.runId ? `loki/${res.runId}` : null };
      d.out(`#${n} ${s.id} ${verdict}  pr ${pr ?? "none"}  cost ${r.cost}\n`);
      return r;
    };
    const results = await runEpicSlices(e.plan, runSlice, (r) => d.out(`#${n} ${r.id} ${r.title}: ${r.outcome}\n`));
    const prs = results.filter((r) => r.pr).length;
    const failed = results.filter((r) => /^(FAILED|BLOCKED)/.test(r.outcome)).length;
    const skipped = results.filter((r) => r.outcome.startsWith("SKIPPED")).length;
    const usd = results.map((r) => /^\$(\d+\.\d+)$/.exec(r.cost)).filter((m): m is RegExpExecArray => m !== null).reduce((sum, m) => sum + Number(m[1]), 0);
    const anyUnmetered = results.some((r) => r.cost === "NOT RECORDED");
    const cost = results.length - skipped === 0 ? "-" : anyUnmetered ? `NOT RECORDED${usd > 0 ? ` (at least $${usd.toFixed(2)})` : ""}` : `$${usd.toFixed(2)}`;
    rows.set(n, { issue: n, title: e.issue.title, triage: "too-large", outcome: `split: ${results.length} slices, ${prs} PRs, ${failed} failed, ${skipped} skipped`, pr: "see epic tree", cost, time: secs((Date.now() - t0) / 1000) });
    trees.push(renderEpicTree(n, e.issue.title, results));
  }

  // 5. digest
  const ordered = todo.map((i) => rows.get(i.number)).filter((r): r is Row => r !== undefined);
  const text = renderIssuesDigest(slug, started, d.now(), ordered) + (trees.length ? `\n## Epics\n\n${trees.join("\n")}` : "");
  try {
    writeFileSync(join(runDir, "digest.md"), text);
  } catch (e) {
    d.err(`loki issues run: could not write digest: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  d.out(`\n${text}\ndigest: ${join(runDir, "digest.md")}\n`);
  return 0;
}

const PR_URL_RE = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/;

/** The per-run USD band and its label: measured history, else the labelled rough prior (F2), else null (NOT AVAILABLE). */
function perRun(est: EstimateResult): { usd: [number, number]; tilde: string; label: string } | null {
  if (est.ok) return { usd: est.est.usd, tilde: "", label: "" };
  return est.prior ? { usd: est.prior.usd, tilde: "~", label: " (rough prior)" } : null;
}

/** An engine10 run in a worktree writes its receipt under <wt>/.loki/runs/<id>; copy it out before the worktree is removed. */
function keepReceipt(wt: string, runId: string, runDir: string, err: (s: string) => void): void {
  const src = join(wt, ".loki", "runs", runId);
  if (!/^[A-Za-z0-9_.-]+$/.test(runId) || !existsSync(src)) return;
  try {
    cpSync(src, join(runDir, "receipts", runId), { recursive: true });
  } catch (e) {
    err(`loki issues run: could not keep the receipt of ${runId}: ${e instanceof Error ? e.message : String(e)}\n`);
  }
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
    create: (name, base) => {
      root ??= mkdtempSync(join(tmpdir(), "loki-issues-"));
      const p = join(root, name);
      // engine10 refuses a detached HEAD; loki/<name> is the throwaway base, engine10 moves onto loki/<runId> for the PR.
      // MASS-2: a stacked slice starts on its parent slice's run branch, which stays after the parent's worktree is gone.
      safeGit(repoDir, ["worktree", "add", "-B", `loki/${name}`, p, base]);
      return p;
    },
    remove: (name, p) => {
      try {
        safeGit(repoDir, ["worktree", "remove", "--force", p]);
        safeGit(repoDir, ["branch", "-D", `loki/${name}`]);
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
  const provider = process.env["LOKI_PROVIDER"] ?? "claude";
  const d: IssuesRunDeps = {
    repoDir,
    lokiDir,
    gh: inject?.gh ?? ((ghArgs) => {
      const r = spawnSync("gh", [...ghArgs], { cwd: repoDir, env: userEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { rc: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error) : "") };
    }),
    triage: inject?.triage ?? makeSessionTriage(repoDir, lokiDir, provider),
    decompose: inject?.decompose ?? makeSessionDecompose(repoDir, lokiDir, provider),
    runner: inject?.runner ?? ((ref, opts) => base(ref, { ...opts, env: userEnv })),
    estimate: inject?.estimate ?? (() => estimateFor(repoDir, undefined, { model: resolveModel(provider), env: process.env })), // F2: rough prior when no history
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
