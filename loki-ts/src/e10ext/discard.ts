// D50-F1: an ALREADY_SATISFIED run must end with no source diff against base. Lives outside engine10 core to keep it under its line cap.
import type { Obj, StageResult } from "../engine10/types.ts";

type Git = (args: string[]) => Promise<{ out: string; code: number }>;

/** Run-level "nothing to change" signals, the same three seal's verdictOf honours. */
export function alreadySatisfied(o: Partial<Record<string, Obj>>): boolean {
  const b = (o.wall?.base_run ?? {}) as Obj;
  return o.intake?.already_satisfied === true || o.implement?.exit === "already_done" || (typeof b.pass === "number" && b.pass > 0 && b.fail === 0 && (b.not_run ?? 0) === 0);
}

/** Null when the run is not already-satisfied (nothing touched). Otherwise restores every staged path to base
 *  (except .loki/ and pre-existing dirt in `keep`) and resets HEAD and index to base; any git failure is a failed stage. */
export async function discardIfSatisfied(git: Git, base: string, o: Partial<Record<string, Obj>>, staged: { st: string; f: string }[], keep: Set<string>): Promise<StageResult | null> {
  if (!alreadySatisfied(o)) return null;
  const gone = staged.filter(({ f }) => !keep.has(f) && !f.startsWith(".loki/")), lit = ["--literal-pathspecs"];
  const del = gone.filter(({ st }) => st === "A").map(({ f }) => f), back = gone.filter(({ st }) => st !== "A").map(({ f }) => f);
  if ((del.length > 0 && (await git([...lit, "rm", "-q", "-f", "--", ...del])).code !== 0) || (back.length > 0 && (await git([...lit, "restore", `--source=${base}`, "--staged", "--worktree", "--", ...back])).code !== 0) || (await git(["reset", "-q", base])).code !== 0) return { status: "failed", data: {}, reason: "already-satisfied discard failed" };
  return { status: "completed", data: { committed: false, discarded: gone.length } };
}
