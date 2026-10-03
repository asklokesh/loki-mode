// D61-11 (D71): unit run mode. One unit of a parallel group runs as a full v10 run whose write set is a scope fence,
// whose brief carries only its own context pack (no transcript, no model-driven exploration) and whose token budget
// is fixed by the decomposer. Active only when LOKI_SPEED=1 and LOKI_UNIT_SPEC names a readable, valid spec file;
// otherwise every export is inert and the callers behave byte-identically. Data and fence only, no verdict logic.
import { readFileSync } from "node:fs";
import type { Staged } from "../../e10ext/commit_filter.ts";

export interface UnitSpec { id: string; writeSet: string[]; pack: string[]; tokenBudget: number }
export type Git = (a: string[]) => Promise<{ code: number }>;
export const unitOutsideNote = (f: string): string => `edit outside unit write set reverted: ${f}`;

const norm = (p: string): string => p.replace(/^\.\//, "");
const strs = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]).map(norm) : null);

/** The active unit spec, or null (speed off, no spec, unreadable or invalid: fail-safe to the ordinary run). */
export function unitSpec(env: NodeJS.ProcessEnv = process.env): UnitSpec | null {
  const path = env["LOKI_UNIT_SPEC"];
  if (env["LOKI_SPEED"] !== "1" || !path) return null;
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>, ws = strs(j.writeSet), pack = strs(j.pack), tb = j.tokenBudget;
    if (typeof j.id !== "string" || !j.id || !ws || ws.length === 0 || !pack || typeof tb !== "number" || !(tb > 0)) return null;
    return { id: j.id, writeSet: ws, pack, tokenBudget: tb };
  } catch { return null; }
}

/** A path is inside the write set when it equals an entry or sits under an entry that ends in "/". */
export const inWriteSet = (spec: UnitSpec, f: string): boolean => spec.writeSet.some((w) => (w.endsWith("/") ? f.startsWith(w) : f === w));

/** The brief context for a unit: only its pack files (repo-relative, no traversal). null when unit mode is off. */
export function unitBrief(env: NodeJS.ProcessEnv = process.env): string | null {
  const s = unitSpec(env);
  if (!s) return null;
  const files = s.pack.filter((f) => !/^([/~]|[A-Za-z]:[\\/])/.test(f) && !f.split(/[\\/]/).includes(".."));
  return files.length ? `Relevant files:\n${files.join("\n")}` : "";
}

/** Reverts every staged path outside the write set (edits restore to base; new files are removed), tests included.
 *  null when unit mode is off; ok false when a git step failed. `kept` is what the ordinary scope pass still sees. */
export async function unitFence(git: Git, base: string, staged: Staged[], env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; kept: Staged[]; notes: string[] } | null> {
  const s = unitSpec(env);
  if (!s) return null;
  const out = staged.filter(({ f }) => !inWriteSet(s, f)), kept = staged.filter(({ f }) => inWriteSet(s, f));
  const edits = out.filter(({ st }) => st !== "A").map(({ f }) => f), adds = out.filter(({ st }) => st === "A").map(({ f }) => f);
  const rs = edits.length ? await git(["--literal-pathspecs", "restore", `--source=${base}`, "--staged", "--worktree", "--", ...edits]) : { code: 0 };
  const rm = adds.length ? await git(["--literal-pathspecs", "rm", "-f", "-q", "--", ...adds]) : { code: 0 };
  return { ok: rs.code === 0 && rm.code === 0, kept, notes: out.map(({ f }) => unitOutsideNote(f)) };
}

/** Env additions the unit runner passes to the unit's worker so the existing cap path enforces the per-unit budget. */
export const unitCapEnv = (s: UnitSpec, usdPerMillionTokens: number): Record<string, string> => ({ LOKI_E10_MAX_COST_USD: String((s.tokenBudget * usdPerMillionTokens) / 1e6) });
