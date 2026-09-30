// loki-ts/src/e10ext/treeswap.ts
//
// Tree swap helper (docs/v10/SCORECARD-PLAN.md S41-12, docs/v10/DECISIONS.md
// D42(1)). Pure file-tree mechanics for merging a chosen parallel-attempt
// tree into the run's primary working tree so core verify and Seal run on
// the final tree. Returns/performs data moves only: no test runs, no
// pass/fail, no Wall or Seal writes, no verdict logic.
//
// D42(1) binds this module: it may not import stages/, seal.ts, verify.ts,
// wall.ts or verify_cmd.ts (except `import type`), and it never computes a
// verdict.
//
// Base is a git commit (the primary's HEAD before attempts started), not a
// filesystem snapshot: "clean" is defined by `git status`, and diffing
// against a real commit is the only way to tell tracked-changed from
// ignored. Snapshots stay in memory; this module never uses `git stash`
// (the stash stack is shared across worktrees, D42).

import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants as fsc,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const DEFAULT_EXCLUDES = [".loki", ".venv", "venv", "attempts"];

export interface DiffEntry {
  path: string; // posix-style relative path from the tree root
  kind: "file" | "delete";
  content?: Buffer;
  mode?: number;
  symlinkTarget?: string;
}

export class TreeSwapUnsafePathError extends Error {
  constructor(msg: string) {
    super(`treeswap: ${msg}`);
    this.name = "TreeSwapUnsafePathError";
  }
}

export interface SwapOptions {
  primaryRoot: string; // the run's working tree (D42: "the primary tree")
  attemptRoot: string; // the chosen attempt's worktree, under <runDir>/attempts/
  base: string; // git SHA both trees started from
  excludes?: string[];
  runDir?: string; // when set, the undo snapshot is persisted to <runDir>/treeswap-undo.json
}

// ---- git plumbing --------------------------------------------------------

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function pathspecs(excludes: string[]): string[] {
  return [".", ...excludes.map((e) => `:(exclude)${e}`)];
}

interface StatusEntry {
  status: "A" | "M" | "D" | "T";
  path: string;
}

// git diff --name-status against `base`, -z so paths with spaces are exact
// and unambiguous. --no-renames keeps every record a single status+path pair.
function diffAgainstBase(root: string, base: string, excludes: string[]): StatusEntry[] {
  const raw = execFileSync(
    "git",
    ["-C", root, "diff", "--name-status", "--no-renames", "-z", base, "--", ...pathspecs(excludes)],
    { encoding: "utf8" },
  );
  const parts = raw.split("\0").filter((p) => p.length > 0);
  const out: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const status = parts[i];
    const path = parts[i + 1];
    if (status === undefined || path === undefined) continue;
    out.push({ status: status as StatusEntry["status"], path });
  }
  return out;
}

function untrackedFiles(root: string, excludes: string[]): string[] {
  const raw = execFileSync(
    "git",
    ["-C", root, "ls-files", "-z", "--others", "--exclude-standard", "--", ...pathspecs(excludes)],
    { encoding: "utf8" },
  );
  return raw.split("\0").filter((p) => p.length > 0);
}

// ---- safe filesystem access ----------------------------------------------
//
// Every read, write and delete goes through safeJoin: it rejects absolute
// and `..` paths, and refuses any ancestor directory component that is a
// symlink, so a path can never be walked out of `root` on disk. A symlink
// *entry's* own target is checked separately (below), because that is data,
// not a filesystem path to open.

function isExcluded(relPath: string, excludes: string[]): boolean {
  // Excludes are top-level names only, matching the git pathspecs above;
  // a nested src/venv/ is ordinary content. .git is excluded at any depth.
  const segments = relPath.split("/");
  if (segments.includes(".git")) return true;
  return segments[0] !== undefined && excludes.includes(segments[0]);
}

function safeJoin(root: string, relPath: string): string {
  const segments = relPath.split("/").filter((s) => s.length > 0);
  if (relPath.startsWith("/") || segments.includes("..") || segments.includes(".") || segments.length === 0) {
    throw new TreeSwapUnsafePathError(`unsafe path ${relPath}`);
  }
  const rootAbs = resolve(root);
  let cur = rootAbs;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === undefined) continue;
    cur = join(cur, segment);
    if (i < segments.length - 1) {
      let st;
      try {
        st = lstatSync(cur);
      } catch {
        continue; // does not exist yet; a later mkdir creates a plain dir
      }
      if (st.isSymbolicLink()) {
        throw new TreeSwapUnsafePathError(`ancestor of ${relPath} is a symlink`);
      }
    }
  }
  return cur;
}

// A symlink's target must resolve to somewhere inside `root` once read
// relative to its own containing directory. Absolute targets are always
// refused: they carry no tree-relative meaning and cannot be validated.
const PROTECTED_TARGETS = [".git", ".loki", "attempts"];

function assertSymlinkWithinRoot(root: string, relPath: string, target: string): void {
  if (isAbsolute(target)) {
    throw new TreeSwapUnsafePathError(`symlink ${relPath} has an absolute target`);
  }
  const resolvedTarget = resolve(dirname(join(resolve(root), relPath)), target);
  const rel = relative(resolve(root), resolvedTarget);
  if (rel === ".." || rel.startsWith(`..${"/"}`) || isAbsolute(rel)) {
    throw new TreeSwapUnsafePathError(`symlink ${relPath} escapes tree root`);
  }
  const top = rel.split(sep)[0];
  if (top !== undefined && PROTECTED_TARGETS.includes(top)) {
    throw new TreeSwapUnsafePathError(`symlink ${relPath} targets protected path ${top}`);
  }
}

interface Entry {
  content?: Buffer;
  mode: number;
  symlinkTarget?: string;
}

function readEntry(root: string, relPath: string): Entry {
  const abs = safeJoin(root, relPath);
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) {
    const target = readlinkSync(abs);
    assertSymlinkWithinRoot(root, relPath, target);
    return { mode: st.mode & 0o777, symlinkTarget: target };
  }
  const fd = openSync(abs, fsc.O_RDONLY | fsc.O_NOFOLLOW);
  try {
    return { content: readFileSync(fd), mode: st.mode & 0o777 };
  } finally {
    closeSync(fd);
  }
}

function removeEntry(root: string, relPath: string): void {
  const abs = safeJoin(root, relPath);
  try {
    unlinkSync(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function writeEntry(root: string, relPath: string, entry: Entry): void {
  if (entry.symlinkTarget !== undefined) {
    assertSymlinkWithinRoot(root, relPath, entry.symlinkTarget);
  }
  const abs = safeJoin(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  removeEntry(root, relPath);
  if (entry.symlinkTarget !== undefined) {
    symlinkSync(entry.symlinkTarget, abs);
  } else {
    const fd = openSync(abs, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(fd, entry.content ?? Buffer.alloc(0));
      fchmodSync(fd, entry.mode); // the open mode is masked by umask
    } finally {
      closeSync(fd);
    }
  }
}

// ---- public API -----------------------------------------------------------

// Captures the chosen attempt's (or the primary's) departure from `base` as
// a flat diff: tracked changes plus untracked files, read straight off disk.
// Ignored files are never read (git ls-files --others --exclude-standard
// skips them), so applyDiff can never write or delete one.
export function snapshotDiff(root: string, base: string, excludes: string[] = DEFAULT_EXCLUDES): DiffEntry[] {
  const diff: DiffEntry[] = [];
  for (const { status, path } of diffAgainstBase(root, base, excludes)) {
    if (isExcluded(path, excludes)) continue;
    if (status === "D") {
      diff.push({ path, kind: "delete" });
    } else {
      const e = readEntry(root, path);
      diff.push({ path, kind: "file", content: e.content, mode: e.mode, symlinkTarget: e.symlinkTarget });
    }
  }
  for (const path of untrackedFiles(root, excludes)) {
    if (isExcluded(path, excludes)) continue;
    const e = readEntry(root, path);
    diff.push({ path, kind: "file", content: e.content, mode: e.mode, symlinkTarget: e.symlinkTarget });
  }
  return diff;
}

// Restores `root`'s tracked files (outside `excludes`) to exactly `base`,
// and, unless keepUntracked, removes untracked files. The untracked listing
// is taken BEFORE any checkout so the pre-reset .gitignore decides what is
// ignored: a file the current tree ignores is never deleted. `.loki/`,
// `.venv/`, `venv/` and the attempts dir are never touched.
export function resetToBase(
  root: string,
  base: string,
  excludes: string[] = DEFAULT_EXCLUDES,
  opts: { keepUntracked?: boolean } = {},
): void {
  const untracked = opts.keepUntracked ? [] : untrackedFiles(root, excludes).filter((p) => !isExcluded(p, excludes));
  const changed = diffAgainstBase(root, base, excludes).filter(({ path }) => !isExcluded(path, excludes));
  // M, D and T (type change, e.g. file <-> symlink) are all restored from base.
  const toRestore = changed.filter((c) => c.status !== "A").map((c) => c.path);
  const toDrop = changed.filter((c) => c.status === "A").map((c) => c.path);

  if (toRestore.length > 0) git(root, ["checkout", base, "--", ...toRestore]);
  for (const path of toDrop) {
    try {
      git(root, ["rm", "-f", "--ignore-unmatch", "-q", "--", path]);
    } catch {
      // not in the index (working-tree-only add); fall through to a plain delete
    }
    removeEntry(root, path);
  }
  for (const path of untracked) removeEntry(root, path);
}

// Applies a captured diff onto `root`. Deletes run first, deepest path
// first, before any write - so a diff can never delete through a symlink a
// later entry in the same diff creates. Every entry is re-validated against
// `root` (not just the tree the diff was captured from): a hand-built diff
// gets the same guarantees as one from snapshotDiff.
export function applyDiff(root: string, diff: DiffEntry[], excludes: string[] = DEFAULT_EXCLUDES): void {
  for (const entry of diff) {
    if (isExcluded(entry.path, excludes)) {
      throw new TreeSwapUnsafePathError(`refusing to touch excluded path ${entry.path}`);
    }
  }
  const deletes = diff
    .filter((e) => e.kind === "delete")
    .sort((a, b) => b.path.split("/").length - a.path.split("/").length);
  const writes = diff.filter((e) => e.kind === "file");

  for (const entry of deletes) removeEntry(root, entry.path);
  for (const entry of writes) {
    writeEntry(root, entry.path, { content: entry.content, mode: entry.mode ?? 0o644, symlinkTarget: entry.symlinkTarget });
  }
}

// Merges attemptRoot's departure from `base` into primaryRoot. Reads happen
// first (snapshotDiff of both trees): any failure there throws before
// primaryRoot is touched. If the write phase fails partway, primaryRoot is
// rolled back to the state it was in before this call, via the same two
// primitives run in reverse (a compensating action, not filesystem
// atomicity: primaryRoot sits inside a nested runDir, so a stage-and-rename
// swap is not available here).
export function swapAttemptIntoWorkingTree(opts: SwapOptions): void {
  const excludes = opts.excludes ?? DEFAULT_EXCLUDES;
  const winner = snapshotDiff(opts.attemptRoot, opts.base, excludes);
  const undo = snapshotDiff(opts.primaryRoot, opts.base, excludes);
  if (opts.runDir !== undefined) {
    mkdirSync(opts.runDir, { recursive: true });
    const json = undo.map((e) => ({ ...e, content: e.content?.toString("base64") }));
    writeFileSync(join(opts.runDir, "treeswap-undo.json"), JSON.stringify({ base: opts.base, entries: json }));
  }

  try {
    // Untracked files survive: the winner's diff overwrites any path it owns.
    resetToBase(opts.primaryRoot, opts.base, excludes, { keepUntracked: true });
    applyDiff(opts.primaryRoot, winner, excludes);
  } catch (err) {
    try {
      resetToBase(opts.primaryRoot, opts.base, excludes, { keepUntracked: true });
      // keepUntracked left any winner-written new file behind: drop those.
      const undone = new Set(undo.map((e) => e.path));
      for (const e of winner) {
        if (e.kind === "file" && !undone.has(e.path) && !inBase(opts.primaryRoot, opts.base, e.path)) {
          removeEntry(opts.primaryRoot, e.path);
        }
      }
      applyDiff(opts.primaryRoot, undo, excludes);
    } catch (rollbackErr) {
      throw new AggregateError([err, rollbackErr], "treeswap: swap failed and rollback also failed");
    }
    throw err;
  }
}

function inBase(root: string, base: string, path: string): boolean {
  try {
    git(root, ["cat-file", "-e", `${base}:${path}`]);
    return true;
  } catch {
    return false;
  }
}

// Removes a losing attempt's tree by exact path only (no glob). Refuses
// anything that is not a direct child of <runDir>/attempts, a symlink, or
// owned by another user. If the attempt is a linked git worktree (has a
// .git file, not directory), it is removed with `git worktree remove` so
// its registration under primaryRoot's .git/worktrees/ does not leak;
// otherwise it is a plain recursive delete.
export function cleanupAttempt(primaryRoot: string, runDir: string, attemptDir: string): void {
  // realpath only the run dir; the attempts dir and the attempt itself are
  // lstat'ed UNRESOLVED, since lstat on a realpath can never see a symlink.
  const attemptsRoot = join(realpathSync(resolve(runDir)), "attempts");
  let attemptsLst;
  try {
    attemptsLst = lstatSync(attemptsRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (attemptsLst.isSymbolicLink() || !attemptsLst.isDirectory()) {
    throw new TreeSwapUnsafePathError(`refusing a symlinked or non-directory attempts dir: ${attemptsRoot}`);
  }
  const realPrimary = realpathSync(resolve(primaryRoot));
  const isPrimaryOrAncestor = (p: string) => p === realPrimary || realPrimary.startsWith(p + sep);
  if (isPrimaryOrAncestor(realpathSync(attemptsRoot))) {
    throw new TreeSwapUnsafePathError(`attempts dir ${attemptsRoot} resolves to the primary tree`);
  }
  const lexical = resolve(attemptDir);
  const parent = dirname(lexical);
  let real: string;
  try {
    real = join(realpathSync(parent), lexical.slice(parent.length + 1));
    lstatSync(real);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // already gone
    throw err;
  }
  if (dirname(real) !== attemptsRoot) {
    throw new TreeSwapUnsafePathError(`${attemptDir} is not a direct child of ${attemptsRoot}`);
  }
  if (isPrimaryOrAncestor(real)) {
    throw new TreeSwapUnsafePathError(`${attemptDir} is or contains the primary tree`);
  }
  const lst = lstatSync(real);
  if (lst.isSymbolicLink()) {
    throw new TreeSwapUnsafePathError(`refusing a symlinked attempt dir: ${attemptDir}`);
  }
  if (!lst.isDirectory()) {
    throw new TreeSwapUnsafePathError(`${attemptDir} is not a directory`);
  }
  if (process.getuid && lst.uid !== process.getuid()) {
    throw new TreeSwapUnsafePathError(`refusing to remove ${attemptDir}: not owned by the current user`);
  }

  const gitFile = join(real, ".git");
  let isLinkedWorktree = false;
  try {
    isLinkedWorktree = lstatSync(gitFile).isFile();
  } catch {
    isLinkedWorktree = false;
  }
  if (isLinkedWorktree) {
    git(primaryRoot, ["worktree", "remove", "--force", "--", real]);
  } else {
    rmSync(real, { recursive: true, force: true });
  }
}
