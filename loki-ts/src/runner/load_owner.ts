// FC-02 / Engine Law L5: who owns a runner load error. Shared by verify.ts and deep.ts (no stage-only patch).
// A load error is harness-owned (not_run, no fix rounds) only when ALL hold; any doubt keeps it a code failure (fail-safe):
//  (a) the same command reproduces a load error on a hermetic detached worktree at baseSha;
//  (b) no changed file is named in the error output (path, or module stem such as `from calc import`);
//  (c) the check is not a Wall test or a task-relevant test (callers pass `protect`), and its target file is not itself new or edited.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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

/** Changed files the error output names: by repo-relative path, by absolute path, or by whole-token module stem. */
export function changedFilesNamed(out: string, repoDir: string, changed: string[]): string[] {
  return changed.filter((f) => {
    if (out.includes(f) || out.includes(join(repoDir, f))) return true;
    const stem = basename(f, extname(f));
    if (stem.length < 2 || stem === "index" || stem === "__init__") return false; // generic names match by path only
    return new RegExp(`(?<![\\w-])${esc(stem)}(?![\\w-])`).test(out);
  });
}

async function runOnBase(i: LoadOwnerInput, dir: string): Promise<string | null> {
  const sub = (s: string): string => s.split(i.repoDir).join(dir);
  const timeout = AbortSignal.timeout(i.timeoutMs ?? 60_000);
  try {
    const proc = Bun.spawn([sub(i.cmd), ...i.args.map(sub)], {
      cwd: sub(i.cwd ?? i.repoDir), stdin: "ignore", stdout: "pipe", stderr: "pipe", signal: AbortSignal.any([i.signal, timeout]),
      env: { ...process.env, ...(i.env ?? {}) },
    });
    const [o, e] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    if (timeout.aborted || i.signal.aborted || code === 0) return null;
    return `${o}\n${e}`;
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
    return base !== null && classifyRunnerOutput(base).kind === "load_error";
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
