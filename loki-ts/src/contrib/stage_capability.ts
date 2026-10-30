// GAME10-05a: per-stage capability record, fail closed. can_push and network are true, false or "unknown"; false is returned only when the code positively proves it, never because a pattern failed to match.
// A new file: no existing contrib module owns spawn-time capability evidence.
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { sep } from "node:path";
import { GITHUB_TOKEN_VARS, SENTINEL_PREFIX } from "../util/credential_env.ts";
import type { StageCapability } from "../engine10/hooks.ts";

type Tri = boolean | "unknown";
/** The one list of env names a stage child may carry. Anything outside it is reported in `secrets` by name, whatever it is called.
 * Interim: this list is replaced by the repo env allowlist when that lands; do not grow it. */
export const SAFE_ENV_NAMES: ReadonlySet<string> = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TZ", "CI", "PWD", "NO_COLOR", "FORCE_COLOR", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"]);
/** Env objects returned by buildStageEnv. Module-private identity mark: no env var, property or value a caller can set makes an object a member. */
const BUILT_BY_HELPER = new WeakSet<object>();
/** The allowlist env builder: only SAFE_ENV_NAMES from `base`, a run-owned HOME, no system git config, global git config /dev/null. Only an env returned here can record can_push false. */
export function buildStageEnv(home: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of SAFE_ENV_NAMES) if (base[k] !== undefined) env[k] = base[k];
  env.HOME = home; env.GIT_CONFIG_NOSYSTEM = "1"; env.GIT_CONFIG_GLOBAL = "/dev/null";
  BUILT_BY_HELPER.add(env);
  return env;
}
const PUSH_TOKEN_VARS = [...GITHUB_TOKEN_VARS, "GITLAB_TOKEN", "LOKI_PR_BOT_TOKEN"];

// --- network: strict parse of the wrapper's own leading flags ---
const base = (p: string): string => p.split("/").pop() ?? "";
/** unshare: only -n/--net (bare) proves a fresh network namespace; --net=<file> joins an existing one, so it proves nothing. */
function unshareNoNet(args: readonly string[]): boolean {
  const LONG = new Set(["--mount", "--uts", "--ipc", "--pid", "--user", "--cgroup", "--time", "--fork", "--kill-child", "--map-root-user", "--map-current-user", "--mount-proc"]);
  let net = false;
  for (const a of args) {
    if (a === "--") return net;
    if (a === "--net") net = true;
    else if (LONG.has(a)) continue;
    else if (/^-[muinpUCTfrc]+$/.test(a)) { if (a.includes("n")) net = true; }
    else if (a.startsWith("-")) return false; // unknown flag, value-taking flag or --net=<file>: the parse is no longer proven
    else return net; // first non-flag token is the inner command
  }
  return false;
}
/** bwrap: the last of --unshare-net, --unshare-all and --share-net wins; every option's arity is known or the parse is abandoned. */
function bwrapNoNet(args: readonly string[]): boolean {
  const ARITY: Record<string, number> = { "--unshare-all": 0, "--unshare-net": 0, "--share-net": 0, "--unshare-user": 0, "--unshare-user-try": 0, "--unshare-ipc": 0, "--unshare-pid": 0, "--unshare-uts": 0, "--unshare-cgroup": 0, "--unshare-cgroup-try": 0, "--die-with-parent": 0, "--new-session": 0, "--as-pid-1": 0, "--clearenv": 0, "--disable-userns": 0, "--assert-userns-disabled": 0,
    "--chdir": 1, "--unsetenv": 1, "--lock-file": 1, "--sync-fd": 1, "--remount-ro": 1, "--proc": 1, "--dev": 1, "--tmpfs": 1, "--mqueue": 1, "--dir": 1, "--userns": 1, "--userns2": 1, "--pidns": 1, "--uid": 1, "--gid": 1, "--hostname": 1, "--cap-add": 1, "--cap-drop": 1, "--seccomp": 1, "--argv0": 1, "--block-fd": 1, "--info-fd": 1,
    "--bind": 2, "--bind-try": 2, "--dev-bind": 2, "--dev-bind-try": 2, "--ro-bind": 2, "--ro-bind-try": 2, "--setenv": 2, "--symlink": 2, "--file": 2, "--bind-data": 2, "--ro-bind-data": 2, "--chmod": 2 };
  let net = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") return net;
    if (!a.startsWith("-")) return net;
    const n = ARITY[a];
    if (n === undefined) return false;
    if (a === "--unshare-net" || a === "--unshare-all") net = true; else if (a === "--share-net") net = false;
    i += n;
  }
  return false;
}
/** firejail: its own options are all --name[=value]; a conflicting or cancelling option makes the result unproven. */
function firejailNoNet(args: readonly string[]): boolean {
  let none = false;
  for (const a of args) {
    if (a === "--") return none;
    if (!a.startsWith("-")) return none;
    if (a === "--net=none") none = true;
    else if (a.startsWith("--net=") || a.startsWith("--netns") || a.startsWith("--ignore") || a.startsWith("--profile") || a.startsWith("--join") || !a.startsWith("--")) return false;
  }
  return false;
}
/** false only when argv starts with a known wrapper whose own leading flags positively cut the network; otherwise "unknown". Flags after the first non-flag token belong to the inner command and are never read. */
export function argvEnforcesNoNetwork(argv: readonly string[]): Tri {
  const rest = argv.slice(1);
  switch (base(argv[0] ?? "")) {
    case "unshare": return unshareNoNet(rest) ? false : "unknown";
    case "bwrap": return bwrapNoNet(rest) ? false : "unknown";
    case "firejail": return firejailNoNet(rest) ? false : "unknown";
    case "sandbox-exec": return "unknown"; // SBPL is a Scheme, so a profile cannot be proven free of allow and is never read
    default: return "unknown";
  }
}

/** HOME is a real directory inside the run-owned temp directory (the one carrying the .loki-run-owned marker naming itself). */
function homeRunOwned(home: string | undefined, runTmp: string | undefined): boolean {
  if (!home || !runTmp) return false;
  try {
    if (lstatSync(runTmp).isSymbolicLink() || lstatSync(home).isSymbolicLink() || !lstatSync(home).isDirectory()) return false;
    const marker = `${runTmp}${sep}.loki-run-owned`;
    if (!existsSync(marker) || lstatSync(marker).isSymbolicLink() || readFileSync(marker, "utf8").split("\n")[0] !== runTmp) return false;
    const root = realpathSync(runTmp), h = realpathSync(home);
    return h === root || h.startsWith(root + sep);
  } catch { return false; }
}

/** One stage's record from the env and argv it is spawned with. Names only; no value enters the record. */
export function stageCapability(stage: string, env: NodeJS.ProcessEnv, argv: readonly string[] = [], runTmp: string | undefined = process.env.LOKI_RUN_TMP): StageCapability {
  const names = Object.keys(env).filter((k) => env[k] !== undefined);
  const secrets = names.filter((k) => !SAFE_ENV_NAMES.has(k)).sort();
  const network = argvEnforcesNoNetwork(argv);
  const tokenHeld = PUSH_TOKEN_VARS.some((k) => { const v = env[k] ?? ""; return v !== "" && !v.startsWith(SENTINEL_PREFIX); });
  const sealed = BUILT_BY_HELPER.has(env) && secrets.length === 0 && homeRunOwned(env.HOME, runTmp) && env.GIT_CONFIG_NOSYSTEM !== undefined && env.GIT_CONFIG_NOSYSTEM !== "" && env.GIT_CONFIG_GLOBAL === "/dev/null" && network === false;
  return { stage, secrets, can_push: tokenHeld ? true : sealed ? false : "unknown", network };
}
