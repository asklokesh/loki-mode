// D50-F1: an ALREADY_SATISFIED run must end with no source diff against base. Lives outside engine10 core to keep it under its line cap.
import { execFileSync } from "node:child_process"; import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs"; import { dirname, join, relative, sep } from "node:path";
import type { Obj, StageResult } from "../engine10/types.ts";

type Git = (args: string[]) => Promise<{ out: string; code: number }>;

/** r4: restore one file without ever following a link. Every parent component is lstat-checked (a symlink or non-dir throws),
 *  a non-regular or differing leaf is unlinked (empty dir: rmdir), and content is written with O_EXCL. */
export function safeRestore(repoDir: string, f: string, want: Buffer, mode: number): void {
  const root = realpathSync(repoDir), fp = join(root, f), rel = relative(root, dirname(fp));
  if (rel.startsWith("..")) throw new Error("outside repo");
  let cur = root;
  for (const part of rel === "" ? [] : rel.split(sep)) {
    cur = join(cur, part);
    let st; try { st = lstatSync(cur); } catch { mkdirSync(cur); continue; }
    if (!st.isDirectory()) throw new Error("parent is not a real directory");
  }
  let st; try { st = lstatSync(fp); } catch { st = null; }
  if (st?.isFile() && readFileSync(fp).equals(want)) { chmodSync(fp, mode); return; }
  if (st) { if (st.isDirectory()) rmdirSync(fp); else unlinkSync(fp); }
  const fd = openSync(fp, "wx", mode); try { writeFileSync(fd, want); } finally { closeSync(fd); }
  chmodSync(fp, mode);
}

/** Run-level "nothing to change" signals, the same three seal's verdictOf honours. */
export function alreadySatisfied(o: Partial<Record<string, Obj>>): boolean {
  const b = (o.wall?.base_run ?? {}) as Obj;
  return o.intake?.already_satisfied === true || o.implement?.exit === "already_done" || (typeof b.pass === "number" && b.pass > 0 && b.fail === 0 && (b.not_run ?? 0) === 0);
}

/** Null when the run is not already-satisfied (nothing touched). Otherwise restores every staged path to base
 *  (except .loki/ and pre-existing dirt in `keep`) and resets HEAD and index to base; any git failure is a failed stage. */
export async function discardIfSatisfied(git: Git, base: string, o: Partial<Record<string, Obj>>, staged: { st: string; f: string }[], keep: Set<string>, repoDir: string): Promise<StageResult | null> {
  if (!alreadySatisfied(o)) return null;
  const pre = (o.intake?.preexisting_dirty ?? {}) as Record<string, string>, own = new Set([...(Array.isArray(o.intake?.preexisting_untracked) ? o.intake.preexisting_untracked : []) as string[], ...Object.keys((o.intake?.preexisting_untracked_blobs ?? {}) as object)]); // r2: user files from intake are never touched
  const gone = staged.filter(({ f }) => !keep.has(f) && !own.has(f) && !(f in pre) && !f.startsWith(".loki/")), lit = ["--literal-pathspecs"];
  const del = gone.filter(({ st }) => st === "A").map(({ f }) => f), back = gone.filter(({ st }) => st !== "A").map(({ f }) => f);
  if ((del.length > 0 && (await git([...lit, "rm", "-q", "-f", "--", ...del])).code !== 0) || (back.length > 0 && (await git([...lit, "restore", `--source=${base}`, "--staged", "--worktree", "--", ...back])).code !== 0) || (await git(["reset", "-q", base])).code !== 0) return { status: "failed", data: {}, reason: "already-satisfied discard failed" };
  const notProven: string[] = []; // r3: every intake-untracked file goes back byte for byte from its blob
  for (const [f, v] of Object.entries((o.intake?.preexisting_untracked_blobs ?? {}) as Record<string, string>)) {
    const fp = join(repoDir, f);
    try {
      if (v.startsWith("!")) { const st = lstatSync(fp); if (`!${st.size}:${st.mtimeMs}:${st.ctimeMs}` !== v) throw new Error("changed, not snapshotted"); continue; }
      const [sha, mode] = v.split(" "), want = execFileSync("git", ["cat-file", "blob", sha!], { cwd: repoDir, env: process.env, maxBuffer: 1 << 28 });
      safeRestore(repoDir, f, want, parseInt(mode ?? "644", 8));
    } catch { notProven.push(f); }
  }
  // pre-existing dirty files go back to their intake blob; no blob = left as is
  for (const f of Object.keys(pre)) if (staged.some((s) => s.f === f) && !keep.has(f)) { try { writeFileSync(join(repoDir, f), execFileSync("git", ["cat-file", "blob", pre[f]!], { cwd: repoDir, env: process.env })); } catch { notProven.push(f); } }
  return { status: "completed", data: { committed: false, discarded: gone.length, ...(notProven.length > 0 ? { not_proven: notProven.map((f) => `pre-existing file not restored: ${f}`) } : {}) } };
}
