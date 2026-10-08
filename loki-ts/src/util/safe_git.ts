// FC-25: the one way a trusted, token-holding process (supervisor, CLI before withholding, PR path) runs git
// with cwd inside the agent's repo. The repo's own config and attributes are untrusted: core.fsmonitor, hooks,
// sshCommand, ext:: transports, filter drivers, textconv, diff.external and gpg.program all run arbitrary commands.
// So every call prepends hardened -c flags, blanks every repo-defined filter/textconv driver, sets GIT_CONFIG_NOSYSTEM,
// and gets an env with the GitHub token family and SSH_AUTH_SOCK removed. A call that truly needs credentials
// (fetch, push) opts in with allowToken: the token env and the user's credential/ssh config are then kept, but
// the command-running classes stay off. Always returns stdout as a utf8 string.
import { hardenCredentialEnv } from "./credential_env.ts";
import { execFileSync, spawnSync, type ExecFileSyncOptions, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";

export const SAFE_GIT_CONFIG: readonly string[] = ["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "-c", "core.sshCommand=", "-c", "protocol.ext.allow=never", "-c", "credential.helper="];
// allowToken keeps the user's credential helper and ssh command; fsmonitor, hooks and ext:: stay off.
const CREDENTIAL_CONFIG: readonly string[] = ["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never"];
// External diff, commit signing and a global attributes file: repo-chosen commands on diff/commit paths.
const DRIVER_CONFIG: readonly string[] = ["-c", "diff.external=", "-c", "commit.gpgSign=false", "-c", "core.attributesFile=/dev/null"];
// Worker-side content writes and commits restore these pairs (see SafeGitKeep); a token-holding call never does.
const ATTRS_OFF = "core.attributesFile=/dev/null", HOOKS_OFF = "core.hooksPath=/dev/null", SIGN_OFF = "commit.gpgSign=false";
const REPO_SCOPES: ReadonlySet<string> = new Set(["local", "worktree", "command"]);
const DRIVER_KEY_RE = "^(filter\\..*\\.(clean|smudge|process)|diff\\..*\\.(textconv|command))$";
// Patch-producing subcommands. diff.external= (blank) makes these die with "external diff died", so --no-ext-diff
// --no-textconv are injected right after the subcommand; a caller's --ext-diff/--textconv is dropped, never honoured.
const PATCH_CMDS: ReadonlySet<string> = new Set(["diff", "show", "log", "whatchanged"]);
const OPT_WITH_VALUE: ReadonlySet<string> = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env", "--attr-source"]);
const SECRET_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK"] as const;

/** A copy of env without SSH_AUTH_SOCK and with every ambient GitHub credential withheld (FC-90, credential_env.ts): the token
 *  family is a non-working sentinel (never the real value, never merely deleted: gh would fall back to its keyring), gh's config
 *  dir is an empty directory and git's credential helpers are reset. Never mutates its argument. */
export function tokenFreeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of SECRET_VARS) delete out[k];
  hardenCredentialEnv(out);
  return out;
}

/** Opt-ins for the token-withheld engine10 worker, where the agent already has exec, so these buy no P9 security there.
 *  repoDrivers: keep the repo's filter/textconv drivers and the user's core.attributesFile on a content-writing call (add, checkout),
 *  so LFS, clean filters and eol/text rules still shape what gets committed. userHooks: keep the user's hooks and commit signing
 *  (enterprise pre-commit scanners, "require signed commits"). The token is still stripped; fsmonitor, sshCommand and ext:: stay off.
 *  userHooks with allowToken is refused: a call holding a credential never runs a hook. */
export interface SafeGitKeep { repoDrivers?: boolean; userHooks?: boolean }

export interface SafeGitOpts extends Omit<ExecFileSyncOptions, "cwd" | "env" | "encoding">, SafeGitKeep {
  env?: NodeJS.ProcessEnv; // base env (default process.env); the token family is still stripped unless allowToken
  allowToken?: boolean; // explicit opt-in for a call that needs a credential (push, authenticated fetch)
}

/** Env for a safe git child: token-free unless allowToken, no system config. GIT_ATTR_SOURCE is removed: pointing it at the empty tree
 *  hides the in-tree .gitattributes (LFS routing), so repo-local drivers are blanked by key instead. */
export const safeGitEnv = (base: NodeJS.ProcessEnv = process.env, allowToken = false): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...(allowToken ? base : tokenFreeEnv(base)), GIT_CONFIG_NOSYSTEM: "1" };
  delete env.GIT_ATTR_SOURCE;
  delete env.GIT_EXTERNAL_DIFF; // overrides diff.external and would run an arbitrary program
  return env;
};

/** Every filter clean/smudge/process and diff textconv key defined at local, worktree or command scope (a key reached through a local
 *  include.path reports local). Global and system keys are the user's own (e.g. `git lfs install`) and stay live: blanking them breaks LFS
 *  (the global-scope residual is FC-25c). Enumeration runs hardened and token-free. Fails closed: an unreadable config throws. */
function driverKeys(repoDir: string): string[] {
  const r = spawnSync("git", [...SAFE_GIT_CONFIG, "config", "--includes", "--show-scope", "-z", "--get-regexp", DRIVER_KEY_RE], { cwd: repoDir, env: safeGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (r.error) throw r.error;
  if (r.status === 1) return []; // no match
  if (r.status !== 0) throw new Error(`safeGit: cannot enumerate git config drivers (status ${r.status})`);
  // -z --show-scope emits "<scope>\0<key>\n<value>\0" per entry
  const t = r.stdout.split("\0"), keys: string[] = [];
  for (let i = 0; i + 1 < t.length; i += 2) { const k = t[i + 1]!.split("\n")[0]!; if (REPO_SCOPES.has(t[i]!) && k) keys.push(k); }
  return [...new Set(keys)];
}

/** Hardened argv for a git call: config flags first, then the caller's args. With repoDir, every repo-defined filter and
 *  textconv driver is blanked too. A blanked driver with filter.<x>.required=true makes git error: callers see a throw, never a clean result. */
export function safeGitArgs(args: readonly string[], allowToken = false, repoDir?: string, keep: SafeGitKeep = {}): string[] {
  if (keep.userHooks && allowToken) throw new Error("safeGit: userHooks with allowToken is refused (a hook would run holding the credential)");
  const off = new Set([...(keep.repoDrivers ? [ATTRS_OFF] : []), ...(keep.userHooks ? [HOOKS_OFF, SIGN_OFF] : [])]);
  const cfg = [...(allowToken ? CREDENTIAL_CONFIG : SAFE_GIT_CONFIG), ...DRIVER_CONFIG];
  const flags = cfg.flatMap((v, i) => (i % 2 === 1 && !off.has(v) ? [cfg[i - 1]!, v] : []));
  return [...flags, ...(repoDir && !keep.repoDrivers ? driverKeys(repoDir).flatMap((k) => ["-c", `${k}=`]) : []), ...noExtDiff(args)];
}

/** Inject --no-ext-diff --no-textconv after a patch-producing subcommand and drop --ext-diff/--textconv. Other commands pass through. */
function noExtDiff(args: readonly string[]): string[] {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) i += OPT_WITH_VALUE.has(args[i]!) ? 2 : 1;
  const cmd = args[i];
  if (cmd === undefined || !PATCH_CMDS.has(cmd)) return [...args];
  const rest = args.slice(i + 1);
  const end = rest.indexOf("--");
  const opts = (end < 0 ? rest : rest.slice(0, end)).filter((a) => a !== "--ext-diff" && a !== "--textconv" && a !== "--no-ext-diff" && a !== "--no-textconv");
  return [...args.slice(0, i + 1), "--no-ext-diff", "--no-textconv", ...opts, ...(end < 0 ? [] : rest.slice(end))];
}

/** git run in repoDir, hardened, token-free unless allowToken. Returns stdout. Throws like execFileSync. */
export function safeGit(repoDir: string, args: readonly string[], opts: SafeGitOpts = {}): string {
  const { env, allowToken, repoDrivers, userHooks, ...rest } = opts;
  const out = execFileSync("git", safeGitArgs(args, allowToken, repoDir, { repoDrivers, userHooks }), { stdio: ["ignore", "pipe", "ignore"], ...rest, cwd: repoDir, env: safeGitEnv(env ?? process.env, allowToken), encoding: "utf8" });
  return typeof out === "string" ? out : "";
}

export interface SafeGitSpawnOpts extends Omit<SpawnSyncOptions, "cwd" | "env">, SafeGitKeep {
  env?: NodeJS.ProcessEnv;
  allowToken?: boolean;
}

/** spawnSync form for callers that need the exit status, a Buffer stdout or stdin. Same hardening and env as safeGit. Never throws:
 *  a config that cannot be enumerated comes back as a failed result (status null, error set). */
export function safeGitSpawn(repoDir: string, args: readonly string[], opts: SafeGitSpawnOpts & { encoding: BufferEncoding }): SpawnSyncReturns<string>;
export function safeGitSpawn(repoDir: string, args: readonly string[], opts?: SafeGitSpawnOpts): SpawnSyncReturns<Buffer>;
export function safeGitSpawn(repoDir: string, args: readonly string[], opts: SafeGitSpawnOpts = {}): SpawnSyncReturns<string | Buffer> {
  const { env, allowToken, repoDrivers, userHooks, ...rest } = opts;
  let argv: string[];
  try { argv = safeGitArgs(args, allowToken, repoDir, { repoDrivers, userHooks }); } catch (e) {
    return { pid: 0, output: [], stdout: "", stderr: "", status: null, signal: null, error: e as Error };
  }
  return spawnSync("git", argv, { ...rest, cwd: repoDir, env: safeGitEnv(env ?? process.env, allowToken) });
}

export interface SafeGitRunOpts extends SafeGitKeep {
  env?: NodeJS.ProcessEnv; allowToken?: boolean; timeoutMs?: number; signal?: AbortSignal;
}

/** Async form (Bun.spawn) with the same hardening. The env is passed exactly, never merged over process.env: util/shell.ts run()
 *  overlays its env on process.env, so handing it safeGitEnv() kept the token. Never throws; a spawn failure is exitCode 127. */
export async function safeGitRun(repoDir: string, args: readonly string[], opts: SafeGitRunOpts = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let argv: string[];
  try { argv = safeGitArgs(args, opts.allowToken, repoDir, { repoDrivers: opts.repoDrivers, userHooks: opts.userHooks }); } catch (e) { return { stdout: "", stderr: String(e), exitCode: 128 }; }
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn({ cmd: ["git", ...argv], cwd: repoDir, env: safeGitEnv(opts.env ?? process.env, opts.allowToken) as Record<string, string>, stdin: "ignore", stdout: "pipe", stderr: "pipe", signal: opts.signal });
  } catch (e) { return { stdout: "", stderr: String(e), exitCode: 127 }; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutMs && opts.timeoutMs > 0) timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* exited */ } }, opts.timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text(), proc.exited]);
    return { stdout, stderr, exitCode };
  } finally { if (timer) clearTimeout(timer); }
}
