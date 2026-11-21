// FC-02 / Engine Law L5: who owns a runner load error. Shared by verify.ts and deep.ts (no stage-only patch).
// A load error is harness-owned (not_run, no fix rounds) only when ALL hold; any doubt keeps it a code failure (fail-safe):
//  (a) the same command reproduces the SAME load error (same signature, paths normalized) on a hermetic detached worktree at baseSha;
//      a base-only dependency or tool-missing error ("Cannot find module 'dep'", "command not found") is non-reproduction unless head names it too;
//  (b) no changed file is named in the error output (path, or module stem such as `from calc import`);
//  (c) the check is not a Wall test or a task-relevant test (callers pass `protect`), and its target file is not itself new or edited.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { classifyRunnerOutput } from "./runner_errors.ts";
import { safeGit } from "../util/safe_git.ts";
import { plainTestEnv, stripAnsi } from "../util/check_result.ts";
import { escapeRegex } from "../util/regex_escape.ts";

export interface LoadOwnerInput {
  repoDir: string;
  baseSha: string;
  out: string;
  cmd: string;
  args: string[];
  signal: AbortSignal;
  protect?: boolean; // Wall or task-relevant check
  cwd?: string; // directory the check ran in (a package dir); defaults to repoDir, mapped into the base worktree
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  skip?: (f: string) => boolean; // install-created paths (FC-DEPS-NOT-INSTALLED): not the code's change
}

const suffixes = (segs: string[], min: number): string[] => segs.map((_, k) => segs.slice(k).join("/")).filter((x) => x.split("/").length >= min);
const bounded = (out: string, tok: string, tail: string): boolean => new RegExp(`(?<![\\w.-])${escapeRegex(tok)}${tail}`).test(out);

/** Changed files the error output names: by repo-relative path, by absolute path, by a package-relative suffix of the path
 *  (src/index.ts for packages/a/src/index.ts), by a Go import path ending in the file's directory (example.com/fx/calc for
 *  calc/add.go), or by whole-token module stem. */
export function changedFilesNamed(out: string, repoDir: string, changed: string[]): string[] {
  return changed.filter((f) => {
    if (out.includes(f) || out.includes(join(repoDir, f))) return true;
    const segs = f.split("/");
    if (suffixes(segs, 2).some((x) => x !== f && bounded(out, x, "(?![\\w-])"))) return true;
    if (extname(f) === ".go" && segs.length > 1 && suffixes(segs.slice(0, -1), 1).some((d) => new RegExp(`(?<=[\\w-])/${escapeRegex(d)}(?![\\w./-])`).test(out))) return true;
    const stem = basename(f, extname(f));
    if (stem.length < 2 || stem === "index" || stem === "__init__") return false; // generic names match by path only
    return new RegExp(`(?<![\\w-])${escapeRegex(stem)}(?![\\w-])`).test(out);
  });
}

/** Identity of a load error: the missing module or tool names, else the classified reason, with checkout roots normalized. Exported for the
 *  UNRUNNABLE-EXTERNAL cell that guards it: Python's `No module named` is deliberately not a key here (see missingModules). */
export function loadSignature(out: string, roots: string[]): { keys: Set<string>; reason: string } {
  let o = out;
  for (const r of roots.flatMap((x) => { try { return [x, realpathSync(x)]; } catch { return [x]; } }).sort((a, b) => b.length - a.length)) o = o.split(r).join("<repo>");
  const keys = new Set<string>();
  for (const m of o.matchAll(/Cannot find (?:module|package) '([^']+)'/g)) keys.add(`mod:${m[1]}`);
  for (const m of o.matchAll(/([\w.-]+): command not found/g)) keys.add(`cmd:${m[1]}`);
  for (const m of o.matchAll(/^(?:\S+: )?\d+: ([\w.-]+): not found$/gm)) keys.add(`cmd:${m[1]}`); // POSIX sh
  for (const m of o.matchAll(/canceled due to missing packages[^\[\n]*\[([^\]\n]*)\]/g)) for (const p of (m[1] ?? "").split(",")) { const n = p.trim().replace(/^["']|["']$/g, "").replace(/(?<=.)@[^@/]*$/, ""); if (n) keys.add(`pkg:${n}`); } // npx
  return { keys, reason: (classifyRunnerOutput(o).reason ?? "").replace(/:\d+(?::\d+)?/g, "") };
}
/** True when base's load error is head's own error (not merely "also broken"): a hermetic base has no node_modules or tools, so
 *  its missing-dependency errors say nothing about head unless head names the same missing thing. */
function sameLoadError(head: string, base: string, headRoots: string[], baseRoots: string[]): boolean {
  const h = loadSignature(head, headRoots), b = loadSignature(base, baseRoots);
  if (b.keys.size) return h.keys.size > 0 && [...b.keys].every((k) => h.keys.has(k));
  return h.keys.size === 0 && h.reason === b.reason;
}

/** UNRUNNABLE-EXTERNAL (LOKI_E10_UNRUNNABLE_EXTERNAL, runner/repo_profile.ts unrunnableExternalOn): the sorted distinct module names a load error says are
 *  missing: Python `No module named '<name>'` and JS `Cannot find module '<name>'` / `Cannot find package '<name>'`, checkout roots normalized as
 *  loadSignature does. Used only for externalMissing; loadSignature and sameLoadError keep their keys, so no not_run versus fail decision moves. */
export function missingModules(out: string, roots: readonly string[] = []): string[] {
  let o = out;
  for (const r of roots.flatMap((x) => { try { return [x, realpathSync(x)]; } catch { return [x]; } }).sort((a, b) => b.length - a.length)) o = o.split(r).join("<repo>");
  const names = new Set<string>();
  for (const m of o.matchAll(/No module named '([^']+)'/g)) names.add(m[1]!);
  for (const m of o.matchAll(/Cannot find (?:module|package) '([^']+)'/g)) names.add(m[1]!);
  return [...names].sort();
}
/** UNRUNNABLE-EXTERNAL: the modules both sides are missing and the repo does not provide, or []. All of: head names at least one; the base run names the
 *  same SET (set equality, not base subset of head: a module only head misses is the change's doing); and no name's top segment is provided by the repo
 *  (`provided`: the repo's own package, a test helper directory, a workspace package). Any doubt is []. */
export function externalMissing(head: readonly string[], base: readonly string[], provided: (top: string) => boolean): string[] {
  const h = [...new Set(head)].sort(), b = new Set(base);
  if (h.length === 0 || h.length !== b.size || h.some((n) => !b.has(n))) return [];
  const tops = (n: string): string[] => [n.split(".")[0]!, n.startsWith("@") ? n.split("/").slice(0, 2).join("/") : n.split("/")[0]!];
  return h.some((n) => tops(n).some((t) => provided(t))) ? [] : h;
}
/** UNRUNNABLE-EXTERNAL: true when the repo provides module `top`, read on every root given (the checkout, the base worktree, the check's own cwd on each):
 *  a Python `<top>.py` or `<top>/` at a root or under its `src/`, a changed file whose stem is `top`, a JS relative or absolute specifier or a path inside
 *  a checkout (`<repo>/...` after missingModules), or a bare
 *  specifier that a package.json of the repo (outside node_modules) declares as its `name`. A listing or a package.json that cannot be read counts as
 *  provided (fail closed: the module may be the repo's own, so the check keeps holding). */
export function repoProvides(top: string, roots: readonly string[], changed: readonly string[], repoDir: string): boolean {
  if (!top || /^[./#<]/.test(top) || top.startsWith("node:")) return true; // `<repo>`: a path inside a checkout, normalized by missingModules
  for (const r of roots) for (const d of [r, join(r, "src")]) if (existsSync(join(d, `${top}.py`)) || existsSync(join(d, top))) return true;
  if (changed.some((f) => basename(f, extname(f)) === top)) return true;
  try {
    const files = safeGit(repoDir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter((f) => /(?:^|\/)package\.json$/.test(f) && !/(?:^|\/)node_modules\//.test(f));
    for (const f of files) { const n = (JSON.parse(readFileSync(join(repoDir, f), "utf8")) as { name?: unknown }).name; if (n === top) return true; }
  } catch { return true; }
  return false;
}

/** Process ids under pid (inclusive), found through pgrep -P; every pid is one this call spawned. */
function killTree(pid: number): void {
  const all = [pid]; // snapshot the pgrep tree first, then kill the whole process group (the base run is spawned detached, so the group holds only this call's descendants, including ones reparented to init that pgrep -P cannot reach)
  for (let k = 0; k < all.length; k++) {
    const kids = spawnSync("pgrep", ["-P", String(all[k])], { encoding: "utf8", env: process.env }).stdout.split(/\s+/).filter(Boolean).map(Number);
    all.push(...kids.filter((x) => Number.isInteger(x) && !all.includes(x)));
  }
  try { if (Number.isInteger(pid) && pid > 1) process.kill(-pid, "SIGKILL"); } catch { /* not a group leader (kill(-pid) throws ESRCH, never another group) or already gone */ }
  for (const p of all.reverse()) { try { process.kill(p, "SIGKILL"); } catch { /* already gone */ } }
}

/** The result comes from exit, the timeout or the abort, never pipe EOF (an orphaned grandchild may hold the pipes); on a cut the
 *  whole process tree is killed. Same pattern as verify.ts runOnce. */
export async function runOnBase(i: LoadOwnerInput, dir: string): Promise<string | null> {
  const sub = (s: string): string => s.split(i.repoDir).join(dir);
  const stop = AbortSignal.any([i.signal, AbortSignal.timeout(i.timeoutMs ?? 60_000)]);
  try {
    const proc = Bun.spawn([sub(i.cmd), ...i.args.map(sub)], {
      cwd: sub(i.cwd ?? i.repoDir), stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true, env: { ...plainTestEnv(), ...(i.env ?? {}) }, // FC-69; // detached: its own process group, killed as a group on a cut
    });
    let tail = ""; const rs = [proc.stdout, proc.stderr].map((x) => x.getReader());
    const pumps = rs.map(async (r) => { const d = new TextDecoder(); for (;;) { const c = await r.read().catch(() => ({ done: true, value: undefined })); if (c.done) return; tail = (tail + d.decode(c.value, { stream: true })).slice(-65536); } });
    const cut = new Promise<null>((res) => { if (stop.aborted) res(null); else stop.addEventListener("abort", () => res(null), { once: true }); });
    const code = await Promise.race([proc.exited, cut]);
    if (code === null) { killTree(proc.pid); return null; }
    await Promise.race([Promise.all(pumps), new Promise((r) => setTimeout(r, 300))]); rs.forEach((r) => r.cancel().catch(() => {}));
    return stop.aborted || code === 0 ? null : stripAnsi(tail);
  } catch { return null; }
}

/** Tracked changes against baseSha plus untracked files (same set as verify.ts changedFiles); unknown diff throws. */
function changedSince(repoDir: string, baseSha: string, skip?: (f: string) => boolean): string[] {
  const g = (a: string[]): string[] => safeGit(repoDir, a).split("\n").map((l) => l.trim()).filter(Boolean);
  return [...new Set([...g(["diff", "--name-only", baseSha]), ...g(["ls-files", "--others", "--exclude-standard"])])].filter((f) => !f.startsWith(".loki/") && !skip?.(f));
}

/** The base worktree's view of a load error that is harness-owned: `then` reads the base run's output, the worktree and the changed files before the
 *  worktree is removed. undefined when any FC-02 condition fails (the same conditions loadErrorIsHarnessOwned has always applied). */
async function ownedOnBase<T>(i: LoadOwnerInput, then: (base: string, dir: string, changed: string[]) => T): Promise<T | undefined> {
  if (i.protect || !i.baseSha || i.signal.aborted) return undefined;
  let changed: string[]; try { changed = changedSince(i.repoDir, i.baseSha, i.skip); } catch { return undefined; } // unknown diff: fail-safe
  if (changedFilesNamed(i.out, i.repoDir, changed).length > 0) return undefined;
  if (i.args.some((a) => changed.includes(a.replace(/^\.\//, "")))) return undefined; // the target test file is the agent's own
  const dir = mkdtempSync(join(tmpdir(), "e10-loadown-"));
  const git = (args: string[]): void => { safeGit(i.repoDir, args, { stdio: "ignore" }); };
  try {
    git(["worktree", "add", "--detach", dir, i.baseSha]);
    const base = await runOnBase(i, dir);
    return base !== null && classifyRunnerOutput(base).kind === "load_error" && sameLoadError(i.out, base, [i.repoDir, ...(i.cwd ? [i.cwd] : [])], [dir]) ? then(base, dir, changed) : undefined;
  } catch { return undefined; } finally {
    try { git(["worktree", "remove", "--force", dir]); } catch { /* pruned below */ }
    rmSync(dir, { recursive: true, force: true });
    try { git(["worktree", "prune"]); } catch { /* best effort */ }
  }
}
export async function loadErrorIsHarnessOwned(i: LoadOwnerInput): Promise<boolean> {
  return (await ownedOnBase(i, () => true)) === true;
}

/** The one call every stage makes after a failed TEST run (verify, deep, per-package suites): the load-error reason when the
 *  failure is harness-owned, else undefined (a code failure). Static checks (kind "static") never come through here. */
export async function harnessLoadReason(i: LoadOwnerInput): Promise<string | undefined> {
  return (await harnessLoad(i))?.reason;
}
/** harnessLoadReason plus UNRUNNABLE-EXTERNAL's evidence: `external` is computed only after the FC-02 conditions accepted the load error as harness-owned
 *  (the base run reproduced it, no changed file is named, the target file is not the change's own), and holds the modules both sides miss that the repo
 *  does not provide (externalMissing), else []. */
export async function harnessLoad(i: LoadOwnerInput): Promise<{ reason: string; external: string[] } | undefined> {
  const c = classifyRunnerOutput(i.out);
  if (c.kind !== "load_error") return undefined;
  const headRoots = [i.repoDir, ...(i.cwd ? [i.cwd] : [])];
  const external = await ownedOnBase(i, (base, dir, changed) => {
    const sub = (x: string): string => x.split(i.repoDir).join(dir), roots = [...headRoots, ...headRoots.map(sub)];
    return externalMissing(missingModules(i.out, headRoots), missingModules(base, [dir]), (top) => repoProvides(top, roots, changed, i.repoDir));
  });
  return external === undefined ? undefined : { reason: c.reason ?? "", external };
}
