// ONE-PR: a split issue (MASS-2, issues_run.ts startIssueEpic) ends in ONE pull request for the issue, not one per slice.
// New file: no existing module owns building an integration branch from slice run branches. engine10/integrate.ts merges group
// units with --no-ff merges in the user's own checkout and stops at the first conflict; this file instead builds in a throwaway
// worktree, one commit per slice, and isolates a conflicting slice. Reused, never copied: rerunWalls/loadSealedWall (the
// slices' sealed Walls), composeGroupReceipt (one signed receipt over the slice receipts, weakest verdict wins), runPushPr,
// prTitle and issueLink (stages/pr.ts), splitCost (issues_epic.ts).
//   1. every slice still runs and verifies on its own branch (issues_epic.ts runEpicSlices, unchanged);
//   2. loki/<n>-combined starts at the epic's base commit; each slice that can carry dependents is applied in dependency order as
//      one commit "<id>: <title>": a 3-way apply of the slice's own change (its parent slice's tip, or the base, to its tip), so a
//      stacked slice never re-applies its parent, and independent chains land side by side, at any depth or width;
//   3. a conflict gets one bounded resolve session; it is accepted only with no unmerged path and no conflict marker left, else the
//      slice and its descendants are reset out and fall back to their own PRs, with the reason;
//   4. every combined slice's sealed Wall is rerun on the combined tree, plus the tests the combined change impacts (a failure that
//      also fails on the base is excused); one combined receipt lists each slice's verdict and can only lower it;
//   5. one PR for the issue with a per-slice section; per-slice PRs opened earlier are closed with "Combined into #N.";
//   6. fallback to per-slice PRs only for a conflicting slice, or for all when the combined diff exceeds LOKI_SPLIT_ONE_PR_MAX_FILES.
// LOKI_SPLIT_ONE_PR=0 restores one PR per slice. Every external effect is injectable (CombineIo) so tests never call a provider or GitHub.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { safeGitSpawn } from "../util/safe_git.ts";
import { rerunWalls, type WallResult, type WallSet } from "../util/group_integrate.ts";
import { loadSealedWall } from "../util/check_result.ts";
import { DEP_DIRS } from "../util/mutation_proof.ts";
import { composeGroupReceipt, compositeVerdict } from "../features/speed/seal_group.ts";
import type { TestRef } from "../engine10/types.ts";
import type { GhIssue } from "./issues_run.ts";

/** LOKI_SPLIT_ONE_PR: on by default (a founder UX rule: improvements ship on); 0, off, false or no restores one PR per slice. */
export const onePrEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_SPLIT_ONE_PR"] ?? "").trim());
export const DEFAULT_MAX_FILES = 150;
/** LOKI_SPLIT_ONE_PR_MAX_FILES: a combined diff over this many files is opened as per-slice PRs instead (default 150). */
export function oneMaxFiles(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env["LOKI_SPLIT_ONE_PR_MAX_FILES"]);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_FILES;
}
/** At most this many resolve sessions per combined branch: one per conflicting slice, bounded so a wide split cannot loop on conflicts. */
export const MAX_RESOLVES = 4;

export interface CombineSlice {
  id: string;
  title: string;
  parent: string | null;
  branch: string;
  verdict: string;
  /** The slice run's own task text (sliceTask); prTitle reads its slice head line for a fallback PR title. */
  task: string;
  /** Where its receipt was kept (<epic run>/slices/receipts/<run id>), and the worktree it ran in (the receipt's Wall paths are under it). */
  receiptDir?: string;
  worktree?: string;
  /** A per-slice PR opened earlier in the run, closed with "Combined into #N." once the combined PR is open. */
  pr?: string | null;
}
export interface Resolve { (o: { cwd: string; slice: CombineSlice; files: string[]; hunks: string }): Promise<{ usd: number | null }> }
export type PushPr = (a: { repoDir: string; branch: string; title: string; bodyFile: string; draft: boolean; pinnedOrigin: string; base?: string | null }) => { ok: true; url: string } | { ok: false; reason: string };
export interface CombineIo {
  resolve: Resolve;
  push: PushPr;
  /** gh with the user's credentials (closing an earlier per-slice PR); rc 0 is success. */
  gh: (args: readonly string[]) => { rc: number; stdout: string; stderr: string };
  /** Runs test files in a tree: one result per file (the Wall runner, RealBaseTestRunner.runEach). */
  runTests: (dir: string, refs: TestRef[]) => Promise<{ pass: number; fail: number; not_run: number }[]>;
  /** Test files the changed files impact (testmap.ts impactedRefs over buildTestMap). */
  impacted: (dir: string, changed: string[]) => TestRef[];
  /** One combined receipt over the slice receipts; returns its path and verdict. Injected so tests can seal without a signing key. */
  seal?: (groupDir: string, o: { baseRef: string; head: string; notProven: string[] }) => { path: string; receipt: Record<string, unknown> };
  title: (verdict: string, task: string) => string;
  link: (verdict: string) => string;
  say: (s: string) => void;
}
export interface CombineInput {
  repoDir: string;
  /** The epic's run dir: combined/ (receipt, PR bodies) is written under it. */
  runDir: string;
  slug: string;
  issue: GhIssue;
  baseSha: string;
  /** remote.origin.url read once before any provider ran (Rule of Two); null opens no PR. */
  pinnedOrigin: string | null;
  /** Slices that can carry dependents, in dependency order (the split's own order). */
  slices: CombineSlice[];
  /** Slices that did not finish (FAILED, SKIPPED, SPEC_CONFLICT, ...): named in the PR body, never applied. */
  excluded: { id: string; title: string; outcome: string }[];
  /** The issue's Cost text given the resolve sessions' costs (splitCostText over the slices and planning sessions). */
  costText: (resolveUsd: readonly (number | null)[]) => string;
  draft: boolean;
  env: NodeJS.ProcessEnv;
  io: CombineIo;
}
export interface FallbackPr { id: string; pr: string | null; reason: string }
export interface CombineResult {
  branch: string;
  /** The combined PR (null when none opened: no slice applied, no origin, push failed). */
  pr: string | null;
  verdict: string;
  /** Slices on the combined branch, in commit order, with their commit (null: the slice changed nothing). */
  commits: { id: string; sha: string | null; resolved: boolean }[];
  fallback: FallbackPr[];
  notProven: string[];
  receiptPath: string | null;
  resolveUsd: (number | null)[];
  /** Why the run did not end in one PR (all fell back, push failed); undefined when it did. */
  reason?: string;
}

const MARKER_RE = /^(<{7}|>{7})( |$)|^={7}$/m;
const one = (s: string): string => s.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 3)}...` : s);
const git = (dir: string, args: string[], env?: NodeJS.ProcessEnv) => safeGitSpawn(dir, args, { encoding: "utf8", ...(env ? { env } : {}) });
const out = (dir: string, args: string[]): string => { const r = git(dir, args); return r.status === 0 ? String(r.stdout).trim() : ""; };
const lines = (s: string): string[] => s.split("\n").map((l) => l.trim()).filter(Boolean);
const prNumber = (url: string): string => { const m = /\/pull\/(\d+)$/.exec(url); return m ? `#${m[1]}` : url; };

/** The combined branch name for issue N. */
export const combinedBranch = (n: number): string => `loki/${n}-combined`;

/** Files the combined change touches: the union of every slice's diff from the base. */
export function combinedFiles(repoDir: string, baseSha: string, slices: readonly CombineSlice[]): string[] {
  const all = new Set<string>();
  for (const s of slices) for (const f of lines(out(repoDir, ["-c", "core.quotePath=false", "diff", "--no-renames", "--name-only", baseSha, s.branch, "--", ".", ":(exclude).loki"]))) all.add(f);
  return [...all].sort();
}

/** Link the repo's dependency dirs (root and every ancestor of a file to test) into the combined tree, so a missing package never reads as a failing test. */
function linkDeps(repoDir: string, wt: string, rels: readonly string[]): void {
  const dirs = new Set<string>([""]);
  for (const r of rels) { const p = r.split("/").slice(0, -1); for (let k = 1; k <= p.length; k++) dirs.add(p.slice(0, k).join("/")); }
  for (const d of dirs) for (const dep of DEP_DIRS) {
    const src = join(repoDir, d, dep), dst = join(wt, d, dep);
    if (existsSync(src) && !existsSync(dst) && existsSync(dirname(dst))) { try { symlinkSync(src, dst); } catch { /* the test run reports what is missing */ } }
  }
}

/** The conflict hunks of each unmerged file in the tree, capped, for the resolve brief. */
function markerHunks(wt: string, files: readonly string[]): string {
  let h = "";
  for (const f of files.slice(0, 5)) {
    let t = ""; try { t = readFileSync(join(wt, f), "utf8"); } catch { /* deleted on one side */ }
    h += `--- ${f}\n${(t.match(/^<{7}[\s\S]*?^>{7}.*$/gm) ?? []).join("\n").slice(0, 1500)}\n`;
  }
  return h.slice(0, 4000);
}

/** The resolve brief: the same contract as a group conflict fix unit (features/speed/fix_units.ts): keep both sides' intent, no markers. */
export function resolveBrief(s: CombineSlice, files: readonly string[], hunks: string): string {
  return [
    `Resolve a merge conflict. The change of slice ${s.id} (${one(s.title)}) is being applied on top of the other slices of the same issue, and git stopped on a conflict.`,
    "Edit only the conflicted files below. Keep the intent of both sides, remove every conflict marker (<<<<<<<, =======, >>>>>>>). Do not commit, do not run git, do not touch other files.",
    `Conflicted files: ${files.join(", ") || "unknown"}`,
    hunks,
  ].join("\n\n");
}

/** One slice's section of a PR body: what changed, proof, not proven. Shared by the combined PR and a fallback PR. */
export function sliceSection(s: CombineSlice, o: { commit?: string | null; files: string[]; wall?: WallResult; resolved?: boolean; notProven: string[]; receiptSha?: string | null }): string {
  const np = o.notProven.filter((r) => r.trim() !== "");
  const wall = o.wall ? (o.wall.status === "pass" ? "its sealed Wall passed again on the combined tree" : o.wall.status === "no_wall" ? `no sealed Wall to rerun (${o.wall.reason ?? "none"})` : `its sealed Wall FAILED on the combined tree (${o.wall.reason ?? "unknown"})`) : "";
  return [
    `### ${s.id}: ${one(s.title)}`,
    `What changed: ${o.files.length === 0 ? "no file (the slice found its work already done)" : `${o.files.length} file${o.files.length === 1 ? "" : "s"}: ${clip(o.files.slice(0, 12).join(", "), 600)}${o.files.length > 12 ? `, +${o.files.length - 12} more` : ""}`}${o.commit ? ` (commit ${o.commit.slice(0, 12)})` : ""}${o.resolved ? "; applied after one resolve session settled a conflict with an earlier slice" : ""}.`,
    `Proof: the slice run sealed ${s.verdict}${o.receiptSha ? ` (receipt sha256 ${o.receiptSha.slice(0, 16)})` : ""}${wall ? `; ${wall}` : ""}.`,
    np.length === 0 ? "Not proven: nothing." : `Not proven:\n${np.slice(0, 10).map((r) => `- ${clip(one(r), 200)}`).join("\n")}${np.length > 10 ? `\n- (+${np.length - 10} more; the full list is in the slice receipt)` : ""}`,
    "",
  ].join("\n");
}

const readReceipt = (dir?: string): Record<string, unknown> | null => { try { return dir ? JSON.parse(readFileSync(join(dir, "receipt.json"), "utf8")) as Record<string, unknown> : null; } catch { return null; } };
const receiptNotProven = (r: Record<string, unknown> | null): string[] => (Array.isArray(r?.["not_proven"]) ? (r!["not_proven"] as unknown[]).filter((x): x is string => typeof x === "string") : []);

/** Apply one slice's own change on the combined tree as one commit. "conflict" leaves the tree mid-apply for a resolve. */
function applySlice(wt: string, s: CombineSlice, parentTip: string, env: NodeJS.ProcessEnv): { kind: "ok"; sha: string | null } | { kind: "conflict"; files: string[] } | { kind: "error"; reason: string } {
  const msg = `${s.id}: ${one(s.title)}`;
  const tree = out(wt, ["rev-parse", `${s.branch}^{tree}`]);
  if (!tree) return { kind: "error", reason: `cannot read ${s.branch}` };
  const st = git(wt, ["commit-tree", tree, "-p", parentTip, "-m", msg], env), syn = st.status === 0 ? String(st.stdout).trim() : ""; // the slice author's identity: a runner with no git identity cannot auto-detect one (#605 CI)
  if (!syn) return { kind: "error", reason: `cannot stage ${s.id}'s change` };
  const cp = git(wt, ["cherry-pick", "--no-commit", syn], env);
  if (cp.status !== 0) {
    const files = lines(out(wt, ["-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=U"]));
    if (files.length > 0) return { kind: "conflict", files };
    return { kind: "error", reason: `apply of ${s.id} failed: ${clip(one(String(cp.stderr)), 200)}` };
  }
  return commitStaged(wt, msg, env);
}
function commitStaged(wt: string, msg: string, env: NodeJS.ProcessEnv): { kind: "ok"; sha: string | null } | { kind: "error"; reason: string } {
  if (git(wt, ["diff", "--cached", "--quiet"]).status === 0) { git(wt, ["reset", "-q", "--hard", "HEAD"]); return { kind: "ok", sha: null }; } // nothing new: no empty commit
  const c = git(wt, ["commit", "-q", "--no-verify", "-m", msg], env);
  if (c.status !== 0) return { kind: "error", reason: `commit failed: ${clip(one(String(c.stderr)), 200)}` };
  return { kind: "ok", sha: out(wt, ["rev-parse", "HEAD"]) };
}
function resetTo(wt: string, sha: string): void {
  git(wt, ["cherry-pick", "--abort"]);
  git(wt, ["reset", "-q", "--hard", sha]);
  git(wt, ["clean", "-fdq", ...[...DEP_DIRS, ".loki"].flatMap((d) => ["-e", d])]);
}

/** Build, verify, seal and open the one PR for a split issue. Never throws: a failure falls back to per-slice PRs with the reason. */
export async function combineSlices(o: CombineInput): Promise<CombineResult> {
  const { io } = o, n = o.issue.number, branch = combinedBranch(n), dir = join(o.runDir, "combined");
  mkdirSync(dir, { recursive: true });
  const res: CombineResult = { branch, pr: null, verdict: "PARTIAL", commits: [], fallback: [], notProven: [], receiptPath: null, resolveUsd: [] };
  const byId = new Map(o.slices.map((s) => [s.id, s]));
  const filesOf = (s: CombineSlice): string[] => lines(out(o.repoDir, ["-c", "core.quotePath=false", "diff", "--no-renames", "--name-only", parentTipOf(s), s.branch, "--", ".", ":(exclude).loki"]));
  const parentTipOf = (s: CombineSlice): string => (s.parent && byId.has(s.parent) ? byId.get(s.parent)!.branch : out(o.repoDir, ["merge-base", s.branch, o.baseSha]) || o.baseSha);
  const dropped = new Map<string, string>();
  if (o.slices.length === 0) return { ...res, reason: "no slice finished, nothing to combine" };

  // 6. the size rule: a combined diff past the cap is opened as per-slice PRs, as before
  const files = combinedFiles(o.repoDir, o.baseSha, o.slices), max = oneMaxFiles(o.env);
  if (files.length > max) {
    const why = `the combined diff touches ${files.length} files, over LOKI_SPLIT_ONE_PR_MAX_FILES=${max}`;
    for (const s of o.slices) dropped.set(s.id, why);
    res.reason = `${why}; opened one PR per slice`;
    await publishFallback(o, dropped, res);
    return res;
  }

  // 2. the combined branch, built in a throwaway worktree at the epic's base
  const root = mkdtempSync(join(tmpdir(), "loki-combine-")), wt = join(root, "wt");
  const ident = identEnv(o.repoDir, o.slices[0]!.branch, o.env);
  try {
    const add = git(o.repoDir, ["worktree", "add", "-q", "-B", branch, wt, o.baseSha]);
    if (add.status !== 0) {
      for (const s of o.slices) dropped.set(s.id, "the combined branch could not be created");
      res.reason = `cannot create ${branch}: ${clip(one(String(add.stderr)), 160)}; opened one PR per slice`;
      await publishFallback(o, dropped, res);
      return res;
    }
    linkDeps(o.repoDir, wt, files);
    let resolves = 0;
    for (const s of o.slices) {
      if (s.parent && dropped.has(s.parent)) { dropped.set(s.id, `stacked on ${s.parent}, which could not be combined`); continue; }
      const pre = out(wt, ["rev-parse", "HEAD"]);
      let r = applySlice(wt, s, parentTipOf(s), ident), resolved = false;
      if (r.kind === "conflict") {
        const conflicted = r.files;
        if (resolves >= MAX_RESOLVES) r = { kind: "error", reason: `merge conflict in ${conflicted.join(", ")} with an earlier slice; the ${MAX_RESOLVES} resolve sessions are spent` };
        else {
          resolves++;
          io.say(`#${n} ${s.id} conflicts with an earlier slice in ${clip(conflicted.join(", "), 120)}; one resolve session\n`);
          try { res.resolveUsd.push((await io.resolve({ cwd: wt, slice: s, files: conflicted, hunks: markerHunks(wt, conflicted) })).usd); } catch { res.resolveUsd.push(null); }
          const marked = conflicted.filter((f) => { try { return MARKER_RE.test(readFileSync(join(wt, f), "utf8")); } catch { return false; } });
          if (marked.length === 0) git(wt, ["add", "-A", "--", ...conflicted]);
          const left = lines(out(wt, ["-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=U"]));
          if (marked.length > 0 || left.length > 0) r = { kind: "error", reason: `merge conflict in ${conflicted.join(", ")} with an earlier slice; the resolve session left ${marked.length > 0 ? `conflict markers in ${marked.join(", ")}` : `${left.join(", ")} unmerged`}` };
          else {
            git(wt, ["checkout", "-q", "--", "."]); // a stray edit outside the conflicted files never rides along
            const c = commitStaged(wt, `${s.id}: ${one(s.title)}`, ident);
            r = c; resolved = c.kind === "ok";
          }
        }
      }
      if (r.kind !== "ok") { resetTo(wt, pre); dropped.set(s.id, r.reason); continue; }
      res.commits.push({ id: s.id, sha: r.sha, resolved });
    }
    if (res.commits.length === 0) {
      res.reason = "no slice could be applied on the combined branch; opened one PR per slice";
      await publishFallback(o, dropped, res);
      return res;
    }
    const head = out(wt, ["rev-parse", "HEAD"]);

    // 4. verify on the combined tree: each combined slice's sealed Wall, then the tests the combined change impacts
    const ids = res.commits.map((c) => c.id), walls: WallSet = {};
    for (const id of ids) { const s = byId.get(id)!; walls[id] = s.receiptDir ? loadSealedWall(s.receiptDir, s.worktree ?? o.repoDir) : { files: [], problems: [], receiptMissing: true }; }
    let wallRes: Record<string, WallResult> = {};
    try { wallRes = await rerunWalls({ runEach: (d, refs) => io.runTests(d, refs) }, wt, ids, walls); } catch (e) { for (const id of ids) wallRes[id] = { status: "fail", reason: `Wall rerun error: ${(e as Error).message}` }; }
    for (const id of ids) if (wallRes[id]?.status === "fail") res.notProven.push(`combined: slice ${id} sealed Wall failed on the combined tree (${wallRes[id]!.reason ?? "unknown"})`);
    const changed = lines(out(wt, ["-c", "core.quotePath=false", "diff", "--no-renames", "--name-only", o.baseSha, "HEAD"]));
    let refs: TestRef[] = [];
    try { refs = io.impacted(wt, changed).slice(0, 200); } catch { refs = []; }
    const wallPaths = new Set(Object.values(walls).flatMap((w) => w.files.map((f) => f.rel)));
    refs = refs.filter((r) => !wallPaths.has(r.path));
    const red = refs.length ? await io.runTests(wt, refs).then((rs) => refs.filter((_, k) => (rs[k]?.fail ?? 0) > 0), () => refs) : [];
    if (red.length > 0) {
      const base = join(root, "base"), stillRed = new Set<string>();
      if (git(o.repoDir, ["worktree", "add", "-q", "--detach", base, o.baseSha]).status === 0) {
        linkDeps(o.repoDir, base, red.map((r) => r.path));
        try { const rs = await io.runTests(base, red); red.forEach((r, k) => { if ((rs[k]?.fail ?? 0) > 0) stillRed.add(r.path); }); } catch { /* unread base: the failure stands */ }
        git(o.repoDir, ["worktree", "remove", "--force", base]);
      }
      for (const r of red) if (!stillRed.has(r.path)) res.notProven.push(`combined: ${r.path} fails on the combined tree and passes on the base`);
    }
    if (git(wt, ["status", "--porcelain", "--untracked-files=no"]).stdout.trim() !== "") { git(wt, ["reset", "-q", "--hard", head]); }

    // 4. one combined receipt over the combined slices' receipts; the combined verdict is the weakest slice's, lowered by any combined miss
    const groupDir = join(dir, "seal"), unitsDir = join(groupDir, "group", "units");
    rmSync(groupDir, { recursive: true, force: true });
    try {
      for (const id of ids) { const s = byId.get(id)!; if (!s.receiptDir) throw new Error(`slice ${id} kept no receipt`); mkdirSync(join(unitsDir, id), { recursive: true }); for (const f of ["receipt.json", "events.jsonl"]) if (existsSync(join(s.receiptDir, f))) cpSync(join(s.receiptDir, f), join(unitsDir, id, f)); }
      writeFileSync(join(groupDir, "group", "manifest.json"), JSON.stringify({ group_id: `issue-${n}-combined`, units: ids.map((id) => ({ unit_id: id, goal: byId.get(id)!.title, files: filesOf(byId.get(id)!) })) }, null, 2) + "\n");
      const seal = io.seal ?? (await defaultSeal());
      const sealed = seal(groupDir, { baseRef: o.baseSha, head, notProven: res.notProven });
      res.receiptPath = sealed.path; res.verdict = String(sealed.receipt["verdict"] ?? "PARTIAL");
    } catch (e) {
      const v = compositeVerdict(ids.map((id) => byId.get(id)!.verdict));
      res.verdict = v === "VERIFIED" || v === "ALREADY_SATISFIED" ? "PARTIAL" : v;
      res.notProven.push(`combined: receipt not sealed (${clip(one((e as Error).message), 200)})`);
    }
    if (res.verdict === "ALREADY_SATISFIED") res.verdict = "VERIFIED"; // the combined branch holds a change, so it is a delivered change

    // 5. ONE PR for the issue
    const receiptSha = res.receiptPath ? String(readReceipt(dirname(res.receiptPath))?.["receipt_sha256"] ?? "") : "";
    const sections = res.commits.map((c) => { const s = byId.get(c.id)!, rec = readReceipt(s.receiptDir); return sliceSection(s, { commit: c.sha, files: filesOf(s), wall: wallRes[c.id], resolved: c.resolved, notProven: receiptNotProven(rec), receiptSha: typeof rec?.["receipt_sha256"] === "string" ? rec["receipt_sha256"] as string : null }); });
    const left = [...o.excluded.map((x) => `- ${x.id} ${one(x.title)}: not included, ${clip(one(x.outcome), 200)}`), ...[...dropped].map(([id, why]) => `- ${id} ${one(byId.get(id)?.title ?? "")}: opened as its own PR, ${clip(one(why), 240)}`)];
    const body = [
      `This pull request delivers ${o.slug}#${n} as one change. The issue was split into ${o.slices.length + o.excluded.length} slices; each ran and verified on its own branch, and ${res.commits.length} ${res.commits.length === 1 ? "is" : "are"} applied here in dependency order, one commit per slice.`,
      "",
      "## Combined proof",
      `Verdict: ${res.verdict} (the weakest slice verdict${res.notProven.length ? ", lowered by what the combined tree did not prove" : ""}).${receiptSha ? ` Combined receipt sha256 ${receiptSha.slice(0, 16)}, over ${ids.length} slice receipt${ids.length === 1 ? "" : "s"}.` : ""}`,
      `Combined tree: every slice's sealed Wall rerun, plus ${refs.length} impacted test file${refs.length === 1 ? "" : "s"}${red.length ? ` (${red.length} red, rerun on the base)` : ""}.`,
      ...(res.notProven.length ? ["Not proven on the combined tree:", ...res.notProven.slice(0, 10).map((r) => `- ${clip(r, 220)}`)] : []),
      `Cost: ${o.costText(res.resolveUsd)}`,
      ...(left.length ? ["", "## Not in this PR", ...left] : []),
      "",
      "## Slices",
      ...sections,
      o.io.link(dropped.size > 0 || o.excluded.length > 0 ? "PARTIAL" : res.verdict).trim(), // "Closes" only when this PR holds every slice; otherwise "Refs", so merging it never closes a half-delivered issue
    ].join("\n") + "\n";
    if (!o.pinnedOrigin) { res.reason = "no pinned origin: the combined branch was built but not pushed"; await publishFallback(o, dropped, res); return res; }
    const bodyFile = join(dir, "pr-body.md");
    writeFileSync(bodyFile, body);
    const pushed = io.push({ repoDir: o.repoDir, branch, title: io.title(res.verdict, ""), bodyFile, draft: o.draft || res.verdict !== "VERIFIED", pinnedOrigin: o.pinnedOrigin });
    if (!pushed.ok) {
      for (const c of res.commits) dropped.set(c.id, "the combined PR could not be opened");
      res.reason = `combined PR not opened (${clip(one(pushed.reason), 200)}); opened one PR per slice`;
      res.commits = [];
    } else {
      res.pr = pushed.url;
      for (const c of res.commits) { // per-slice PRs opened earlier in the run are superseded
        const url = byId.get(c.id)!.pr;
        if (url && url !== pushed.url && /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/.test(url)) {
          const g = io.gh(["pr", "close", url, "--comment", `Combined into ${prNumber(pushed.url)}.`]);
          if (g.rc !== 0) io.say(`#${n} could not close ${url} (gh exit ${g.rc})\n`);
        }
      }
    }
    await publishFallback(o, dropped, res);
    return res;
  } finally {
    git(o.repoDir, ["worktree", "remove", "--force", wt]);
    git(o.repoDir, ["worktree", "prune"]);
    rmSync(root, { recursive: true, force: true });
  }
}

/** The fallback: each slice that is not on the combined branch gets its own PR, parents first, stacked on its parent's branch when that also fell back. */
async function publishFallback(o: CombineInput, dropped: Map<string, string>, res: CombineResult): Promise<void> {
  if (dropped.size === 0) return;
  const pushedBranch = new Map<string, string>();
  for (const s of o.slices) {
    const why = dropped.get(s.id);
    if (why === undefined) continue;
    o.io.say(`#${o.issue.number} ${s.id} opens its own PR: ${clip(why, 200)}\n`);
    if (!o.pinnedOrigin) { res.fallback.push({ id: s.id, pr: null, reason: why }); continue; }
    const base = s.parent && pushedBranch.has(s.parent) ? pushedBranch.get(s.parent)! : null;
    const rec = readReceipt(s.receiptDir), dir = join(o.runDir, "combined"), bodyFile = join(dir, `pr-body-${s.id}.md`);
    const files = lines(out(o.repoDir, ["-c", "core.quotePath=false", "diff", "--no-renames", "--name-only", s.parent && o.slices.some((x) => x.id === s.parent) ? o.slices.find((x) => x.id === s.parent)!.branch : o.baseSha, s.branch, "--", ".", ":(exclude).loki"]));
    mkdirSync(dir, { recursive: true });
    writeFileSync(bodyFile, [`Slice ${s.id} of ${o.slug}#${o.issue.number}, opened as its own pull request because ${one(why)}.${s.parent && !base ? ` This branch also holds slice ${s.parent}${res.pr ? `, which is in ${res.pr}` : ""}; merge that first.` : ""}`, "", sliceSection(s, { files, notProven: receiptNotProven(rec), receiptSha: typeof rec?.["receipt_sha256"] === "string" ? rec["receipt_sha256"] as string : null }), o.io.link("PARTIAL").trim()].join("\n") + "\n");
    const p = s.pr ? { ok: true as const, url: s.pr } : o.io.push({ repoDir: o.repoDir, branch: s.branch, title: o.io.title(s.verdict, s.task), bodyFile, draft: true, pinnedOrigin: o.pinnedOrigin, base });
    if (p.ok) pushedBranch.set(s.id, s.branch);
    res.fallback.push({ id: s.id, pr: p.ok ? p.url : null, reason: p.ok ? why : `${why}; its PR was not opened (${clip(one(p.reason), 160)})` });
  }
}

/** Commit identity for the combined commits: the slice commits' own author, so the branch reads like the slices it holds. */
function identEnv(repoDir: string, tip: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const [name = "", email = ""] = out(repoDir, ["log", "-1", "--format=%an%x00%ae", tip]).split("\0");
  const n = name || "loki", e = email || "loki@loki.invalid";
  return { ...env, GIT_AUTHOR_NAME: n, GIT_AUTHOR_EMAIL: e, GIT_COMMITTER_NAME: n, GIT_COMMITTER_EMAIL: e };
}

async function defaultSeal(): Promise<NonNullable<CombineIo["seal"]>> {
  const { receiptSha256 } = await import("../engine10/stages/seal.ts");
  return (groupDir, o) => composeGroupReceipt(groupDir, receiptSha256 as never, o);
}

/** The real io: the Wall runner, the engine's test map, one resolve session through the engine's session runner. */
export async function defaultCombineIo(o: { repoDir: string; lokiDir: string; provider: string; gh: CombineIo["gh"]; say: CombineIo["say"]; runDir: string }): Promise<CombineIo> {
  const [{ RealBaseTestRunner }, { impactedRefs, buildTestMap }, pr] = await Promise.all([import("../engine10/stages/wall.ts"), import("../engine10/testmap.ts"), import("../engine10/stages/pr.ts")]);
  return {
    resolve: async ({ cwd, slice, files, hunks }) => {
      const { createSessionRunner } = await import("../engine10/session.ts");
      let usd: number | null = null;
      const runner = createSessionRunner({ provider: o.provider, lokiRoot: o.lokiDir, emit: (type, _s, data) => { if (type === "cost" && typeof data.usd === "number") usd = (usd ?? 0) + data.usd; } });
      await runner.run({ stage: "fix", brief: resolveBrief(slice, files, hunks), tier: "development", iterationId: `issues-combine-${slice.id}-${Date.now()}`, limitS: 600, signal: new AbortController().signal, cwd });
      return { usd };
    },
    push: (a) => pr.runPushPr(a),
    gh: o.gh,
    runTests: (dir, refs) => new RealBaseTestRunner().runEach(dir, refs, 4, true),
    impacted: (dir, changed) => impactedRefs(buildTestMap(dir), changed),
    title: (verdict, task) => pr.prTitle(verdict as never, o.runDir, task),
    link: (verdict) => pr.issueLink(o.runDir, verdict as never),
    say: o.say,
  };
}
