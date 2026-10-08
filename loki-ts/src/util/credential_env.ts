// FC-90 (P9, D86): the ONE place a child env is stripped of the user's ambient GitHub credential. Deleting GH_TOKEN and
// friends is not enough: with no env token gh falls back to ~/.config/gh/hosts.yml and then the OS keyring, and git
// calls its configured credential helpers (osxkeychain, `gh auth git-credential`) on any HTTPS push. So the hardened env has:
//   - the 4 token vars set to a non-working sentinel (gh then never consults the keyring: a token in env wins, and is invalid),
//   - GH_CONFIG_DIR pointing at an empty per-process directory (mode 700, so a hosts.yml read finds nothing),
//   - credential.helper reset to empty through GIT_CONFIG_COUNT/KEY/VALUE (env only, the user's gitconfig is never edited; an
//     empty value resets the accumulated helper list; appended after any existing entries so the user's identity keys survive),
//   - GIT_TERMINAL_PROMPT=0 and GCM_INTERACTIVE=never, so nothing falls back to a prompt.
// Measured with gh on this host: GH_CONFIG_DIR alone leaves `gh auth token` exit 0 (keyring); the sentinel alone leaves a
// direct hosts.yml read; both together make `gh auth status` report a failed login. The pure-git leg needs the helper reset.
import { mkdtempSync, rmSync, statSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const GITHUB_TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"] as const;
/** The worker's assertWorkerEnv accepts a token var only when it starts with this. Alphanumeric after the prefix so the
 *  proof redactor (gh[pousr]_[A-Za-z0-9]{20,}) still catches it if it ever leaks into an artifact. */
export const SENTINEL_PREFIX = "ghp_LOKIWITHHELDsentinel";

let sentinel: string | null = null;
let configDir: string | null = null;
let exitHooked = false;

/** One fresh garbage value per process. */
export function withheldSentinel(fresh = false): string {
  if (fresh) sentinel = null;
  return (sentinel ??= `${SENTINEL_PREFIX}${process.pid}${randomBytes(8).toString("hex")}INVALID`);
}

const isDir = (p: string): boolean => { try { return !lstatSync(p).isSymbolicLink() && statSync(p).isDirectory(); } catch { return false; } };

/** The per-process empty GH_CONFIG_DIR. Lives under the run's own LOKI_RUN_TMP when that is a real directory, else under the
 *  OS temp dir; created by mkdtemp (mode 700) and removed, by exact path only, when the process exits. Best-effort: null on failure. */
export function emptyGhConfigDir(env: NodeJS.ProcessEnv = process.env): string | null {
  if (configDir && isDir(configDir)) return configDir;
  const runTmp = env["LOKI_RUN_TMP"] ?? "";
  const root = runTmp !== "" && isDir(runTmp) ? runTmp : tmpdir();
  try {
    configDir = mkdtempSync(join(root, "loki-gh-config-"));
  } catch {
    return null;
  }
  if (!exitHooked) {
    exitHooked = true;
    process.once("exit", () => { if (configDir) try { rmSync(configDir, { recursive: true, force: true }); } catch { /* best-effort */ } });
  }
  return configDir;
}

/** Mutates env: withholds every ambient GitHub credential (see the header). Idempotent. Does not touch SSH.
 *  fresh: mint a new sentinel for this call (the worker env); the default reuses the per-process one. */
export function hardenCredentialEnv(env: NodeJS.ProcessEnv, fresh = false): void {
  const s = withheldSentinel(fresh);
  for (const v of GITHUB_TOKEN_VARS) env[v] = s;
  const dir = emptyGhConfigDir(env);
  if (dir) env["GH_CONFIG_DIR"] = dir;
  const existing = Number(env["GIT_CONFIG_COUNT"]);
  const n = Number.isInteger(existing) && existing >= 0 ? existing : 0;
  const alreadyLast = n > 0 && env[`GIT_CONFIG_KEY_${n - 1}`] === "credential.helper" && env[`GIT_CONFIG_VALUE_${n - 1}`] === "";
  if (!alreadyLast) {
    env[`GIT_CONFIG_KEY_${n}`] = "credential.helper";
    env[`GIT_CONFIG_VALUE_${n}`] = "";
    env["GIT_CONFIG_COUNT"] = String(n + 1);
  }
  env["GIT_TERMINAL_PROMPT"] = "0";
  env["GCM_INTERACTIVE"] = "never";
}
