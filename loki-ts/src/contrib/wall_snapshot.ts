// WC-01b: pure filesystem helpers for the concurrent Wall (tree snapshot, changed-file listing). No verdict logic; machine.ts decides.
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { escapeRegex } from "../util/regex_escape.ts";
import { safeGit, tokenFreeEnv } from "../util/safe_git.ts";
export const MANIFESTS = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|pyproject\.toml|poetry\.lock|Pipfile(\.lock)?|requirements[^/]*\.txt|setup\.py|setup\.cfg|go\.(mod|sum)|Cargo\.(toml|lock))$/;
/** WC-01b: a faithful copy of the pre-implement tree (ignored dep dirs, nested node_modules, untracked work, .git; not .loki or .claude/worktrees), taken before implement starts. A clone copy where the filesystem has one. Relative links inside it resolve inside the copy, never into the live repo.
 *  Bounded: the signal (wall limit or run cap) and a timeout kill the copy, and a size ceiling refuses it up front. Every failure is null, which means the Wall fails and nothing is installed. */
const run = (cmd: string, args: string[], signal: AbortSignal, timeout: number): Promise<{ ok: boolean; out: string }> =>
  new Promise((res) => { try { execFile(cmd, args, { maxBuffer: 1 << 24, timeout, signal, env: tokenFreeEnv(process.env) }, (err, out) => res({ ok: !err, out: String(out ?? "") })); } catch { res({ ok: false, out: "" }); } });
export async function snapshotTree(repoDir: string, signal: AbortSignal, o: { timeoutMs?: number; maxMb?: number } = {}): Promise<string | null> {
  const posEnv = (k: string, d: number): number => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? n : d; };
  const timeoutMs = o.timeoutMs ?? posEnv("LOKI_E10_WALL_SNAPSHOT_TIMEOUT_S", 120) * 1000, maxMb = o.maxMb ?? posEnv("LOKI_E10_WALL_SNAPSHOT_MAX_MB", 2048);
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
    if (!signal.aborted) rebaseSnapshot(repoDir, dir); // BASE-SEES-HEAD
    return signal.aborted ? fail() : dir;
  } catch { return fail(); }
}
/** BASE-SEES-HEAD: a copied tree still names the live repo in absolute symlinks (a preconstruct dev dist/ links each entry to <repo>/packages/x/src)
 *  and in a venv's editable install (.pth path lines, __editable__ finders, direct_url.json), so the Wall's "base" run imported the code implement had
 *  already changed and read green. Both are rewritten to the copy. node_modules and .git are not walked (their links are relative); best effort, bounded. */
export function rebaseSnapshot(repoDir: string, dir: string, bound = 200_000): { links: number; files: number } {
  const roots = new Set<string>([repoDir]); try { roots.add(realpathSync(repoDir)); } catch { /* as given */ }
  for (const r of [...roots]) roots.add(r.startsWith("/private/") ? r.slice("/private".length) : `/private${r}`);
  const rs = [...roots].sort((a, b) => b.length - a.length), under = (t: string): string | null => { for (const r of rs) if (t === r || t.startsWith(`${r}/`)) return join(dir, relative(r, t)); return null; };
  let links = 0, files = 0, seen = 0;
  const walk = (d: string): void => {
    let es: import("node:fs").Dirent[]; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (++seen > bound) return;
      const p = join(d, e.name);
      if (e.isSymbolicLink()) { try { const t = readlinkSync(p), m = t.startsWith("/") ? under(t) : null; if (m) { unlinkSync(p); symlinkSync(m, p); links++; } } catch { /* left as copied */ } }
      else if (e.isDirectory()) { if (e.name === ".git" || e.name === "node_modules") continue; if (e.name === "site-packages") rebaseSitePackages(p); else walk(p); }
    }
  };
  const rebaseSitePackages = (sp: string): void => {
    let names: string[] = []; try { names = readdirSync(sp); } catch { return; }
    const one = (f: string): void => { try { if (lstatSync(f).isSymbolicLink()) return; const t = readFileSync(f, "utf8"); let n = t; for (const r of rs) n = n.split(r + "/").join(dir + "/").split(`${r}"`).join(`${dir}"`).split(`${r}'`).join(`${dir}'`).replace(new RegExp(`^${escapeRegex(r)}$`, "gm"), dir); if (n !== t) { writeFileSync(f, n); files++; } } catch { /* left as copied */ } };
    for (const n of names) { if (n.endsWith(".pth") || /^__editable__.*\.py$/.test(n)) one(join(sp, n)); else if (n.endsWith(".dist-info")) one(join(sp, n, "direct_url.json")); }
  };
  walk(dir);
  return { links, files };
}
/** Files changed against baseSha (tracked diff plus untracked); null when git cannot say. */
export function changedSinceBase(repoDir: string, baseSha: string): string[] | null {
  try {
    const tracked = safeGit(repoDir, ["diff", "--name-only", baseSha], { repoDrivers: true }), untracked = safeGit(repoDir, ["ls-files", "--others", "--exclude-standard"], { repoDrivers: true });
    return `${tracked}\n${untracked}`.split("\n").filter(Boolean);
  } catch { return null; }
}
