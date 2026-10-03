// D58 basic 3: the commit stage publishes only files the task needs. Scope signal (no model call): plan's relevant_files
// (repo-map keyword overlap) plus any path or basename the plan text or the task text names. No plan signal = undetermined.
import { basename, dirname } from "node:path";
import { isTestFile } from "../engine10/testmap.ts";
import type { Obj } from "../engine10/types.ts";
import { unitFence } from "../features/speed/unit_mode.ts";
import type { Staged } from "./commit_filter.ts";

export const SCOPE_UNDETERMINED = "scope not determined; all edits committed";
export const unrelatedNote = (f: string): string => `unrelated edit reverted: ${f}`;

export const keptOutsideNote = (f: string): string => `kept, outside stated scope (matches the issue surface or a planned directory): ${f}`;

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (text: string, name: string): boolean => new RegExp(`(?<![\\w./-])${esc(name)}(?![\\w-]|\\.\\w)`).test(text);

const STOP = new Set(["the", "and", "for", "with", "that", "this", "all", "any", "src", "from", "into", "each", "across", "apply", "add", "use", "make"]);
const stem = (w: string): string => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);
/** Nouns the issue or plan names ("routes", "validation", "handlers"), singular-stemmed; directory segments matching one are the stated surface. */
const surfaceTokens = (text: string): Set<string> => new Set((text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []).filter((w) => !STOP.has(w)).map(stem));
const dirSegs = (f: string): string[] => f.split("/").slice(0, -1).map((d) => stem(d.toLowerCase()));

/** Existing-file edits split by the scope policy. `revert` = outside every signal (named in plan/contract/task, issue surface,
 *  planned directory); `kept` = kept only through the surface or directory inference, disclosed, never reverted.
 *  null when no scope signal exists. New files (A) stay: a helper the task needs is not an "edit". */
export function scopeDecision(o: Partial<Record<string, Obj>>, staged: Staged[]): { revert: string[]; kept: string[] } | null {
  const rel = Array.isArray(o.plan?.relevant_files) ? (o.plan.relevant_files as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const plan = typeof o.plan?.plan === "string" ? o.plan.plan : "";
  if (rel.length === 0 && plan.trim() === "") return null;
  const text = `${plan}\n${typeof o.intake?.task === "string" ? o.intake.task : ""}`, pre = (o.intake?.preexisting_dirty ?? {}) as Record<string, string>;
  const toks = surfaceTokens(text), plannedDirs = new Set(rel.map((r) => dirname(r)).filter((d) => d !== "."));
  const revert: string[] = [], kept: string[] = [];
  for (const { st, f } of staged) {
    if (st === "A" || isTestFile(f) || Object.hasOwn(pre, f) || rel.includes(f) || mentions(text, f) || mentions(text, basename(f))) continue;
    if (plannedDirs.has(dirname(f)) || dirSegs(f).some((d) => toks.has(d))) kept.push(f); else revert.push(f);
  }
  return { revert, kept };
}

/** Staged edits outside every scope signal (see scopeDecision); null when no scope signal exists. */
export function unrelatedEdits(o: Partial<Record<string, Obj>>, staged: Staged[]): string[] | null {
  return scopeDecision(o, staged)?.revert ?? null;
}

/** Reverts out-of-scope edits to base (index and disk, literal pathspecs). Returns the NOT PROVEN notes; null = restore failed. */
export async function revertUnrelated(git: (a: string[]) => Promise<{ code: number }>, base: string, o: Partial<Record<string, Obj>>, staged: Staged[]): Promise<string[] | null> {
  const fence = await unitFence(git, base, staged, process.env, (o.intake?.preexisting_dirty ?? {}) as Record<string, string>); // D61-11: null unless a unit spec is active
  if (fence && !fence.ok) return null;
  const rest = fence ? fence.kept : staged, dec = scopeDecision(o, rest), un = dec?.revert ?? null;
  if (un && un.length > 0 && (await git(["--literal-pathspecs", "restore", `--source=${base}`, "--staged", "--worktree", "--", ...un])).code !== 0) return null;
  return [...(fence?.notes ?? []), ...(dec ? [...dec.revert.map(unrelatedNote), ...dec.kept.map(keptOutsideNote)] : rest.length > 0 ? [SCOPE_UNDETERMINED] : [])];
}
