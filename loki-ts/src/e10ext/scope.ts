// D76: scope control is ADVISORY. It flags edits outside every scope signal and never reverts or drops them. Signals (no model call): the files
// plan-scope.json names (when present, that list is the scope), plan's relevant_files, any path or basename the plan, task or contract names,
// directories matching a noun of the issue, and planned directories. No plan signal = undetermined.
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isTestFile } from "../engine10/testmap.ts";
import type { Obj } from "../engine10/types.ts";
import { unitFlags } from "../features/speed/unit_mode.ts";
import { readPlanScope } from "../util/run_cap.ts";
import type { Staged } from "./commit_filter.ts";
import { escapeRegex } from "../util/regex_escape.ts";
import { defRe, extractSpecAtoms } from "../features/exec_spec.ts";

export const SCOPE_UNDETERMINED = "scope not determined; all edits committed";
export const outsideNote = (f: string): string => `outside stated scope: ${f}`;
const mentions = (text: string, name: string): boolean => new RegExp(`(?<![\\w./-])${escapeRegex(name)}(?![\\w-]|\\.\\w)`).test(text);

const STOP = new Set(["the", "and", "for", "with", "that", "this", "all", "any", "src", "from", "into", "each", "across", "apply", "add", "use", "make"]);
const stem = (w: string): string => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);
/** Nouns the issue or plan names ("routes", "validation", "handlers"), singular-stemmed; directory segments matching one are the stated surface. */
const surfaceTokens = (text: string): Set<string> => new Set((text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []).filter((w) => !STOP.has(w)).map(stem));
const dirSegs = (f: string): string[] => f.split("/").slice(0, -1).map((d) => stem(d.toLowerCase()));

/** Criteria text of the intake-time contract snapshot (LOKI_CONTRACT=1 only); files it names are in scope. */
function contractText(o: Partial<Record<string, Obj>>): string {
  const c = (o.intake?.contract_snapshot as { contract?: { criteria?: { text?: unknown }[] } | null } | undefined)?.contract;
  return Array.isArray(c?.criteria) ? c.criteria.map((x) => (typeof x?.text === "string" ? x.text : "")).join("\n") : "";
}

/** Staged edits to existing files outside every scope signal; null when no scope signal exists. They are flagged, never reverted.
 *  New files (A) are not edits; test files and intake-time user dirt are never flagged. When plan-scope.json names files (planFiles),
 *  that list is the scope: an edit to an existing file it does not name, and the plan, task or contract text does not name, is flagged;
 *  the relevant_files, directory and noun signals apply only without it (a plan naming "frontend/..." once put every frontend file in scope). */
export function outsideScope(o: Partial<Record<string, Obj>>, staged: Staged[], planFiles: string[] = []): string[] | null {
  const rel = Array.isArray(o.plan?.relevant_files) ? (o.plan.relevant_files as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const plan = typeof o.plan?.plan === "string" ? o.plan.plan : "";
  if (rel.length === 0 && plan.trim() === "" && planFiles.length === 0) return null;
  const text = `${plan}\n${typeof o.intake?.task === "string" ? o.intake.task : ""}\n${contractText(o)}`, pre = (o.intake?.preexisting_dirty ?? {}) as Record<string, string>;
  const kept = (f: string): boolean => isTestFile(f) || Object.hasOwn(pre, f) || mentions(text, f) || mentions(text, basename(f));
  if (planFiles.length > 0) return staged.filter(({ st, f }) => st !== "A" && !kept(f) && !planFiles.includes(f)).map(({ f }) => f);
  const toks = surfaceTokens(text), plannedDirs = new Set(rel.map((r) => dirname(r)).filter((d) => d !== "."));
  return staged.filter(({ st, f }) => st !== "A" && !kept(f) && !rel.includes(f) && !plannedDirs.has(dirname(f)) && !dirSegs(f).some((d) => toks.has(d))).map(({ f }) => f);
}

/** R3 LOKI_E10_PLAN_SCOPE_ANCHOR (default on, =0 opts out): plan-scope.json's list is the scope only when it holds something the task names. When the task names a
 *  file (its path, or its basename in the same case) or a symbol (a site atom of features/exec_spec.ts) and no listed file is one of those files or defines one of those
 *  symbols, the list is discarded ([]) and the other scope signals decide. The failure: a task's prose word "version" matched a VERSION file case-insensitively, that one
 *  file became the scope, and the real fix file, named only by its class, was flagged outside stated scope. A task that names nothing keeps the list. */
export const planScopeAnchorEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_PLAN_SCOPE_ANCHOR"] ?? "").trim());
export function anchoredPlanScope(files: string[], task: string, repoDir: string | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!files.length || !planScopeAnchorEnabled(env) || !task.trim()) return files;
  const syms = [...new Set(extractSpecAtoms(task).filter((a) => a.kind === "site").map((a) => a.text.split(".").pop()!).filter(Boolean))];
  const namesFile = (f: string): boolean => mentions(task, f) || mentions(task, basename(f));
  const defines = (f: string): boolean => { if (!repoDir || !syms.length) return false; let lines: string[]; try { lines = readFileSync(join(repoDir, f), "utf8").split("\n"); } catch { return false; } return syms.some((n) => { const re = defRe(n); return lines.some((l) => re.test(l)); }); };
  if (files.some((f) => namesFile(f) || defines(f))) return files;
  const namedSomething = syms.length > 0 || /[\w-]+\/[\w.-]+\.\w+|\b[\w-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|rb|php|cs|kt|swift|c|h|cpp)\b/.test(task); // a path or a source file name the task writes out
  return namedSomething ? [] : files;
}

/** Advisory scope pass: returns the NOT PROVEN notes for edits outside the stated scope (runDir holds plan-scope.json). Nothing is reverted or unstaged. */
export function flagOutsideScope(o: Partial<Record<string, Obj>>, staged: Staged[], runDir?: string, repoDir?: string): string[] {
  const unit = unitFlags(staged, process.env, (o.intake?.preexisting_dirty ?? {}) as Record<string, string>); // D61-11: null unless a unit spec is active
  const un = outsideScope(o, staged, runDir ? anchoredPlanScope(readPlanScope(runDir), typeof o.intake?.task === "string" ? o.intake.task : "", repoDir) : []), seen = new Set((unit ?? []).map(outsideNote));
  return [...(unit ?? []).map(outsideNote), ...(un ? un.map(outsideNote).filter((n) => !seen.has(n)) : staged.length > 0 ? [SCOPE_UNDETERMINED] : [])];
}

/** J3 LOKI_E10_SCOPE_TEST_DROP (default on, =0 opts out): the one non-advisory scope rule. A test file the run added or modified in an owner package (a Go directory, a JS/TS
 *  package with its own package.json) where the change has no non-test change, the package has source files, and the task names neither the file nor the package, is reset to
 *  base before commit with a NOT PROVEN note. Python layouts and files with no owner are never touched, nor is any source file, nor a test-only change (no source change anywhere).
 *  The failure it targets: a coverage pass adding a test to a neighbouring package the change never touched, which a reviewer reads as out of scope; on the tuning
 *  bench it fired on 3 such judge fails and on 0 of 160 lean runs. */
export const scopeTestDropEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_SCOPE_TEST_DROP"] ?? "").trim());
export const crossPackageTestNote = (f: string): string => `test-only edit outside the change's packages dropped: ${f} (no source change in its package, and the task does not name it)`;
const JS_EXT = /\.(?:[cm]?[jt]sx?)$/;
/** The owner package of a file: its directory for Go, the nearest directory holding a package.json for JS/TS (repo root included); null otherwise. */
function ownerOf(repoDir: string, f: string): { dir: string; name: string } | null {
  if (f.endsWith(".go")) { const d = dirname(f); return { dir: d, name: basename(d) }; }
  if (!JS_EXT.test(f)) return null;
  for (let d = dirname(f); ; d = dirname(d)) {
    const pj = join(repoDir, d, "package.json");
    if (existsSync(pj)) { let name = basename(d === "." ? repoDir : d); try { const n = (JSON.parse(readFileSync(pj, "utf8")) as { name?: unknown }).name; if (typeof n === "string") name = n; } catch { /* unreadable manifest: the directory name */ } return { dir: d, name }; }
    if (d === "." || d === "") return null;
  }
}
/** The staged test files to reset (see scopeTestDropEnabled). `tracked` lists the repo's tracked files (for "the package has source files"). */
export function crossPackageTestEdits(repoDir: string, staged: Staged[], task: string, tracked: readonly string[]): string[] {
  const live = staged.filter(({ st, f }) => (st === "A" || st === "M") && !f.startsWith(".loki/"));
  const src = live.filter(({ f }) => !isTestFile(f) && (f.endsWith(".go") || JS_EXT.test(f)));
  if (src.length === 0) return [];
  const srcOwners = new Set(src.map(({ f }) => ownerOf(repoDir, f)?.dir).filter((d): d is string => d !== undefined));
  const inPkg = (dir: string, f: string): boolean => dir === "." || f.startsWith(`${dir}/`);
  const hasSource = (o: { dir: string }, go: boolean): boolean => tracked.some((t) => !isTestFile(t) && (go ? dirname(t) === o.dir && t.endsWith(".go") : JS_EXT.test(t) && inPkg(o.dir, t) && ownerOf(repoDir, t)?.dir === o.dir));
  return live.filter(({ f }) => {
    if (!isTestFile(f)) return false;
    const o = ownerOf(repoDir, f); if (!o || srcOwners.has(o.dir)) return false;
    if (mentions(task, f) || mentions(task, basename(f)) || (o.dir !== "." && (mentions(task, o.dir) || mentions(task, basename(o.dir)))) || mentions(task, o.name)) return false;
    return hasSource(o, f.endsWith(".go"));
  }).map(({ f }) => f);
}
