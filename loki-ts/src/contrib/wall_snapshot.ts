// WC-01b: pure filesystem helpers for the concurrent Wall (tree snapshot, changed-file listing). No verdict logic; machine.ts decides.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeGit, tokenFreeEnv } from "../util/safe_git.ts";
export const MANIFESTS = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|pyproject\.toml|poetry\.lock|Pipfile(\.lock)?|requirements[^/]*\.txt|setup\.py|setup\.cfg|go\.(mod|sum)|Cargo\.(toml|lock))$/;
/** WC-01b: a faithful copy of the pre-implement tree (ignored dep dirs, nested node_modules, untracked work, .git; not .loki or .claude/worktrees), taken before implement starts. A clone copy where the filesystem has one. Relative links inside it resolve inside the copy, never into the live repo.
 *  Bounded: the signal (wall limit or run cap) and a timeout kill the copy, and a size ceiling refuses it up front. Every failure is null, which means the Wall fails and nothing is installed. */
const run = (cmd: string, args: string[], signal: AbortSignal, timeout: number): Promise<{ ok: boolean; out: string }> =>
  new Promise((res) => { try { execFile(cmd, args, { maxBuffer: 1 << 24, timeout, signal, env: tokenFreeEnv(process.env) }, (err, out) => res({ ok: !err, out: String(out ?? "") })); } catch { res({ ok: false, out: "" }); } });
export async function snapshotTree(repoDir: string, signal: AbortSignal, o: { timeoutMs?: number; maxMb?: number } = {}): Promise<string | null> {
  const timeoutMs = o.timeoutMs ?? (Number(process.env.LOKI_E10_WALL_SNAPSHOT_TIMEOUT_S) || 120) * 1000, maxMb = o.maxMb ?? (Number(process.env.LOKI_E10_WALL_SNAPSHOT_MAX_MB) || 2048);
  if (signal.aborted) return null;
  const dir = mkdtempSync(join(tmpdir(), "e10-wallbase-")), fail = (): null => { rmSync(dir, { recursive: true, force: true }); return null; };
  try {
    const top = readdirSync(repoDir).filter((n) => n !== ".loki" && n !== ".claude").map((n) => join(repoDir, n));
    const claude = existsSync(join(repoDir, ".claude")) ? readdirSync(join(repoDir, ".claude")).filter((n) => n !== "worktrees").map((n) => join(repoDir, ".claude", n)) : [];
    const all = [...top, ...claude];
    if (!all.length) return dir;
    const du = await run("du", ["-sk", ...all], signal, Math.min(timeoutMs, 60_000));
    if (!du.ok || signal.aborted) return fail();
    const kb = du.out.split("\n").reduce((t, l) => t + (Number(l.split("\t")[0]) || 0), 0);
    if (kb > maxMb * 1024) return fail();
    const cp = process.platform === "darwin" ? ["-cR"] : ["-a", "--reflink=auto"];
    if (top.length && !(await run("cp", [...cp, ...top, dir], signal, timeoutMs)).ok) return fail();
    if (claude.length) { mkdirSync(join(dir, ".claude")); if (!(await run("cp", [...cp, ...claude, join(dir, ".claude")], signal, timeoutMs)).ok) return fail(); }
    return signal.aborted ? fail() : dir;
  } catch { return fail(); }
}
/** Files changed against baseSha (tracked diff plus untracked); null when git cannot say. */
export function changedSinceBase(repoDir: string, baseSha: string): string[] | null {
  try {
    const tracked = safeGit(repoDir, ["diff", "--name-only", baseSha], { repoDrivers: true }), untracked = safeGit(repoDir, ["ls-files", "--others", "--exclude-standard"], { repoDrivers: true });
    return `${tracked}\n${untracked}`.split("\n").filter(Boolean);
  } catch { return null; }
}
