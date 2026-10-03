// FC-02 / Engine Law L5: who owns a runner load error. Shared by verify.ts and deep.ts (no stage-only patch).
// A load error is harness-owned (not_run, no fix rounds) only when ALL hold; any doubt keeps it a code failure (fail-safe):
//  (a) the same command reproduces the SAME load error (same signature, paths normalized) on a hermetic detached worktree at baseSha;
//      a base-only dependency or tool-missing error ("Cannot find module 'dep'", "command not found") is non-reproduction unless head names it too;
//  (b) no changed file is named in the error output (path, or module stem such as `from calc import`);
//  (c) the check is not a Wall test or a task-relevant test (callers pass `protect`), and its target file is not itself new or edited.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { classifyRunnerOutput } from "./runner_errors.ts";

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
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const suffixes = (segs: string[], min: number): string[] => segs.map((_, k) => segs.slice(k).join("/")).filter((x) => x.split("/").length >= min);
const bounded = (out: string, tok: string, tail: string): boolean => new RegExp(`(?<![\\w.-])${esc(tok)}${tail}`).test(out);

/** Changed files the error output names: by repo-relative path, by absolute path, by a package-relative suffix of the path
 *  (src/index.ts for packages/a/src/index.ts), by a Go import path ending in the file's directory (example.com/fx/calc for
 *  calc/add.go), or by whole-token module stem. */
export function changedFilesNamed(out: string, repoDir: string, changed: string[]): string[] {
  return changed.filter((f) => {
    if (out.includes(f) || out.includes(join(repoDir, f))) return true;
    const segs = f.split("/");
    if (suffixes(segs, 2).some((x) => x !== f && bounded(out, x, "(?![\\w-])"))) return true;
    if (extname(f) === ".go" && segs.length > 1 && suffixes(segs.slice(0, -1), 1).some((d) => new RegExp(`(?<=[\\w-])/${esc(d)}(?![\\w./-])`).test(out))) return true;
    const stem = basename(f, extname(f));
    if (stem.length < 2 || stem === "index" || stem === "__init__") return false; // generic names match by path only
    return new RegExp(`(?<![\\w-])${esc(stem)}(?![\\w-])`).test(out);
  });
}

/** Identity of a load error: the missing module or tool names, else the classified reason, with checkout roots normalized. */
function loadSignature(out: string, roots: string[]): { keys: Set<string>; reason: string } {
  let o = out;
  for (const r of roots.flatMap((x) => { try { return [x, realpathSync(x)]; } catch { return [x]; } }).sort((a, b) => b.length - a.length)) o = o.split(r).join("<repo>");
  const keys = new Set<string>();
  for (const m of o.matchAll(/Cannot find (?:module|package) '([^']+)'/g)) keys.add(`mod:${m[1]}`);
  for (const m of o.matchAll(/([\w.-]+): command not found/g)) keys.add(`cmd:${m[1]}`);
  return { keys, reason: (classifyRunnerOutput(o).reason ?? "").replace(/:\d+(?::\d+)?/g, "") };
}
/** True when base's load error is head's own error (not merely "also broken"): a hermetic base has no node_modules or tools, so
 *  its missing-dependency errors say nothing about head unless head names the same missing thing. */
function sameLoadError(head: string, base: string, headRoots: string[], baseRoots: string[]): boolean {
  const h = loadSignature(head, headRoots), b = loadSignature(base, baseRoots);
  if (b.keys.size) return h.keys.size > 0 && [...b.keys].every((k) => h.keys.has(k));
  return h.keys.size === 0 && h.reason === b.reason;
}

/** Process ids under pid (inclusive), found through pgrep -P; every pid is one this call spawned. */
function killTree(pid: number): void {
  const all = [pid];
  for (let k = 0; k < all.length; k++) {
    const kids = spawnSync("pgrep", ["-P", String(all[k])], { encoding: "utf8", env: process.env }).stdout.split(/\s+/).filter(Boolean).map(Number);
    all.push(...kids.filter((x) => Number.isInteger(x) && !all.includes(x)));
  }
  for (const p of all.reverse()) { try { process.kill(p, "SIGKILL"); } catch { /* already gone */ } }
}

/** The result comes from exit, the timeout or the abort, never pipe EOF (an orphaned grandchild may hold the pipes); on a cut the
 *  whole process tree is killed. Same pattern as verify.ts runOnce. */
export async function runOnBase(i: LoadOwnerInput, dir: string): Promise<string | null> {
  const sub = (s: string): string => s.split(i.repoDir).join(dir);
  const stop = AbortSignal.any([i.signal, AbortSignal.timeout(i.timeoutMs ?? 60_000)]);
  try {
    const proc = Bun.spawn([sub(i.cmd), ...i.args.map(sub)], {
      cwd: sub(i.cwd ?? i.repoDir), stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...(i.env ?? {}) },
    });
    let tail = ""; const rs = [proc.stdout, proc.stderr].map((x) => x.getReader());
    const pumps = rs.map(async (r) => { const d = new TextDecoder(); for (;;) { const c = await r.read().catch(() => ({ done: true, value: undefined })); if (c.done) return; tail = (tail + d.decode(c.value, { stream: true })).slice(-65536); } });
    const cut = new Promise<null>((res) => { if (stop.aborted) res(null); else stop.addEventListener("abort", () => res(null), { once: true }); });
    const code = await Promise.race([proc.exited, cut]);
    if (code === null) { killTree(proc.pid); return null; }
    await Promise.race([Promise.all(pumps), new Promise((r) => setTimeout(r, 300))]); rs.forEach((r) => r.cancel().catch(() => {}));
    return stop.aborted || code === 0 ? null : tail;
  } catch { return null; }
}

/** Tracked changes against baseSha plus untracked files (same set as verify.ts changedFiles); unknown diff throws. */
function changedSince(repoDir: string, baseSha: string): string[] {
  const g = (a: string[]): string[] => execFileSync("git", a, { cwd: repoDir, encoding: "utf8", env: process.env }).split("\n").map((l) => l.trim()).filter(Boolean);
  return [...new Set([...g(["diff", "--name-only", baseSha]), ...g(["ls-files", "--others", "--exclude-standard"])])].filter((f) => !f.startsWith(".loki/"));
}

export async function loadErrorIsHarnessOwned(i: LoadOwnerInput): Promise<boolean> {
  if (i.protect || !i.baseSha || i.signal.aborted) return false;
  let changed: string[]; try { changed = changedSince(i.repoDir, i.baseSha); } catch { return false; } // unknown diff: fail-safe
  if (changedFilesNamed(i.out, i.repoDir, changed).length > 0) return false;
  if (i.args.some((a) => changed.includes(a.replace(/^\.\//, "")))) return false; // the target test file is the agent's own
  const dir = mkdtempSync(join(tmpdir(), "e10-loadown-"));
  const git = (args: string[]): void => { execFileSync("git", args, { cwd: i.repoDir, stdio: "ignore", env: process.env }); };
  try {
    git(["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", dir, i.baseSha]);
    const base = await runOnBase(i, dir);
    return base !== null && classifyRunnerOutput(base).kind === "load_error" && sameLoadError(i.out, base, [i.repoDir, ...(i.cwd ? [i.cwd] : [])], [dir]);
  } catch { return false; } finally {
    try { git(["worktree", "remove", "--force", dir]); } catch { /* pruned below */ }
    rmSync(dir, { recursive: true, force: true });
    try { git(["worktree", "prune"]); } catch { /* best effort */ }
  }
}

/** The one call every stage makes after a failed TEST run (verify, deep, per-package suites): the load-error reason when the
 *  failure is harness-owned, else undefined (a code failure). Static checks (kind "static") never come through here. */
export async function harnessLoadReason(i: LoadOwnerInput): Promise<string | undefined> {
  const c = classifyRunnerOutput(i.out);
  return c.kind === "load_error" && await loadErrorIsHarnessOwned(i) ? c.reason : undefined;
}
