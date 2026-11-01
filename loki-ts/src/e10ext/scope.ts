// D76: scope control is ADVISORY. It flags edits outside every scope signal and never reverts or drops them. Signals (no model call): the files
// plan-scope.json names (when present, that list is the scope), plan's relevant_files, any path or basename the plan, task or contract names,
// directories matching a noun of the issue, and planned directories. No plan signal = undetermined.
import { basename, dirname } from "node:path";
import { isTestFile } from "../engine10/testmap.ts";
import type { Obj } from "../engine10/types.ts";
import { unitFlags } from "../features/speed/unit_mode.ts";
import { readPlanScope } from "../util/run_cap.ts";
import type { Staged } from "./commit_filter.ts";

export const SCOPE_UNDETERMINED = "scope not determined; all edits committed";
export const outsideNote = (f: string): string => `outside stated scope: ${f}`;

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (text: string, name: string): boolean => new RegExp(`(?<![\\w./-])${esc(name)}(?![\\w-]|\\.\\w)`).test(text);

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

/** Advisory scope pass: returns the NOT PROVEN notes for edits outside the stated scope (runDir holds plan-scope.json). Nothing is reverted or unstaged. */
export function flagOutsideScope(o: Partial<Record<string, Obj>>, staged: Staged[], runDir?: string): string[] {
  const unit = unitFlags(staged, process.env, (o.intake?.preexisting_dirty ?? {}) as Record<string, string>); // D61-11: null unless a unit spec is active
  const un = outsideScope(o, staged, runDir ? readPlanScope(runDir) : []), seen = new Set((unit ?? []).map(outsideNote));
  return [...(unit ?? []).map(outsideNote), ...(un ? un.map(outsideNote).filter((n) => !seen.has(n)) : staged.length > 0 ? [SCOPE_UNDETERMINED] : [])];
}
