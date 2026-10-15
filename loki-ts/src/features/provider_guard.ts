// PARITY-ENFORCE: provider-agnostic guardrails for non-Claude providers (codex, cline, aider, opencode).
// Claude enforces kill-blocking through its own hooks and permission flags; this layer gives the other CLIs
// the same three guarantees from outside the child: wall-clock + budget kill, a post-iteration diff scan that
// reverts destructive changes, and each CLI's own sandbox/approval flags. The Claude path never calls it.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { safeGit } from "../util/safe_git.ts";

export const isGuarded = (provider: string): boolean => provider !== "claude";

/** Native sandbox/approval flags per CLI where one exists. Empty means the CLI has none; the diff scan is then the only layer. */
export function providerSandboxFlags(provider: string): string[] {
  switch (provider) {
    case "codex": return ["--sandbox", "workspace-write"];
    case "aider": return ["--no-auto-commits"];
    default: return []; // cline, opencode: no filesystem sandbox flag
  }
}

export type Violation = { kind: "repo-deleted" | "git-internals" | "outside-project"; detail: string };

export interface GuardSnapshot {
  cwd: string;
  head: string;
  tracked: number;
  gitConfig: string;
  hooks: string[];
  backupDir: string;
}

const git = (cwd: string, args: string[]): string => { try { return safeGit(cwd, args).trim(); } catch { return ""; } };
const gitDir = (cwd: string): string => { const g = git(cwd, ["rev-parse", "--absolute-git-dir"]); return g || join(cwd, ".git"); };
const listHooks = (gd: string): string[] => { try { return readdirSync(join(gd, "hooks")).filter((f) => !f.endsWith(".sample")).sort(); } catch { return []; } };
const readSafe = (p: string): string => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

/** Capture the state the post-iteration scan compares against. Returns null outside a git repo (scan skipped, never faked). */
export function beginGuard(cwd: string, backupRoot: string): GuardSnapshot | null {
  const head = git(cwd, ["rev-parse", "HEAD"]);
  if (!head) return null;
  const gd = gitDir(cwd);
  const backupDir = join(backupRoot, "guard-backup");
  mkdirSync(backupDir, { recursive: true });
  if (existsSync(join(gd, "config"))) copyFileSync(join(gd, "config"), join(backupDir, "config"));
  const tracked = git(cwd, ["ls-files"]).split("\n").filter(Boolean).length;
  return { cwd, head, tracked, gitConfig: readSafe(join(gd, "config")), hooks: listHooks(gd), backupDir };
}

/** A repo-wide delete: more than half of tracked files gone (and at least 5), or the work tree is empty. */
export function isRepoDeletion(deleted: number, tracked: number): boolean {
  return tracked > 0 && deleted >= Math.min(5, tracked) && deleted * 2 > tracked;
}

/** Resolve whether a symlink target escapes the project root. */
export function escapesProject(root: string, linkPath: string): boolean {
  try {
    const target = readlinkSync(linkPath);
    const abs = isAbsolute(target) ? target : resolve(dirname(linkPath), target);
    const rel = relative(realpathSync(root), existsSync(abs) ? realpathSync(abs) : abs);
    return rel.startsWith("..") || isAbsolute(rel);
  } catch { return false; }
}

/** Scan the work tree against the snapshot. Pure detection; revert is separate. */
export function scanGuard(s: GuardSnapshot): { violations: Violation[]; deletedPaths: string[]; escapingLinks: string[] } {
  const violations: Violation[] = [];
  const gd = gitDir(s.cwd);
  const status = git(s.cwd, ["status", "--porcelain=v1", "-uall"]).split("\n").filter(Boolean);
  const deletedPaths = status.filter((l) => /^( D|D )/.test(l)).map((l) => l.slice(3));
  if (isRepoDeletion(deletedPaths.length, s.tracked)) violations.push({ kind: "repo-deleted", detail: `${deletedPaths.length} of ${s.tracked} tracked files deleted` });
  if (readSafe(join(gd, "config")) !== s.gitConfig) violations.push({ kind: "git-internals", detail: ".git/config changed" });
  const newHooks = listHooks(gd).filter((h) => !s.hooks.includes(h));
  if (newHooks.length) violations.push({ kind: "git-internals", detail: `new git hooks: ${newHooks.join(", ")}` });
  if (!git(s.cwd, ["rev-parse", "HEAD"])) violations.push({ kind: "git-internals", detail: "HEAD unresolvable" });
  const escapingLinks: string[] = [];
  for (const l of status) {
    const p = l.slice(3).replace(/^"|"$/g, "");
    if (p.includes("..")) { violations.push({ kind: "outside-project", detail: `path escapes project: ${p}` }); continue; }
    const abs = join(s.cwd, p);
    try { if (lstatSync(abs).isSymbolicLink() && escapesProject(s.cwd, abs)) { escapingLinks.push(p); violations.push({ kind: "outside-project", detail: `symlink points outside project: ${p}` }); } } catch { /* deleted path */ }
  }
  return { violations, deletedPaths, escapingLinks };
}

/** Undo what scanGuard flagged: restore deleted tracked files, .git/config, new hooks, and drop escaping links. Returns what was reverted. */
export function revertGuard(s: GuardSnapshot, scan: ReturnType<typeof scanGuard>): string[] {
  const done: string[] = [];
  const gd = gitDir(s.cwd);
  if (scan.violations.some((v) => v.kind === "repo-deleted") && scan.deletedPaths.length) { git(s.cwd, ["checkout", "--", ...scan.deletedPaths]); done.push(`restored ${scan.deletedPaths.length} deleted files`); }
  if (readSafe(join(gd, "config")) !== s.gitConfig && existsSync(join(s.backupDir, "config"))) { copyFileSync(join(s.backupDir, "config"), join(gd, "config")); done.push("restored .git/config"); }
  for (const h of listHooks(gd).filter((x) => !s.hooks.includes(x))) { rmSync(join(gd, "hooks", h), { force: true }); done.push(`removed hook ${h}`); }
  for (const l of scan.escapingLinks) { rmSync(join(s.cwd, l), { force: true }); done.push(`removed symlink ${l}`); }
  return done;
}

/** Full post-iteration check. ok=false means the iteration must fail; changes were already reverted. */
export function finishGuard(s: GuardSnapshot | null): { ok: boolean; violations: Violation[]; reverted: string[] } {
  if (!s) return { ok: true, violations: [], reverted: [] };
  const scan = scanGuard(s);
  if (!scan.violations.length) return { ok: true, violations: [], reverted: [] };
  return { ok: false, violations: scan.violations, reverted: revertGuard(s, scan) };
}

/**
 * Budget-stop watcher for a spawned child. Polls exceeded() and calls kill("budget") once. The wall-clock
 * timeout stays in the session runner (limitS); this adds the budget half so both providers kill on the same terms.
 */
export function watchBudget(exceeded: () => boolean, kill: (cause: "budget") => void, intervalMs = 5000): () => void {
  let fired = false;
  const t = setInterval(() => { if (fired) return; let hit = false; try { hit = exceeded(); } catch { hit = false; } if (hit) { fired = true; kill("budget"); } }, intervalMs);
  t.unref?.();
  return () => clearInterval(t);
}
