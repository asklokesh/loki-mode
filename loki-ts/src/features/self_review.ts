// SR LOKI_E10_SELF_REVIEW: the pre-delivery review self-check. New file: no module owns a review that may EDIT the diff before delivery (stages/xreview.ts is a
// read-only reviewer that can only lower the verdict, after verify). Deterministic checks first, then at most one bounded resume of the implement session.
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { buildArtifacts, runOutputs, type Staged } from "../e10ext/commit_filter.ts";
import { outsideScope } from "../e10ext/scope.ts";
import type { Obj } from "../engine10/types.ts";
import { contributionGuides, releaseNoteConvention, releaseNoteProblems, renameInventedFragment, stripInventedRefsInFile, taskForbidsReleaseNote, taskNumbers, towncrierNoNumberPrefix } from "../project_model/conventions.ts";
import { detectFormatters } from "../runner/repo_profile.ts";
import { safeGit } from "../util/safe_git.ts";
import { isTestFile as narrowTestFile } from "../util/test_file_text.ts";
/** A test file by name or location in any common layout (the shared helper misses Rust tests.rs, a top-level test/ dir, __tests__/, JVM *Test sources). */
const TEST_DIR = /(?:^|\/)(?:tests?|__tests__|specs?|testing|[a-z]*Test)\//, TEST_NAME = /(?:^|\/)(?:tests?\.[a-z]+|test_[^/]+|[^/]+_tests?\.[a-z]+|[^/]+\.(?:test|spec)\.[a-z]+|[A-Z][^/]*Tests?\.(?:kt|java|cs|scala|swift|groovy))$/;
export const isTestFile = (f: string): boolean => narrowTestFile(f) || TEST_DIR.test(f) || TEST_NAME.test(f);

/** Off (`0`), `on` (default: the turn runs only when a deterministic item flags, so a clean minimal diff is never touched and costs nothing), or `always`. */
export type SelfReviewMode = "off" | "on" | "always";
export const selfReviewMode = (env: NodeJS.ProcessEnv = process.env): SelfReviewMode => { const v = (env["LOKI_E10_SELF_REVIEW"] ?? "").trim().toLowerCase(); return /^(0|off|false|no)$/.test(v) ? "off" : v === "always" ? "always" : "on"; };
/** The turn cap of the review resume (cost cap); LOKI_E10_SELF_REVIEW_MAX_TURNS overrides, 0 or junk keeps the default. */
export const SELF_REVIEW_MAX_TURNS = 12;
export const selfReviewMaxTurns = (env: NodeJS.ProcessEnv = process.env): number => { const n = Number((env["LOKI_E10_SELF_REVIEW_MAX_TURNS"] ?? "").trim()); return Number.isInteger(n) && n > 0 ? n : SELF_REVIEW_MAX_TURNS; };

export type ItemKey = "release_note" | "stray_files" | "test" | "format" | "scope";
export type ItemStatus = "ok" | "flagged" | "fixed" | "justified" | "unresolved" | "auto";
export interface ReviewItem { item: ItemKey; status: ItemStatus; detail: string }
const SRC_EXT = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|rb|php|cs|swift|scala|c|cc|cpp|h|hpp|ex|exs|clj|dart|lua)$/;
const STYLE_FILES = [".editorconfig", ".prettierrc", ".prettierrc.json", "prettier.config.js", "biome.json", "rustfmt.toml", ".rustfmt.toml", "ruff.toml", ".ruff.toml", ".flake8", "setup.cfg", "tox.ini", ".golangci.yml", ".golangci.yaml", ".eslintrc", ".eslintrc.json", ".eslintrc.js", "eslint.config.js", "eslint.config.mjs", ".clang-format", ".pre-commit-config.yaml", "checkstyle.xml", ".scalafmt.conf"];

/** The deterministic half: one item per rule, from the staged diff against base. No model call, never throws. */
export function selfReviewChecks(repoDir: string, baseSha: string, staged: Staged[], task: string, outputs: Partial<Record<string, Obj>>, env: NodeJS.ProcessEnv = process.env): ReviewItem[] {
  const live = staged.filter(({ st, f }) => (st === "A" || st === "M") && !f.startsWith(".loki/"));
  const files = live.map(({ f }) => f), src = files.filter((f) => SRC_EXT.test(f) && !isTestFile(f)), tests = files.filter((f) => isTestFile(f));
  const items: ReviewItem[] = [];
  // (a) release note the repo's rules require
  const conv = (() => { try { return releaseNoteConvention(repoDir, env); } catch { return null; } })();
  const carried = conv ? files.some((f) => f === conv.dir || f.startsWith(`${conv.dir}/`)) : false;
  const refProblems = conv && carried && src.length > 0 ? (() => { try { return releaseNoteProblems(repoDir, conv, addedLines(repoDir, baseSha, live.filter(({ f }) => f === conv.dir || f.startsWith(`${conv.dir}/`))), files, task, env); } catch { return []; } })() : [];
  if (refProblems.length) items.push({ item: "release_note", status: "flagged", detail: refProblems.slice(0, 4).join("; ") }); else
  items.push(!conv || src.length === 0 || taskForbidsReleaseNote(task) ? { item: "release_note", status: "ok", detail: conv ? (src.length === 0 ? "no source change" : "the task says no release note") : "the repo states no release-note rule" }
    : carried ? { item: "release_note", status: "ok", detail: `the diff carries ${conv.kind === "changelog" ? `an entry in ${conv.dir}` : `a ${conv.kind} fragment in ${conv.dir}/`}` }
    : { item: "release_note", status: "flagged", detail: conv.kind === "changelog" ? `the contribution guide asks for an entry in ${conv.dir} (under "${conv.heading ?? "Unreleased"}") and the diff has none` : `the repo keeps ${conv.kind} release notes in ${conv.dir}/ and the diff has no fragment${conv.kind === "towncrier" && taskNumbers(task).length === 0 && towncrierNoNumberPrefix(repoDir, conv.dir, env) ? `; the task gives no issue or PR number, so add it in towncrier's orphan form ${conv.dir}/${towncrierNoNumberPrefix(repoDir, conv.dir, env)}<short-slug>.<type> (the same type and extension as the existing fragments) rather than skipping it or inventing a number` : ""}` }); // TN: a missing number is never a reason to ship no fragment
  // (b) stray, generated or unrelated files: build output (the commit filter drops it) and added files in a directory the repo has never tracked
  const added = live.filter(({ st }) => st === "A").map(({ f }) => f);
  const art = (() => { try { return [...new Set([...buildArtifacts(repoDir, added, baseSha, task), ...runOutputs(repoDir, added, baseSha, task)])]; } catch { return []; } })(); // the commit filter drops these (GB, RO)
  const trackedDirs = (() => { try { return new Set(safeGit(repoDir, ["ls-tree", "-r", "--name-only", baseSha], { maxBuffer: 256 << 20 }).split("\n").filter(Boolean).map((f) => dirname(f))); } catch { return null; } })();
  const fragDir = conv && conv.kind !== "changelog" ? `${conv.dir}/` : null;
  const stray = trackedDirs ? added.filter((f) => !art.includes(f) && !isTestFile(f) && !(fragDir && f.startsWith(fragDir)) && !trackedDirs.has(dirname(f)) && !task.includes(f) && !task.includes(basename(f))) : [];
  items.push(stray.length ? { item: "stray_files", status: "flagged", detail: `new files outside every directory the repo tracks: ${stray.slice(0, 8).join(", ")}` } : art.length ? { item: "stray_files", status: "auto", detail: `build output the commit leaves out: ${art.slice(0, 8).join(", ")}` } : { item: "stray_files", status: "ok", detail: "no generated or stray file" });
  // (c) a test that exercises the change
  items.push(src.length === 0 ? { item: "test", status: "ok", detail: "no source change" } : tests.length ? { item: "test", status: "ok", detail: `test changes: ${tests.slice(0, 5).join(", ")}` } : { item: "test", status: "flagged", detail: `source changed (${src.slice(0, 5).join(", ")}) and the diff has no test` });
  // (d) formatter conformance: a configured formatter normalizes the changed files at commit; otherwise the model matches the style config
  const fmts = (() => { try { return detectFormatters(repoDir, env); } catch { return []; } })().filter((fm) => files.some((f) => fm.exts.test(f)));
  const style = STYLE_FILES.filter((s) => existsSync(join(repoDir, s)));
  items.push(fmts.length ? { item: "format", status: "auto", detail: `${fmts.map((f) => f.tool).join(", ")} formats the changed files at commit` } : { item: "format", status: "ok", detail: style.length ? `no runnable formatter; style config: ${style.join(", ")}` : "no formatter or style config" });
  // (e) scope: edits to existing files outside every scope signal
  const out = (() => { try { return outsideScope(outputs, live); } catch { return null; } })() ?? [];
  const outside = out.filter((f) => !(conv && (f === conv.dir || f.startsWith(`${conv.dir}/`))));
  items.push(outside.length ? { item: "scope", status: "flagged", detail: `edits outside the planned scope: ${outside.slice(0, 8).join(", ")}` } : { item: "scope", status: "ok", detail: "no edit outside the planned scope" });
  return items;
}

export const selfReviewWanted = (items: ReviewItem[], mode: SelfReviewMode): boolean => mode === "always" || (mode === "on" && items.some((i) => i.status === "flagged"));
const LABEL: Record<ItemKey, string> = { release_note: "release note", stray_files: "stray files", test: "test", format: "format", scope: "scope" };

/** The review turn's brief: the flagged items, the rules text (capped) and the style configs. Asks for edits only where a rule is concretely broken. */
export function selfReviewBrief(repoDir: string, items: ReviewItem[]): string {
  const guide = contributionGuides(repoDir).slice(0, 6000), style = STYLE_FILES.filter((s) => existsSync(join(repoDir, s)));
  const lines = items.map((i) => `- ${LABEL[i.item]}: ${i.status === "flagged" ? `FLAGGED: ${i.detail}` : i.detail}`);
  return [
    "Pre-delivery review. Before this change goes to a maintainer, review your final diff (run `git diff` and `git status`) against the repository's own rules and fix what a maintainer would reject. Check each item:",
    "(a) release note: a changelog, changeset or news-fragment entry the rules below require, written like the existing ones;",
    "(b) stray files: remove scratch, debug, generated or unrelated files you added;",
    "(c) test: a regression test that exercises the change, in the repository's own test location and style;",
    "(d) format: the changed lines follow the formatter and lint config and the surrounding code style;",
    "(e) scope: undo any edit the task does not need (drive-by refactors, unrelated files, changed public API it did not ask for).",
    "Deterministic checks found:", ...lines,
    "Change nothing that already follows the rules: no rewording, no reformatting of lines you did not change, no new edits beyond fixing a broken rule. If an item cannot or should not be changed, keep it and justify it.",
    "End your reply with one line per item, exactly: `REVIEW <a|b|c|d|e>: ok|fixed|justified: <short reason>`, then LOKI_DONE.",
    style.length ? `Style and lint config in this repository: ${style.join(", ")}.` : "",
    guide ? `Contribution rules (CONTRIBUTING and PR template, as written):\n${guide}` : "The repository has no contribution guide or PR template.",
  ].filter(Boolean).join("\n");
}

const KEY_OF: Record<string, ItemKey> = { a: "release_note", b: "stray_files", c: "test", d: "format", e: "scope" };
/** The REVIEW lines of the review turn's reply, by item. */
export function parseReviewLines(reply: string): Map<ItemKey, { verdict: string; reason: string }> {
  const m = new Map<ItemKey, { verdict: string; reason: string }>();
  for (const x of reply.matchAll(/^[ \t]*`?REVIEW[ \t]+([a-e])[ \t]*:[ \t]*(ok|fixed|justified)[ \t]*:?[ \t]*(.*?)`?[ \t]*$/gim)) m.set(KEY_OF[x[1]!.toLowerCase()]!, { verdict: x[2]!.toLowerCase(), reason: x[3]!.trim().slice(0, 200) });
  return m;
}
/** Final status per item: the after-turn deterministic check wins (a flag it no longer finds is fixed); a flag that persists is justified only with a stated reason. */
export function settleItems(before: ReviewItem[], after: ReviewItem[] | null, reply: string | null): ReviewItem[] {
  const said = reply ? parseReviewLines(reply) : new Map();
  return before.map((b) => {
    if (b.status !== "flagged") return b;
    const a = after?.find((x) => x.item === b.item);
    if (a && a.status !== "flagged") return { item: b.item, status: "fixed", detail: `${b.detail}; now: ${a.detail}` };
    const s = said.get(b.item);
    return s && s.verdict === "justified" && s.reason ? { item: b.item, status: "justified", detail: `${b.detail}; reviewer: ${s.reason}` } : { item: b.item, status: after ? "unresolved" : "flagged", detail: b.detail };
  });
}
/** The receipt block; {} when the knob is off or nothing was recorded. */
export type SelfReviewRecord = { mode: string; turn: string | null; items: ReviewItem[] };
export const selfReviewReceiptBlock = (implement: Record<string, unknown> | undefined): { self_review?: SelfReviewRecord } => (implement && implement["self_review"] ? { self_review: implement["self_review"] as SelfReviewRecord } : {});
/** CR, deterministic: removes every issue or PR reference the task never gives from the release note the run added (changelog entry lines, changeset or towncrier
 *  fragment text). Runs after the review turn so a reference the model invented never ships. Returns `<path>: #N` per removal; [] when none or CR is off. */
export function stripInventedReleaseRefs(repoDir: string, baseSha: string, staged: Staged[], task: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const conv = (() => { try { return releaseNoteConvention(repoDir, env); } catch { return null; } })();
  if (!conv) return [];
  const out: string[] = [];
  for (const { st, f } of staged) {
    if (!(st === "A" || st === "M") || !(f === conv.dir || f.startsWith(`${conv.dir}/`))) continue;
    let base = ""; if (st === "M") { try { base = safeGit(repoDir, ["show", `${baseSha}:./${f}`], { maxBuffer: 64 << 20 }); } catch { base = ""; } }
    for (const n of stripInventedRefsInFile(join(repoDir, f), base, task, env)) out.push(`${f}: #${n}`);
    if (st === "A") { const r = renameInventedFragment(repoDir, conv, f, task, env); if (r) out.push(`renamed ${r}`); } // ON: an invented fragment number becomes the repo's orphan form
  }
  return out;
}
export const releaseRefsReceiptBlock = (implement: Record<string, unknown> | undefined): { changelog_refs_removed?: string[] } => (Array.isArray(implement?.["changelog_refs_removed"]) && (implement!["changelog_refs_removed"] as unknown[]).length ? { changelog_refs_removed: implement!["changelog_refs_removed"] as string[] } : {});
/** The lines each path adds against base: a diff of the working tree for a tracked path, the whole file for a new one. */
export function addedLines(repoDir: string, baseSha: string, paths: Staged[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const { st, f } of paths) {
    if (st === "A") { try { m.set(f, readFileSync(join(repoDir, f), "utf8").split("\n")); } catch { /* gone */ } continue; }
    try { m.set(f, safeGit(repoDir, ["diff", "--no-color", "-U0", baseSha, "--", f]).split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1))); } catch { /* unreadable */ }
  }
  return m;
}
/** The staged list against base for an uncommitted tree (index untouched: diff of the working tree plus untracked files). */
export function treeStaged(repoDir: string, baseSha: string): Staged[] {
  const out: Staged[] = [];
  try { const p = safeGit(repoDir, ["diff", "--name-status", "--no-renames", "-z", baseSha]).split("\0"); for (let i = 0; i + 1 < p.length; i += 2) if (p[i]) out.push({ st: p[i]!, f: p[i + 1]! }); } catch { /* unreadable: nothing */ }
  try { for (const f of safeGit(repoDir, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean)) if (!out.some((x) => x.f === f)) out.push({ st: "A", f }); } catch { /* none */ }
  return out;
}
