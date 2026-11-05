// R01 one-line goal: `loki "<goal>"` infers what the user would otherwise have to pass. Kept outside the size-capped engine10 core.
// No new gate, reviewer or evidence format: only defaults (provider, publish mode, the exact next command) for inputs a person left out.
import { claudeSdkReady } from "../commands/doctor.ts";
import { CLI_ENV_VAR } from "../engine10/preflight.ts";
import { PROVIDERS } from "../runner/types.ts";
import { githubRepoFromUrl } from "./engine_origin.ts";
export const PROVIDER_ORDER = PROVIDERS; // providers/loader.sh auto_detect_provider order
const installed = (p: string, env: Record<string, string | undefined>): boolean => !!Bun.which((env[CLI_ENV_VAR[p]!] ?? "").trim() || p, { PATH: env.PATH ?? process.env.PATH ?? "" });
/** The provider to use when the user named none: claude when its CLI resolves or a key can run it on the bundled SDK (L034), else the first installed supported CLI. Null keeps the caller's default (and its install hint). */
export function inferProvider(env: Record<string, string | undefined>, named: boolean): { provider: string; note: string } | null {
  if (named || installed("claude", env) || claudeSdkReady(env)) return null;
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
/** FR01: a pasted or shorthand goal that names one issue becomes the ref the issue path already takes. A copied issue URL keeps its path up to issues/N
 *  (a trailing slash, ?query or #fragment is dropped); "#N", "issue N", and an optional leading verb (fix, resolve, close, implement, solve, address, handle, do, work on)
 *  in front of any ref the caller accepts. "#N" needs a GitHub origin and becomes owner/repo#N there. Null leaves the goal as text: extra words, several lines,
 *  no origin for "#N", or LOKI_GOAL_REF=0. */
export function goalRef(task: string, origin: string | null, isRef: (s: string) => boolean, env: NodeJS.ProcessEnv = process.env): { ref: string; note: string } | null {
  const t = task.trim(); if (env.LOKI_GOAL_REF === "0" || t.includes("\n")) return null;
  const PREFIX = /^(?:(?:please\s+)?(?:fix|resolve|close|implement|solve|address|handle|do|work\s+on)\s+)?(?:(?:the\s+)?(?:github\s+)?issue\s+)?/i;
  const m = PREFIX.exec(t)!, rest = t.slice(m[0].length).replace(/\.$/, ""), issueWord = /issue/i.test(m[0]);
  const cand = rest.match(/^(https?:\/\/\S+?\/(?:-\/)?issues\/\d+)[\/?#]\S*$/i)?.[1] ?? rest;
  let ref: string | null = null;
  if (isRef(cand)) ref = cand;
  else { const n = cand.match(/^#(\d+)$/)?.[1] ?? (issueWord ? cand.match(/^\d+$/)?.[0] : undefined), repo = n ? githubRepoFromUrl(origin) : null; if (n && repo) ref = `${repo}#${n}`; }
  if (!ref || ref === t) return null;
  return { ref, note: `goal: read "${t.slice(0, 80)}" as issue ${ref} (LOKI_GOAL_REF=0 keeps it as text)` };
}
/** The exact command that lands (or publishes) a local result; "" when a PR was opened or nothing changed. */
export function landNext(reason: LocalReason | null, branch: string | null, orig: string | null): string {
  if (!reason || !branch) return "";
  return reason === "gh_unauthenticated" ? `gh auth login && git push -u origin ${branch} && gh pr create --fill` : `git checkout ${orig ?? "main"} && git merge --no-ff ${branch}`;
}
