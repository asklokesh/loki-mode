// FC-25: the one way a trusted, token-holding process (supervisor, CLI before withholding, PR path) runs git
// with cwd inside the agent's repo. The repo's own config and attributes are untrusted: core.fsmonitor, hooks,
// sshCommand, ext:: transports, filter drivers, textconv, diff.external and gpg.program all run arbitrary commands.
// So every call prepends hardened -c flags, blanks every repo-defined filter/textconv driver, sets GIT_CONFIG_NOSYSTEM,
// and gets an env with the GitHub token family and SSH_AUTH_SOCK removed. A call that truly needs credentials
// (fetch, push) opts in with allowToken: the token env and the user's credential/ssh config are then kept, but
// the command-running classes stay off. Always returns stdout as a utf8 string.
import { execFileSync, spawnSync, type ExecFileSyncOptions } from "node:child_process";

export const SAFE_GIT_CONFIG: readonly string[] = ["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "-c", "core.sshCommand=", "-c", "protocol.ext.allow=never", "-c", "credential.helper="];
// allowToken keeps the user's credential helper and ssh command; fsmonitor, hooks and ext:: stay off.
const CREDENTIAL_CONFIG: readonly string[] = ["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never"];
// External diff, commit signing and a global attributes file: repo-chosen commands on diff/commit paths.
const DRIVER_CONFIG: readonly string[] = ["-c", "diff.external=", "-c", "commit.gpgSign=false", "-c", "core.attributesFile=/dev/null"];
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const DRIVER_KEY_RE = "^(filter\\..*\\.(clean|smudge|process)|diff\\..*\\.textconv)$";
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

/** Env for a safe git child: token-free unless allowToken, no system config, attributes read from the empty tree (ignored by older git). */
export const safeGitEnv = (base: NodeJS.ProcessEnv = process.env, allowToken = false): NodeJS.ProcessEnv => ({ ...(allowToken ? base : tokenFreeEnv(base)), GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_SOURCE: EMPTY_TREE });

/** Every filter clean/smudge/process and diff textconv key the repo (or an include) defines. Enumeration runs hardened and token-free. Fails closed: an unreadable config throws. */
function driverKeys(repoDir: string): string[] {
  const r = spawnSync("git", [...SAFE_GIT_CONFIG, "config", "--includes", "-z", "--get-regexp", DRIVER_KEY_RE], { cwd: repoDir, env: safeGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (r.error) throw r.error;
  if (r.status === 1) return []; // no match
  if (r.status !== 0) throw new Error(`safeGit: cannot enumerate git config drivers (status ${r.status})`);
  return [...new Set(r.stdout.split("\0").filter(Boolean).map((e) => e.split("\n")[0]!).filter(Boolean))];
}

/** Hardened argv for a git call: config flags first, then the caller's args. With repoDir, every repo-defined filter and
 *  textconv driver is blanked too. A blanked driver with filter.<x>.required=true makes git error: callers see a throw, never a clean result. */
export const safeGitArgs = (args: readonly string[], allowToken = false, repoDir?: string): string[] => [
  ...(allowToken ? CREDENTIAL_CONFIG : SAFE_GIT_CONFIG), ...DRIVER_CONFIG,
  ...(repoDir ? driverKeys(repoDir).flatMap((k) => ["-c", `${k}=`]) : []), ...args,
];

/** argv form for the async run()/Bun.spawn helpers: the program, then hardened config, then args. Pair it with safeGitEnv(). */
export const safeGitArgv = (args: readonly string[], allowToken = false, repoDir?: string): string[] => ["git", ...safeGitArgs(args, allowToken, repoDir)];

/** git run in repoDir, hardened, token-free unless allowToken. Returns stdout. Throws like execFileSync. */
export function safeGit(repoDir: string, args: readonly string[], opts: SafeGitOpts = {}): string {
  const { env, allowToken, ...rest } = opts;
  const out = execFileSync("git", safeGitArgs(args, allowToken, repoDir), { stdio: ["ignore", "pipe", "ignore"], ...rest, cwd: repoDir, env: safeGitEnv(env ?? process.env, allowToken), encoding: "utf8" });
  return typeof out === "string" ? out : "";
}
