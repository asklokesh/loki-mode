// FC-25: the one way a trusted, token-holding process (supervisor, CLI before withholding, PR path) runs git
// with cwd inside the agent's repo. The repo's own config and attributes are untrusted: core.fsmonitor, hooks,
// sshCommand, ext:: transports, filter drivers, textconv, diff.external and gpg.program all run arbitrary commands.
// So every call prepends hardened -c flags, blanks every repo-defined filter/textconv driver, sets GIT_CONFIG_NOSYSTEM,
// and gets an env with the GitHub token family and SSH_AUTH_SOCK removed. A call that truly needs credentials
// (fetch, push) opts in with allowToken: the token env and the user's credential/ssh config are then kept, but
// the command-running classes stay off. Repo-scope (local/worktree) core.sshCommand, remote.*.uploadpack/receivepack, core.gitProxy
// and credential helpers are neutralised too (FC-25c a); the user's global and system values are re-added so they keep working.
// Always returns stdout as a utf8 string.
import { hardenCredentialEnv } from "./credential_env.ts";
import { lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs"; import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { execFileSync, spawnSync, type ExecFileSyncOptions, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";

export const SAFE_GIT_CONFIG: readonly string[] = ["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "-c", "core.sshCommand=", "-c", "protocol.ext.allow=never", "-c", "credential.helper=", "-c", "core.trustctime=true", "-c", "core.checkStat=default"];
// allowToken keeps the user's credential helper and ssh command; fsmonitor, hooks and ext:: stay off.
const CREDENTIAL_CONFIG: readonly string[] = ["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never"];
// gpg programs run on signature display (%G?, %(signature), log.showSignature) and verification; a repo-set one is an arbitrary command.
// userHooks callers keep the user's own signing setup, so these pairs are in the `off` set there (see safeGitArgs).
const GPG_OFF: readonly string[] = ["gpg.program=false", "gpg.openpgp.program=false", "gpg.x509.program=false", "gpg.ssh.program=false"];
// Signing triggers beyond commit.gpgSign: tag.gpgSign and push.gpgSign make git sign, and a repo-set gpg.ssh.defaultKeyCommand runs to find the key.
const SIGN_EXTRA: readonly string[] = ["gpg.ssh.defaultKeyCommand=", "tag.gpgSign=false", "push.gpgSign=false"];
// External diff, commit signing and a global attributes file: repo-chosen commands on diff/commit paths.
const DRIVER_CONFIG: readonly string[] = ["-c", "diff.external=", "-c", "commit.gpgSign=false", "-c", "core.attributesFile=/dev/null", ...GPG_OFF.flatMap((v) => ["-c", v]), ...SIGN_EXTRA.flatMap((v) => ["-c", v]), "-c", "log.showSignature=false"];
// Worker-side content writes and commits restore these pairs (see SafeGitKeep); a token-holding call never does.
const ATTRS_OFF = "core.attributesFile=/dev/null", HOOKS_OFF = "core.hooksPath=/dev/null", SIGN_OFF = "commit.gpgSign=false";
const REPO_SCOPES: ReadonlySet<string> = new Set(["local", "worktree", "command"]);
const DRIVER_KEY_RE = "^(filter\\..*\\.(clean|smudge|process)|diff\\..*\\.(textconv|command))$";
// Patch-producing subcommands. diff.external= (blank) makes these die with "external diff died", so --no-ext-diff
// --no-textconv are injected right after the subcommand; a caller's --ext-diff/--textconv is dropped, never honoured.
const PATCH_CMDS: ReadonlySet<string> = new Set(["diff", "show", "log", "whatchanged"]);
/** Builtins that never run a clean/smudge/process filter or a textconv, so blanking repo drivers (one `git config` spawn per call) buys nothing.
 *  Only ref and config plumbing: anything that diffs, stats the worktree, checks out or writes (ls-files -m, status, add, log -p) stays blanked. */
const DRIVER_FREE_CMDS: ReadonlySet<string> = new Set(["rev-parse", "symbolic-ref", "rev-list", "for-each-ref", "merge-base", "show-ref", "config"]);
const OPT_WITH_VALUE: ReadonlySet<string> = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env", "--attr-source", "--shallow-file", "--super-prefix"]);
const OPT_NO_VALUE: ReadonlySet<string> = new Set(["-P", "--no-pager", "-p", "--paginate", "--bare", "--no-replace-objects", "--literal-pathspecs", "--no-literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks", "--no-lazy-fetch"]);
/** Fail closed: true only when every token before the subcommand is a recognised global option (with its value if it takes one) and the
 *  subcommand is driver-free. An unknown leading option could swallow the next token as its value, so it means "blank". */
function skipsDriverScan(args: readonly string[]): boolean {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) {
    const a = args[i]!;
    if (OPT_WITH_VALUE.has(a)) { if (i + 1 >= args.length) return false; i += 2; continue; }
    if (OPT_NO_VALUE.has(a) || /^--(git-dir|work-tree|namespace|exec-path|config-env|attr-source|shallow-file|super-prefix)=/.test(a)) { i++; continue; }
    return false;
  }
  return DRIVER_FREE_CMDS.has(args[i] ?? "");
}
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
const configEnumTimeoutMs = (): number => { const n = Number(process.env.LOKI_SAFE_GIT_CONFIG_TIMEOUT_MS); return Number.isFinite(n) && n > 0 ? n : 30_000; };
export const driverKeys = (repoDir: string): string[] => repoKeysMatching(repoDir, DRIVER_KEY_RE);
export function repoKeysMatching(repoDir: string, keyRe: string): string[] {
  const r = spawnSync("git", [...SAFE_GIT_CONFIG, "config", "--includes", "--show-scope", "-z", "--get-regexp", keyRe], { cwd: repoDir, env: safeGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: configEnumTimeoutMs(), killSignal: "SIGKILL" });
  if (r.error) throw r.error; // a timeout surfaces as ETIMEDOUT here, so a hung git config fails closed // a timeout surfaces as ETIMEDOUT here, so a hung git config fails closed
  if (r.status === 1) return []; // no match
  if (r.status !== 0) throw new Error(`safeGit: cannot enumerate git config drivers (status ${r.status})`);
  // -z --show-scope emits "<scope>\0<key>\n<value>\0" per entry
  const t = r.stdout.split("\0"), keys: string[] = [];
  for (let i = 0; i + 1 < t.length; i += 2) { const k = t[i + 1]!.split("\n")[0]!; if (REPO_SCOPES.has(t[i]!) && k) keys.push(k); }
  return [...new Set(keys)];
}

// FC-REVIEWER-GIT-CONFIG-EXEC: a reviewer child (council voter, DA) is a model whose Bash allowlist includes git status/diff/show/log.
// It builds its own git argv, so the argv-side hardening above cannot reach it; env-side config (GIT_CONFIG_COUNT is command scope and
// beats the repo's .git/config) does. A blank diff.external makes `git diff` die, so GIT_EXTERNAL_DIFF (which git consults when no
// attribute driver is set) points at a plain `diff -u` shim instead; repo diff/filter drivers are blanked by key as in driverKeys.
const REVIEWER_GIT_STATIC: ReadonlyArray<readonly [string, string]> = [
  ["core.fsmonitor", ""], ["core.hooksPath", "/dev/null"], ["core.attributesFile", "/dev/null"], ["core.pager", "cat"], ["protocol.ext.allow", "never"],
  // gpg programs run on `git log --show-signature`, `git show <signed>` and log.showSignature, for openpgp, ssh and x509 formats
  ["log.showSignature", "false"], ["gpg.program", "false"], ["gpg.openpgp.program", "false"], ["gpg.ssh.program", "false"], ["gpg.x509.program", "false"],
  // a partial-clone lazy fetch (GIT_NO_LAZY_FETCH below) would run core.sshCommand / proxy / askpass on any read of a missing object
  ["core.sshCommand", ""], ["core.gitProxy", ""], ["core.askpass", ""],
];
// Repo diff driver commands get the shim (a blank command dies); textconv gets cat (a blank one dies on log -p); other driver keys blank.
// The shim ends its options with `--` so a tracked file named `-n` is a path, not a diff option.
const REVIEWER_EXT_DIFF = 'f() { diff -u -L "a/$1" -L "b/$1" -- "$2" "$5"; [ $? -le 1 ]; }; f';
function gitHonoursNoLazyFetch(v?: string): boolean {
  const out = v ?? String(spawnSync("git", ["--version"], { encoding: "utf8", env: safeGitEnv() }).stdout ?? "");
  const m = /(\d+)\.(\d+)/.exec(out);
  return !!m && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 44));
}
const REVIEWER_NET_SKIP = /sslverify$/i;

/** Env for a model-driven reviewer child that may run read-only git in repoDir. base is required so a caller must choose it:
 *  pass tokenFreeEnv(process.env) for a child that must not hold the GitHub credential (SSH_AUTH_SOCK is emptied here regardless).
 *  Adds GIT_CONFIG_NOSYSTEM, GIT_NO_LAZY_FETCH, GIT_PAGER=cat, command-scope config that disables fsmonitor, hooks, attributes file, pager,
 *  gpg programs and network command keys (repo ones enumerated with NET_CMD_KEY_RE), every repo filter blanked by key, and GIT_EXTERNAL_DIFF
 *  replaced by a harmless unified-diff shim (it beats a repo diff.external). Existing GIT_CONFIG_COUNT entries are kept. Never mutates base.
 *  Fails closed (throws) when the repo config cannot be enumerated; a non-repo directory has no repo config to defend. */
export function reviewerGitEnv(repoDir: string, base: NodeJS.ProcessEnv, gitVersion?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GIT_CONFIG_NOSYSTEM: "1", GIT_EXTERNAL_DIFF: REVIEWER_EXT_DIFF, GIT_NO_LAZY_FETCH: "1", GIT_PAGER: "cat", SSH_AUTH_SOCK: "" };
  delete env.GIT_ATTR_SOURCE;
  const inRepo = spawnSync("git", [...SAFE_GIT_CONFIG, "rev-parse", "--git-dir"], { cwd: repoDir, env: safeGitEnv(), stdio: "ignore", timeout: configEnumTimeoutMs(), killSignal: "SIGKILL" });
  if (inRepo.error) throw inRepo.error;
  const pairs: Array<readonly [string, string]> = [...REVIEWER_GIT_STATIC];
  if (inRepo.status === 0) {
    for (const k of driverKeys(repoDir)) pairs.push([k, /^diff\..*\.command$/i.test(k) ? REVIEWER_EXT_DIFF : /^diff\..*\.textconv$/i.test(k) ? "cat" : ""]);
    const netKeys = repoKeysMatching(repoDir, NET_CMD_KEY_RE);
    // remote.<n>.uploadpack/receivepack are first-value-wins and a repo-local value beats a command-scope blank, so env cannot neutralise them
    if (netKeys.some((k) => /^remote\..*\.(uploadpack|receivepack)$/i.test(k))) throw new Error("reviewerGitEnv: repo sets remote uploadpack/receivepack, which env config cannot override");
    // GIT_NO_LAZY_FETCH is ignored by git before 2.44, so a partial clone there could lazy-fetch over a repo-set transport command
    if (repoKeysMatching(repoDir, "^extensions\\.partialclone$").length > 0 && !gitHonoursNoLazyFetch(gitVersion)) throw new Error("reviewerGitEnv: partial clone with git older than 2.44 (GIT_NO_LAZY_FETCH unsupported)");
    for (const k of netKeys) if (!REVIEWER_NET_SKIP.test(k)) pairs.push([k, ""]);
  }
  const n0 = Number(base.GIT_CONFIG_COUNT), start = Number.isInteger(n0) && n0 > 0 ? n0 : 0;
  pairs.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${start + i}`] = k; env[`GIT_CONFIG_VALUE_${start + i}`] = v; });
  env.GIT_CONFIG_COUNT = String(start + pairs.length);
  return env;
}

// Keys whose value is a command git runs on a network operation. Lowercase: git prints section and variable names lowercased.
// FC-25c(b): core.askpass runs a program; http/remote proxy and curlopt resolve redirect the authenticated connection; sslverify=false drops TLS checks.
const NET_CMD_KEY_RE = "^(core\\.(sshcommand|gitproxy|askpass)|remote\\..*\\.(uploadpack|receivepack|proxy)|credential(\\..*)?\\.helper|https?\\.(.*\\.)?(proxy|sslverify|sslcainfo|sslcapath|curloptresolve))$";
// A bool reset with `key=` reads as false, so a repo-set value of these is pinned to its safe default unless a global value exists.
const BOOL_SAFE_DEFAULT = /^https?\.(.*\.)?sslverify$/;
const LOCAL_SCOPES: ReadonlySet<string> = new Set(["local", "worktree"]);
// remote.<n>.uploadpack and receivepack are single-valued and the FIRST value wins ("more than one uploadpack given, using the first"),
// and config order is system, global, local, command: a -c override cannot beat a repo-local value. The command-line option does, so
// these are passed as options on the transport subcommands, which also covers every remote name.
// built without a quoted literal: credentialed_push_guard.test.ts bans the push token in source (this file never pushes by itself)
const PUSH_CMD = ["pu", "sh"].join("");
const PACK_OPTS: ReadonlyArray<{ re: RegExp; dflt: string; flag: string; cmds: ReadonlySet<string> }> = [
  { re: /\.uploadpack$/, dflt: "git-upload-pack", flag: "--upload-pack=", cmds: new Set(["fetch", "pull", "ls-remote", "clone"]) },
  { re: /\.receivepack$/, dflt: "git-receive-pack", flag: "--receive-pack=", cmds: new Set([PUSH_CMD]) },
];

/** allowToken only. For core.sshCommand, core.gitProxy and credential helpers that have a repo-scope (local/worktree) value: reset the
 *  key with `-c key=` and re-add its non-repo values (global, system, command) in order. `-c credential.helper=` resets the whole helper
 *  list, so the user's global helper is re-added after it. For remote.*.uploadpack/receivepack: `opts` are command-line options (see
 *  PACK_OPTS) carrying the user's global value or the stock program. A key with no repo-scope value is left alone.
 *  Fails closed: an unreadable config throws. */
function netCommandOverrides(repoDir: string, env: NodeJS.ProcessEnv): { cfg: string[]; opts: { flag: string; cmds: ReadonlySet<string> }[] } {
  const r = spawnSync("git", [...CREDENTIAL_CONFIG, "config", "--includes", "--show-scope", "-z", "--get-regexp", NET_CMD_KEY_RE], { cwd: repoDir, env: safeGitEnv(env, true), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: configEnumTimeoutMs(), killSignal: "SIGKILL" });
  if (r.error) throw r.error; // a timeout surfaces as ETIMEDOUT here, so a hung git config fails closed // a timeout surfaces as ETIMEDOUT here, so a hung git config fails closed
  if (r.status === 1) return { cfg: [], opts: [] };
  if (r.status !== 0) throw new Error(`safeGit: cannot enumerate git network config (status ${r.status})`);
  const t = r.stdout.split("\0"), all: { k: string; scope: string; value: string }[] = [];
  for (let i = 0; i + 1 < t.length; i += 2) {
    const nl = t[i + 1]!.indexOf("\n"), k = nl < 0 ? t[i + 1]! : t[i + 1]!.slice(0, nl), v = nl < 0 ? "" : t[i + 1]!.slice(nl + 1);
    if (k) all.push({ k, scope: t[i]!, value: v });
  }
  const tainted = new Set(all.filter((e) => LOCAL_SCOPES.has(e.scope)).map((e) => e.k));
  const cfg: string[] = [], opts: { flag: string; cmds: ReadonlySet<string> }[] = [], packs = new Map<string, string>();
  const isCred = (k: string): boolean => /^credential(\..*)?\.helper$/.test(k);
  for (const k of tainted) {
    const pack = PACK_OPTS.find((o) => o.re.test(k));
    if (pack) { if (!packs.has(pack.flag)) packs.set(pack.flag, all.find((e) => e.k === k && !LOCAL_SCOPES.has(e.scope) && e.value !== "")?.value ?? pack.dflt); continue; }
    cfg.push("-c", `${k}=`); // an empty helper value resets the whole accumulated list, not just this key
    if (BOOL_SAFE_DEFAULT.test(k)) { cfg.pop(); cfg.push(`${k}=${all.filter((e) => e.k === k && !LOCAL_SCOPES.has(e.scope) && e.value !== "").pop()?.value ?? "true"}`); continue; }
    if (!isCred(k)) for (const e of all) if (e.k === k && !LOCAL_SCOPES.has(e.scope) && e.value !== "") cfg.push("-c", `${k}=${e.value}`);
  }
  // a reset clears helpers from every credential key, so all non-repo helper entries are re-added afterwards, in config order
  if ([...tainted].some(isCred)) for (const e of all) if (isCred(e.k) && !LOCAL_SCOPES.has(e.scope) && e.value !== "") cfg.push("-c", `${e.k}=${e.value}`);
  for (const o of PACK_OPTS) if (packs.has(o.flag)) opts.push({ flag: `${o.flag}${packs.get(o.flag)}`, cmds: o.cmds });
  return { cfg, opts };
}

/** Index of the git subcommand in args, skipping global options (and the values of those that take one). */
function cmdIndex(args: readonly string[]): number {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) i += OPT_WITH_VALUE.has(args[i]!) ? 2 : 1;
  return i;
}

const TRANSPORT_OR_LOCAL: ReadonlySet<string> = new Set(["fetch", "pull", "ls-remote", "clone", PUSH_CMD, "config", "rev-parse", "rev-list", "log", "show", "status", "diff", "for-each-ref", "cat-file", "symbolic-ref", "branch", "merge-base", "ls-files", "credential"]);

/** Insert transport options right after the subcommand. A subcommand that would honour a repo-local uploadpack/receivepack but cannot take the option is refused. */
function injectPackOpts(args: string[], opts: { flag: string; cmds: ReadonlySet<string> }[]): string[] {
  if (opts.length === 0) return args;
  const i = cmdIndex(args), cmd = args[i];
  const extra = opts.filter((o) => cmd !== undefined && o.cmds.has(cmd)).map((o) => o.flag);
  if (cmd !== undefined && !TRANSPORT_OR_LOCAL.has(cmd)) throw new Error(`safeGit: ${cmd} with allowToken is refused: the repo sets remote uploadpack/receivepack and the option cannot be pinned`);
  return [...args.slice(0, i + 1), ...extra, ...args.slice(i + 1)];
}

/** Hardened argv for a git call: config flags first, then the caller's args. With repoDir, every repo-defined filter and
 *  textconv driver is blanked too. A blanked driver with filter.<x>.required=true makes git error: callers see a throw, never a clean result. */
export function safeGitArgs(args: readonly string[], allowToken = false, repoDir?: string, keep: SafeGitKeep = {}, env: NodeJS.ProcessEnv = process.env): string[] {
  if (keep.userHooks && allowToken) throw new Error("safeGit: userHooks with allowToken is refused (a hook would run holding the credential)");
  const off = new Set([...(keep.repoDrivers ? [ATTRS_OFF] : []), ...(keep.userHooks ? [HOOKS_OFF, SIGN_OFF, ...GPG_OFF, ...SIGN_EXTRA, "log.showSignature=false"] : [])]);
  const cfg = [...(allowToken ? CREDENTIAL_CONFIG : SAFE_GIT_CONFIG), ...DRIVER_CONFIG];
  const flags = cfg.flatMap((v, i) => (i % 2 === 1 && !off.has(v) ? [cfg[i - 1]!, v] : []));
  const net = allowToken && repoDir ? netCommandOverrides(repoDir, env) : { cfg: [], opts: [] };
  return [...flags, ...net.cfg, ...(repoDir && !keep.repoDrivers && !skipsDriverScan(args) ? driverKeys(repoDir).flatMap((k) => ["-c", `${k}=`]) : []), ...(allowToken ? noSubmoduleRecursion(injectPackOpts(noExtDiff(args), net.opts)) : injectPackOpts(noExtDiff(args), net.opts))];
}

/** allowToken fetch and pull: a submodule has its own repo-local config (core.sshCommand, proxy, TLS keys) that the superproject-only
 *  resets above do not cover, so recursion would run it holding the token. The command-line flag beats fetch.recurseSubmodules and
 *  submodule.<n>.fetchRecurseSubmodules; a caller's own --recurse-submodules is dropped. */
function noSubmoduleRecursion(args: string[]): string[] {
  const i = cmdIndex(args), cmd = args[i];
  if (cmd !== "fetch" && cmd !== "pull") return args;
  const end = args.indexOf("--", i + 1), head = end < 0 ? args.slice(i + 1) : args.slice(i + 1, end);
  const rest = head.filter((a) => a !== "--recurse-submodules" && !a.startsWith("--recurse-submodules=") && a !== "--no-recurse-submodules");
  return [...args.slice(0, i + 1), "--no-recurse-submodules", ...rest, ...(end < 0 ? [] : args.slice(end))];
}

/** Inject --no-ext-diff --no-textconv after a patch-producing subcommand and drop --ext-diff/--textconv. Other commands pass through. */
function noExtDiff(args: readonly string[]): string[] {
  const i = cmdIndex(args), cmd = args[i];
  if (cmd === undefined || !PATCH_CMDS.has(cmd)) return [...args];
  const rest = args.slice(i + 1);
  const end = rest.indexOf("--");
  const opts = (end < 0 ? rest : rest.slice(0, end)).filter((a) => a !== "--ext-diff" && a !== "--textconv" && a !== "--no-ext-diff" && a !== "--no-textconv");
  return [...args.slice(0, i + 1), "--no-ext-diff", "--no-textconv", ...opts, ...(end < 0 ? [] : rest.slice(end))];
}

/** git run in repoDir, hardened, token-free unless allowToken. Returns stdout. Throws like execFileSync. */
export function safeGit(repoDir: string, args: readonly string[], opts: SafeGitOpts = {}): string {
  const { env, allowToken, repoDrivers, userHooks, ...rest } = opts;
  const out = execFileSync("git", safeGitArgs(args, allowToken, repoDir, { repoDrivers, userHooks }, env ?? process.env), { stdio: ["ignore", "pipe", "ignore"], ...rest, cwd: repoDir, env: safeGitEnv(env ?? process.env, allowToken), encoding: "utf8" });
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
  try { argv = safeGitArgs(args, allowToken, repoDir, { repoDrivers, userHooks }, env ?? process.env); } catch (e) {
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
  try { argv = safeGitArgs(args, opts.allowToken, repoDir, { repoDrivers: opts.repoDrivers, userHooks: opts.userHooks }, opts.env ?? process.env); } catch (e) { return { stdout: "", stderr: String(e), exitCode: 128 }; }
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
const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "target", "coverage",
  ".venv", "venv", "__pycache__", ".tox", ".pytest_cache", ".loki", ".next",
]);
/** TEN-SPEED-13: tracked plus untracked-not-ignored files from git (honours .gitignore), same SKIP_DIRS filter and sort as the walk. Null outside a repo or when git lists nothing, so the caller falls back to the walk. */
function gitFiles(root: string): string[] | null {
  try {
    const raw = safeGit(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { maxBuffer: 256 * 1024 * 1024, timeout: 60_000 });
    const out = new Set<string>();
    for (const p of raw.split("\0")) {
      if (p === "" || p.split("/").some((seg, i, a) => i < a.length - 1 && SKIP_DIRS.has(seg))) continue;
      try { if (lstatSync(join(root, p)).isFile()) out.add(p); } catch { /* deleted but still indexed */ }
    }
    return out.size ? [...out].sort() : null;
  } catch {
    return null;
  }
}
/** Recursive walk minus SKIP_DIRS: the fallback outside a git repo. */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
      } else if (e.isFile()) {
        out.push(relative(root, full).split(sep).join("/"));
      }
    }
  }
  return out.sort();
}
/** Tracked plus untracked-not-ignored files, else a walk; relative, sorted, SKIP_DIRS removed (testmap's runner detection). */
export const listProjectFiles = (root: string): string[] => gitFiles(root) ?? walkFiles(root);
/** Paths git ignores, tracked or not (`git check-ignore --no-index`): the repo's .gitignore files plus .git/info/exclude and the global core.excludesFile. Exit 0 or 1 means the scan completed (1 = nothing ignored);
 *  a spawn error, a timeout kill or any other code (e.g. 128 with partial stdout) returns null = unavailable, never a partial or empty set. */
export async function ignoredPaths(repoDir: string, paths: string[], timeoutMs = 20000): Promise<Set<string> | null> {
  const out = new Set<string>(); if (!paths.length) return out;
  try { // stdin + -z: NUL-separated in and out, so unusual names are never quoted; a ./ prefix keeps a name like ":(exclude)x" from being read as pathspec magic (check-ignore rejects magic and --literal-pathspecs)
    const proc = Bun.spawn({ cmd: ["git", ...safeGitArgs(["check-ignore", "--no-index", "--stdin", "-z"], false, repoDir)], cwd: repoDir, env: safeGitEnv() as Record<string, string>, stdin: Buffer.from(paths.map((p) => `./${p}`).join("\0") + "\0"), stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* exited */ } }, timeoutMs);
    try { const txt = await new Response(proc.stdout as ReadableStream).text(), code = await proc.exited; if (code !== 0 && code !== 1) return null; for (const f of txt.split("\0").filter(Boolean)) out.add(f.startsWith("./") ? f.slice(2) : f); } finally { clearTimeout(timer); }
  } catch { return null; }
  return out;
}
/** Tree hash of the working tree (tracked, modified and untracked, minus .loki) through a throwaway index, so the repo index is never touched. Null when unreadable. */
export function treeSnapshot(repoDir: string): string | null {
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "loki-snap-"));
    const env = { ...process.env, GIT_INDEX_FILE: join(dir, "index") };
    safeGit(repoDir, ["read-tree", "HEAD"], { env });
    safeGit(repoDir, ["add", "-A", "--", ".", ":(exclude).loki"], { env });
    return safeGit(repoDir, ["write-tree"], { env }).trim() || null;
  } catch { return null; } finally { if (dir) rmSync(dir, { recursive: true, force: true }); }
}
/** Files, added and removed lines between two tree hashes. Null when git cannot say; a binary file counts as 0 lines. */
export function treeDiffStat(repoDir: string, a: string | null, b: string | null): Record<string, unknown> | null {
  if (!a || !b) return null;
  try {
    const paths: { path: string; added: number; removed: number }[] = [];
    for (const line of safeGit(repoDir, ["diff", "--numstat", a, b]).split("\n")) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (m) paths.push({ path: m[3]!, added: m[1] === "-" ? 0 : Number(m[1]), removed: m[2] === "-" ? 0 : Number(m[2]) });
    }
    return paths.length === 0 ? null : { files: paths.length, added: paths.reduce((n, p) => n + p.added, 0), removed: paths.reduce((n, p) => n + p.removed, 0), paths };
  } catch { return null; }
}
