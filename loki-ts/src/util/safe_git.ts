// FC-25: the one way a trusted, token-holding process (supervisor, CLI before withholding, PR path) runs git
// with cwd inside the agent's repo. The repo's own config is untrusted: core.fsmonitor, hooks, sshCommand and
// ext:: transports run arbitrary commands. So every call prepends hardened -c flags, sets GIT_CONFIG_NOSYSTEM,
// and gets an env with the GitHub token family and SSH_AUTH_SOCK removed. A call that truly needs credentials
// (fetch, push) opts in with allowToken: the token env and the user's credential/ssh config are then kept, but
// fsmonitor, hooks and ext:: stay off. Always returns stdout as a utf8 string.
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";

export const SAFE_GIT_CONFIG: readonly string[] = ["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "-c", "core.sshCommand=", "-c", "protocol.ext.allow=never", "-c", "credential.helper="];
// allowToken keeps the user's credential helper and ssh command; fsmonitor, hooks and ext:: stay off.
const CREDENTIAL_CONFIG: readonly string[] = ["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never"];
const SECRET_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK"] as const;

/** A copy of env without the token family and SSH_AUTH_SOCK. Never mutates its argument. */
export function tokenFreeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of SECRET_VARS) delete out[k];
  return out;
}

export interface SafeGitOpts extends Omit<ExecFileSyncOptions, "cwd" | "env" | "encoding"> {
  env?: NodeJS.ProcessEnv; // base env (default process.env); the token family is still stripped unless allowToken
  allowToken?: boolean; // explicit opt-in for a call that needs a credential (push, authenticated fetch)
}

/** Hardened argv for a git call: config flags first, then the caller's args. */
export const safeGitArgs = (args: readonly string[], allowToken = false): string[] => [...(allowToken ? CREDENTIAL_CONFIG : SAFE_GIT_CONFIG), ...args];

/** argv form for the async run()/Bun.spawn helpers: the program, then hardened config, then args. Pair it with tokenFreeEnv() unless a credential is needed. */
export const safeGitArgv = (args: readonly string[], allowToken = false): string[] => ["git", ...safeGitArgs(args, allowToken)];

/** git run in repoDir, hardened, token-free unless allowToken. Returns stdout. Throws like execFileSync. */
export function safeGit(repoDir: string, args: readonly string[], opts: SafeGitOpts = {}): string {
  const { env, allowToken, ...rest } = opts;
  const base = env ?? process.env;
  const childEnv: NodeJS.ProcessEnv = { ...(allowToken ? base : tokenFreeEnv(base)), GIT_CONFIG_NOSYSTEM: "1" };
  const out = execFileSync("git", safeGitArgs(args, allowToken), { stdio: ["ignore", "pipe", "ignore"], ...rest, cwd: repoDir, env: childEnv, encoding: "utf8" });
  return typeof out === "string" ? out : "";
}
