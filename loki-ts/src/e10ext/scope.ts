// D58 basic 3: the commit stage publishes only files the task needs. Scope signal (no model call): plan's relevant_files
// (repo-map keyword overlap) plus any path or basename the plan text or the task text names. No plan signal = undetermined.
import { basename } from "node:path";
import { isTestFile } from "../engine10/testmap.ts";
import type { Obj } from "../engine10/types.ts";
import { unitFence } from "../features/speed/unit_mode.ts";
import type { Staged } from "./commit_filter.ts";

export const SCOPE_UNDETERMINED = "scope not determined; all edits committed";
export const unrelatedNote = (f: string): string => `unrelated edit reverted: ${f}`;

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (text: string, name: string): boolean => new RegExp(`(?<![\\w./-])${esc(name)}(?![\\w-]|\\.\\w)`).test(text);

/** Staged edits to existing files that are neither in scope, tests, nor intake-time user dirt; null when no scope signal exists.
 *  New files (A) stay: a helper the task needs is not an "edit"; ponytail: a new unrelated file is still committed. */
export function unrelatedEdits(o: Partial<Record<string, Obj>>, staged: Staged[]): string[] | null {
  const rel = Array.isArray(o.plan?.relevant_files) ? (o.plan.relevant_files as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const plan = typeof o.plan?.plan === "string" ? o.plan.plan : "";
  if (rel.length === 0 && plan.trim() === "") return null;
  const text = `${plan}\n${typeof o.intake?.task === "string" ? o.intake.task : ""}`, pre = (o.intake?.preexisting_dirty ?? {}) as Record<string, string>;
  return staged.filter(({ st, f }) => st !== "A" && !isTestFile(f) && !(f in pre) && !rel.includes(f) && !mentions(text, f) && !mentions(text, basename(f))).map(({ f }) => f);
}

/** Reverts out-of-scope edits to base (index and disk, literal pathspecs). Returns the NOT PROVEN notes; null = restore failed. */
export async function revertUnrelated(git: (a: string[]) => Promise<{ code: number }>, base: string, o: Partial<Record<string, Obj>>, staged: Staged[]): Promise<string[] | null> {
  const fence = await unitFence(git, base, staged); // D61-11: null unless a unit spec is active
  if (fence && !fence.ok) return null;
  const rest = fence ? fence.kept : staged, un = unrelatedEdits(o, rest);
  if (un && un.length > 0 && (await git(["--literal-pathspecs", "restore", `--source=${base}`, "--staged", "--worktree", "--", ...un])).code !== 0) return null;
  return [...(fence?.notes ?? []), ...(un ? un.map(unrelatedNote) : rest.length > 0 ? [SCOPE_UNDETERMINED] : [])];
}
