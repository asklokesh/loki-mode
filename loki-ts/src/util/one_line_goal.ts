// R01 one-line goal: `loki "<goal>"` infers what the user would otherwise have to pass. Kept outside the size-capped engine10 core.
// No new gate, reviewer or evidence format: only defaults (provider, publish mode, the exact next command) for inputs a person left out.
export const PROVIDER_ORDER = ["claude", "cline", "codex", "aider", "opencode"] as const; // tier order from CLAUDE.md: full, reduced, degraded
const CLI_ENV_VAR: Record<string, string> = { claude: "LOKI_CLAUDE_CLI", codex: "LOKI_CODEX_CLI", cline: "LOKI_CLINE_CLI", aider: "LOKI_AIDER_CLI", opencode: "LOKI_OPENCODE_CLI" };
const installed = (p: string, env: Record<string, string | undefined>): boolean => !!Bun.which((env[CLI_ENV_VAR[p]!] ?? "").trim() || p, { PATH: env.PATH ?? process.env.PATH ?? "" });
/** The provider to use when the user named none: claude when its CLI resolves, else the first installed supported CLI. Null keeps the caller's default (and its install hint). */
export function inferProvider(env: Record<string, string | undefined>, named: boolean): { provider: string; note: string } | null {
  if (named || installed("claude", env)) return null;
  const p = PROVIDER_ORDER.find((x) => installed(x, env));
  return p ? { provider: p, note: `provider: claude is not installed, using ${p} (the first supported CLI on PATH; pick another with --provider or LOKI_PROVIDER)` } : null;
}
export type LocalReason = "no_remote" | "gh_unauthenticated";
/** Publish mode from what exists: a PR needs a remote and, for GitHub, a working gh login. Without them the run ends on a local branch instead of refusing. */
export async function publishPlan(origin: string | null, ghReady: () => Promise<boolean>): Promise<{ noPr: boolean; reason: LocalReason | null }> {
  if (origin === null || origin === "") return { noPr: false, reason: "no_remote" }; // the PR stage already ends without a PR here; the run is unchanged, only the next command differs
  if (/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/.test(origin) && !(await ghReady())) return { noPr: true, reason: "gh_unauthenticated" };
  return { noPr: false, reason: null };
}
/** The one line printed (stderr) when publish mode was inferred; "" when a PR will be opened. */
export function publishNote(reason: LocalReason | null): string {
  return reason === "gh_unauthenticated" ? "publish: gh is not logged in, so no PR will be opened; the result stays on a local branch (run gh auth login to get a PR next time)"
    : reason === "no_remote" ? "publish: no git remote, so the result stays on a local branch (git remote add origin <url> to get a PR next time)" : "";
}
/** A quoted command ("status --help", "config path") is never a goal: prints that command's help and the goal hint, returns 2. Null for real goal text. */
export function refuseCommandGoal(task: string, env: NodeJS.ProcessEnv = process.env): number | null {
  const { commandShapedGoal } = require("../cli/registry.ts") as typeof import("../cli/registry.ts");
  const cmd = commandShapedGoal(task); if (cmd === null) return null;
  process.stderr.write(`loki: "${task.trim().slice(0, 80)}" is a command, not a goal; nothing was started. Help for 'loki ${cmd}':\n`);
  const { REPO_ROOT } = require("./paths.ts") as typeof import("./paths.ts");
  require("node:child_process").spawnSync("bash", [`${REPO_ROOT}/bin/loki`, cmd, "--help"], { stdio: ["ignore", 2, 2], env: { ...env, LOKI_HELP_ONLY: "1" }, timeout: 20000 });
  process.stderr.write(`To run the command, type it without quotes: loki ${task.trim().slice(0, 80)}\nTo give Loki a goal instead, write it as a sentence: loki "<what you want done>"\n`);
  return 2;
}
/** The exact command that lands (or publishes) a local result; "" when a PR was opened or nothing changed. */
export function landNext(reason: LocalReason | null, branch: string | null, orig: string | null): string {
  if (!reason || !branch) return "";
  return reason === "gh_unauthenticated" ? `gh auth login && git push -u origin ${branch} && gh pr create --fill` : `git checkout ${orig ?? "main"} && git merge --no-ff ${branch}`;
}
