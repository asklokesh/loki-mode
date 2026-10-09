// Rule of Two (moat P9) on the Bun route: Loki never passes the GitHub token into the agent's environment
// via the IMPLICIT resolution paths this module withholds (env
// vars, gh config store, git credential.helper, SSH agent/ssh command). Not
// an absolute claim -- see the disclosed residuals further down (an explicit
// named-account keyring read, a direct ssh/hosts.yml/keychain read outside
// git); the actual security boundary is a CI job holding no write token and
// no SSH agent while the agent runs.
//
// Mirrors _loki_withhold_github_tokens in autonomy/run.sh. The runner reads
// spec text and spawns agents (claude CLI, the Agent SDK query(), codex,
// cline, aider, council voters) that all inherit process.env, so a token left
// there is one prompt injection away from a push. Unlike bash, the Bun runner
// has no post-session push or PR step of its own (issue refs and PR creation
// run on the bash route), so the token is dropped from the process outright.
//
// LOKI_ALLOW_AGENT_GITHUB_TOKEN=1 (exact value) keeps the old inheritance and
// prints one stderr line saying the agent holds the token.
//
// BACKLOG 149 (round 2, REJECT rework): a reviewer confirmed, live against
// real gh 2.92 + a real macOS Keychain-backed `gh auth login`, that scoping
// GH_CONFIG_DIR to an empty directory does NOT close this. Two bypasses,
// reproduced empirically on 2026-09-27 (see the S-18 rework session
// transcript; no real credential value was ever printed during verification):
//
//   1. `GH_CONFIG_DIR=<empty dir> gh auth token` (real $HOME, no env token)
//      still exits 0: gh's resolution is config-dir file, THEN OS keyring
//      fallback (Keychain on macOS, libsecret on Linux). An empty config dir
//      does not stop the keyring lookup.
//   2. git's own `credential.helper` (`gh auth setup-git` wires
//      `credential.https://github.com.helper = !gh auth git-credential`, and
//      a plain `osxkeychain`/`libsecret`/etc. helper may ALSO be configured,
//      unscoped) is invoked directly by git on any `git push`/`git credential
//      fill` over HTTPS -- git-invoked, not GH_CONFIG_DIR-mediated at all.
//
// Fix, verified against `gh help environment` and empirically against both
// bypasses:
//
//   (a) The 4 token vars are no longer deleted -- each is set to a fresh
//       per-process garbage value (SENTINEL). `gh help environment`
//       documents the env token as taking "precedence over previously stored
//       credentials", confirmed live: with the sentinel present, `gh auth
//       token` AND `gh auth git-credential get` both echo back the garbage
//       value rather than falling through to the keyring. `gh auth
//       git-credential get` is a pure read/print in this path -- no write to
//       GH_CONFIG_DIR, no keychain mutation -- so the sentinel has no
//       destructive side effect; a `git push` using it just gets a 401.
//   (b) The sentinel alone does not close a plain unscoped `osxkeychain` (or
//       similar) helper holding its own independently-cached credential --
//       confirmed present as a THIRD, gh-independent store on the
//       verification machine. So `credential.helper` is additionally reset to
//       the empty string via GIT_CONFIG_COUNT/GIT_CONFIG_KEY_n/
//       GIT_CONFIG_VALUE_n, appended after any pre-existing GIT_CONFIG_COUNT.
//       Per gitcredentials(7), an empty-string `credential.helper` resets the
//       ACCUMULATED helper list to empty -- this must be unscoped (plain
//       `credential.helper`, not a URL-scoped key) and last (env-var config
//       overrides every config file, and later GIT_CONFIG_KEY_n entries are
//       read after earlier ones) to guarantee no other configured helper
//       still runs. Confirmed live: with this override present, `git
//       credential fill` against github.com fails closed ("could not read
//       Username") with no fallback to any other helper.
//
// GH_CONFIG_DIR is still scoped to a fresh empty directory (unconditionally,
// same as before) -- still correct for a direct plaintext-hosts.yml read or
// any gh subcommand that ignores GH_TOKEN. $HOME itself is untouched, so
// Claude's own OAuth is unaffected. The Bun runner has no trusted post-session
// gh/git call of its own to re-grant this to (see module comment above); if
// one is ever added here, it must restore the operator's original GH_TOKEN
// family values, GH_CONFIG_DIR, and GIT_CONFIG_COUNT/KEY/VALUE state (or their
// absence) around that one call, the same way the bash route's
// _loki_with_github_tokens does.
//
// BACKLOG 149 (round 3, REJECT rework): round 2's fix is HTTPS-only. Neither
// SSH_AUTH_SOCK nor GIT_SSH_COMMAND/core.sshCommand was touched, so the
// runner's real, untouched environment always has a reachable SSH agent (by
// this design's own stated intent of keeping the environment live for
// Claude's own OAuth) -- an agent can `git remote set-url origin
// git@github.com:<owner>/<repo>.git && git push` and authenticate exactly as
// an unrestricted session. Mirrors autonomy/run.sh's
// _loki_withhold_github_tokens fix (see its header comment for the git-docs
// citation and the full residual-gap list): SSH_AUTH_SOCK is deleted (not
// sentineled -- a present-but-wrong socket does not stop ssh's fallbacks
// either: ssh still tries ~/.ssh/id_* default keys and any ~/.ssh/config
// IdentityAgent, so a sentinel buys nothing over unset), and GIT_SSH_COMMAND
// is set to `false` (a POSIX builtin, ignores all arguments, always exits 1),
// which env-overrides any core.sshCommand per git's own docs. That override is
// what actually closes git's ssh transport, since git then never runs ssh.
// The Bun runner has no trusted post-session git call to re-grant this to,
// same as the token vars above.
//
// Every subprocess this module's callers spawn must pass an explicit `env`:
// in Bun (measured on 1.3.13) a spawn with no `env` option inherits the
// environment from process START and silently undoes everything above
// (round 4; guarded by tests/runner/spawn_env_guard.test.ts, repro in
// tests/runner/spawn_env_fsmonitor.test.ts).
//
// Hygiene against a naive injection, not an isolation boundary: code running
// as the same user can still read another process's environment, the
// hosts.yml file directly off disk (HOME stays live by design), or invoke
// `git -c credential.helper=...` / `gh auth token -u <username>` /
// `env -u GH_TOKEN -u GITHUB_TOKEN gh auth token` / `env -u GIT_SSH_COMMAND
// git push git@...` (ssh falls back to ~/.ssh/id_* and any IdentityAgent) /
// the real `ssh` binary directly with `-i <key>` or a rediscovered agent
// socket (`launchctl getenv SSH_AUTH_SOCK` on macOS) / git's `ext::`
// transport (`git -c protocol.ext.allow=always`, which runs an arbitrary
// command as the transport) / GIT_ASKPASS (VS Code's terminal points it at a
// helper that can answer git's credential prompt; left untouched here)
// explicitly to route around this. The boundary is
// a CI job that holds no write token and no SSH agent while the agent runs.

import { safeGit } from "../util/safe_git.ts";
import { GITHUB_TOKEN_VARS, hardenCredentialEnv } from "../util/credential_env.ts";

// FC-90: the sentinel, the empty GH_CONFIG_DIR and the credential.helper reset live in util/credential_env.ts, shared with
// tokenFreeEnv and plainTestEnv. The module comment above documents why each leg exists.
export { GITHUB_TOKEN_VARS };

export const AGENT_TOKEN_WARNING_PREFIX =
  "WARNING: LOKI_ALLOW_AGENT_GITHUB_TOKEN=1: the agent session holds the GitHub token";

export const GIT_VERSION_FLOOR_WARNING =
  "WARNING: git < 2.31 detected -- GIT_CONFIG_COUNT/GIT_CONFIG_KEY/GIT_CONFIG_VALUE (used to reset credential.helper) are silently ignored on this git version. The git-invoked credential-helper bypass (BACKLOG 149 round 2) is NOT closed on this host; upgrade git to 2.31+ to close it. The GH_TOKEN-family sentinel, GH_CONFIG_DIR scoping, and the SSH_AUTH_SOCK/GIT_SSH_COMMAND withhold above are unaffected and still apply (GIT_SSH_COMMAND is a plain env var, not a GIT_CONFIG_* mechanism, so it needs no version floor).";

// GIT_CONFIG_COUNT/GIT_CONFIG_KEY_n/GIT_CONFIG_VALUE_n were introduced in git
// 2.31.0 (2021-03-15); an older git silently ignores them, leaving the
// credential.helper reset a no-op with no error signal. Mirrors the bash
// route's git-version detection in _loki_gh_capture (autonomy/run.sh) -- this
// was previously missing on the Bun route entirely (a secondary, non-blocking
// finding from the round-2 rework). Best-effort: any failure to invoke or
// parse `git --version` is treated as "cannot tell", which does not warn
// (matching the bash route's fail-silent-on-unparseable behavior).
function isGitVersionBelowFloor(): boolean {
  try {
    const out = safeGit(process.cwd(), ["--version"]);
    const m = /git version (\d+)\.(\d+)/.exec(out);
    if (!m) return false;
    const major = Number(m[1]);
    const minor = Number(m[2]);
    return major < 2 || (major === 2 && minor < 31);
  } catch {
    return false;
  }
}

/**
 * Set every GitHub token var to a fresh per-process garbage value (never
 * merely delete them -- see module comment (a)), scope gh's own credential
 * store (GH_CONFIG_DIR) to a fresh empty directory, reset git's own
 * credential.helper chain to empty (module comment (b)), and remove the SSH
 * agent / override the ssh command (round 3, see module comment), unless the
 * operator opted out. Returns the token names that held a real value before
 * this ran (config/credential-helper/SSH scoping is not reflected in the
 * return value -- callers that only care about the 4 env vars, such as the
 * existing tests, keep working unchanged). Under the opt-out nothing is
 * changed and, when a token is present, exactly one warning line goes to
 * `warn`. When git below 2.31 is detected, one additional warning line
 * (GIT_VERSION_FLOOR_WARNING) goes to `warn` naming exactly what stays open.
 */
export function withholdGithubTokens(
  env: NodeJS.ProcessEnv = process.env,
  warn: (line: string) => void = (line) => {
    process.stderr.write(line + "\n");
  },
): string[] {
  const present = GITHUB_TOKEN_VARS.filter((v) => (env[v] ?? "") !== "");
  if (env["LOKI_ALLOW_AGENT_GITHUB_TOKEN"] === "1") {
    if (present.length > 0) {
      warn(
        `${AGENT_TOKEN_WARNING_PREFIX} (${present.join(" ")}); an injected prompt can push with it (Rule of Two exposure).`,
      );
    }
    return [];
  }
  hardenCredentialEnv(env, true);
  if (isGitVersionBelowFloor()) {
    warn(GIT_VERSION_FLOOR_WARNING);
  }
  // SSH sentinel (round 3, BACKLOG 149): no reachable SSH agent, and any
  // ssh-transport git operation fails closed via GIT_SSH_COMMAND=false (env
  // var, so it overrides any core.sshCommand -- see module comment).
  delete env["SSH_AUTH_SOCK"];
  env["GIT_SSH_COMMAND"] = "false";
  return present;
}
