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

// LM-004: one capability table per provider and engine, as data. Every row cites the code it was read from.
// "unknown" means the value was not confirmed from a code path; it is never a guess and never a claim of absence.
// `loki provider info --json|matrix`, the start-line disclosure and the table in docs/cost-controls.md read this.

export type Engine = "engine10" | "legacy";
export type Tri<T extends string> = T | "unknown";

export interface Capability {
  provider: string;
  engine: Engine;
  /** How the engine invokes the provider. */
  invocation: string;
  /** measured: provider-reported figures; estimated: parsed or size-based, flagged estimated; none: usd stays not measured. */
  cost: Tri<"measured" | "estimated" | "none">;
  /** pre-emptive: killed while a session runs on a priced figure; post-iteration: checked when a session ends; none: no cap. */
  budgetKill: Tri<"pre-emptive" | "post-iteration" | "none">;
  /** Session child killed as a whole process group (SIGTERM, then SIGKILL after a grace). */
  cancelProcessGroup: Tri<"yes" | "no">;
  /** Native sandbox or approval flags the engine passes. */
  sandboxFlags: string[] | "unknown";
  /** Whether the engine seals a verification receipt for a run on this provider. */
  receipt: Tri<"yes" | "no">;
  /** Session resume within a run. */
  resume: Tri<"yes" | "no">;
  /** When the destructive-change scan runs: native = the provider's own hooks gate each call. */
  guardScan: Tri<"native" | "post-iteration" | "none">;
  /** Whether kill blocking is enforced (receipts list "kill blocking not enforced" when not). */
  killBlocking: Tri<"native" | "none">;
  /** Source files the row was derived from. */
  source: string;
}

export const PROVIDERS = ["claude", "codex", "cline", "aider", "opencode"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

const E10_COMMON = "loki-ts/src/engine10/session.ts (detached spawn, killGroupWithGrace, recordCost, watchBudget), loki-ts/src/providers/provider_guard.ts, loki-ts/src/e10ext/budget_cap.ts";
const U = "unknown" as const;

export const CAPABILITIES: Capability[] = [
  { provider: "claude", engine: "engine10", invocation: "Agent SDK query() (default) or claude CLI via loki-ts/src/runner/providers.ts", cost: "measured", budgetKill: "post-iteration", cancelProcessGroup: "yes", sandboxFlags: [], receipt: "yes", resume: "yes", guardScan: "native", killBlocking: "native", source: `${E10_COMMON}; loki-ts/src/runner/providers.ts (LOKI_E10_RESUME_SESSION, claude only)` },
  { provider: "codex", engine: "engine10", invocation: "codex exec --sandbox workspace-write --skip-git-repo-check", cost: "estimated", budgetKill: "post-iteration", cancelProcessGroup: "yes", sandboxFlags: providerSandboxFlags("codex"), receipt: "yes", resume: "no", guardScan: "post-iteration", killBlocking: "none", source: `${E10_COMMON}; loki-ts/src/providers/provider_cost.ts (ESTIMATED_PROVIDERS); loki-ts/src/runner/providers.ts codexProvider` },
  { provider: "cline", engine: "engine10", invocation: "cline -y", cost: "estimated", budgetKill: "post-iteration", cancelProcessGroup: "yes", sandboxFlags: providerSandboxFlags("cline"), receipt: "yes", resume: "no", guardScan: "post-iteration", killBlocking: "none", source: `${E10_COMMON}; loki-ts/src/providers/provider_cost.ts; providers/cline.sh` },
  { provider: "aider", engine: "engine10", invocation: "aider --yes-always", cost: "estimated", budgetKill: "post-iteration", cancelProcessGroup: "yes", sandboxFlags: providerSandboxFlags("aider"), receipt: "yes", resume: "no", guardScan: "post-iteration", killBlocking: "none", source: `${E10_COMMON}; loki-ts/src/providers/provider_cost.ts (a reported "Cost: $X session" line is used as-is); providers/aider.sh` },
  { provider: "opencode", engine: "engine10", invocation: "opencode run --auto [-m provider/model]", cost: "none", budgetKill: "none", cancelProcessGroup: "yes", sandboxFlags: providerSandboxFlags("opencode"), receipt: "yes", resume: "no", guardScan: "post-iteration", killBlocking: "none", source: `${E10_COMMON}; loki-ts/src/runner/provider_opencode.ts (costMeasured false); loki-ts/src/providers/provider_cost.ts (opencode not in ESTIMATED_PROVIDERS); docs/v10/GUIDE.md provider table` },
  { provider: "claude", engine: "legacy", invocation: "claude --dangerously-skip-permissions (bash loop)", cost: U, budgetKill: U, cancelProcessGroup: U, sandboxFlags: U, receipt: U, resume: U, guardScan: U, killBlocking: U, source: "providers/claude.sh (PROVIDER_AUTONOMOUS_FLAG); autonomy/run.sh (LOKI_BUDGET_LIMIT); other fields not confirmed" },
  { provider: "codex", engine: "legacy", invocation: "codex exec --sandbox workspace-write --skip-git-repo-check (bash loop)", cost: U, budgetKill: U, cancelProcessGroup: U, sandboxFlags: ["--sandbox", "workspace-write"], receipt: U, resume: U, guardScan: U, killBlocking: U, source: "providers/codex.sh (PROVIDER_AUTONOMOUS_FLAG); other fields not confirmed" },
  { provider: "cline", engine: "legacy", invocation: "cline -y (bash loop)", cost: U, budgetKill: U, cancelProcessGroup: U, sandboxFlags: U, receipt: U, resume: U, guardScan: U, killBlocking: U, source: "providers/cline.sh (PROVIDER_AUTONOMOUS_FLAG); other fields not confirmed" },
  { provider: "aider", engine: "legacy", invocation: "aider --yes-always (bash loop)", cost: U, budgetKill: U, cancelProcessGroup: U, sandboxFlags: U, receipt: U, resume: U, guardScan: U, killBlocking: U, source: "providers/aider.sh (PROVIDER_AUTONOMOUS_FLAG); other fields not confirmed" },
  { provider: "opencode", engine: "legacy", invocation: "opencode run --auto (bash loop)", cost: U, budgetKill: U, cancelProcessGroup: U, sandboxFlags: U, receipt: U, resume: U, guardScan: U, killBlocking: U, source: "providers/opencode.sh (PROVIDER_AUTONOMOUS_FLAG); other fields not confirmed" },
];

export const capabilitiesFor = (provider: string): Capability[] => CAPABILITIES.filter((c) => c.provider === provider);
export const capability = (provider: string, engine: Engine = "engine10"): Capability | undefined => CAPABILITIES.find((c) => c.provider === provider && c.engine === engine);

/** One line naming where a provider falls short of Claude on its engine, or null for Claude and for a provider with no gap (nothing is printed then). */
export function disclosureLine(provider: string, engine: Engine = "engine10"): string | null {
  if (provider === "claude") return null;
  const row = capability(provider, engine), base = capability("claude", engine);
  if (!row || !base) return null;
  const d: string[] = [];
  if (row.cost !== base.cost && row.cost !== "unknown") d.push(row.cost === "none" ? "cost not measured" : `cost ${row.cost}`);
  if (row.budgetKill !== base.budgetKill && row.budgetKill !== "unknown") d.push(row.budgetKill === "none" ? "no budget kill" : `budget kill ${row.budgetKill}, not pre-emptive`);
  if (row.guardScan !== base.guardScan && row.guardScan !== "unknown") d.push(`guard scan ${row.guardScan}`);
  if (row.killBlocking !== base.killBlocking && row.killBlocking !== "unknown") d.push("kill blocking not enforced");
  if (row.resume !== base.resume && row.resume !== "unknown") d.push("no session resume");
  return d.length ? `${provider} on ${engine}: ${d.join(", ")}` : null;
}

const cell = (v: string | string[]): string => (Array.isArray(v) ? (v.length ? v.join(" ") : "none") : v);
export const COLUMNS = ["provider", "engine", "cost", "budgetKill", "cancelProcessGroup", "sandboxFlags", "receipt", "resume", "guardScan", "killBlocking"] as const;

export function matrixText(rows: Capability[] = CAPABILITIES): string {
  const head = ["provider", "engine", "cost", "budget kill", "cancel (pgroup)", "sandbox flags", "receipt", "resume", "guard scan", "kill blocking"];
  const body = rows.map((r) => COLUMNS.map((c) => cell(r[c])));
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const line = (a: string[]) => a.map((x, i) => x.padEnd(w[i]!)).join("  ").trimEnd();
  return [line(head), ...body.map(line)].join("\n") + "\n";
}
