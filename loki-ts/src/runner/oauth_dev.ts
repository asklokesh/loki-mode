// v8 dev-only OAuth auth for the raw-SDK judge path.
//
// PURPOSE (development only): let a developer exercise the SDK route with their
// existing `claude` login (a claude.ai subscription OAuth token) instead of a
// standalone ANTHROPIC_API_KEY. This is gated so it can NEVER affect production:
// it activates ONLY when LOKI_SDK_OAUTH_DEV is truthy AND no ANTHROPIC_API_KEY is
// present. With an API key set, or the flag unset, this module is inert.
//
// Verified live (2026-07-15): a FRESH claude.ai OAuth access token is accepted by
// the Messages API as `Authorization: Bearer <token>` together with the required
// `anthropic-beta: oauth-2025-04-20` header. A stale/expired token is rejected,
// so we always read the freshest copy at call time (the `claude` CLI refreshes
// into the macOS Keychain, NOT the on-disk .credentials.json, so Keychain wins).
//
// CEILING (ponytail): the token expires ~hourly and we do NOT refresh it (that
// needs a network/CLI round-trip). For a long unattended run the token can lapse
// mid-run; when it does, the SDK call fails closed to the deterministic/bash
// fallback exactly like a missing key. That is acceptable for DEV TESTING, which
// is the only thing this flag is for. Production uses ANTHROPIC_API_KEY.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

// The anthropic-beta header value the Messages API requires to accept a claude.ai
// OAuth bearer token (verified live). Exported so the client builder sets it.
export const OAUTH_BETA_HEADER = "oauth-2025-04-20";

// Is dev-OAuth requested AND safe to use (no API key present)?
export function oauthDevEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = (env["LOKI_SDK_OAUTH_DEV"] || "").trim().toLowerCase();
  const on = flag === "1" || flag === "true" || flag === "yes";
  // Never override an explicit API key; OAuth-dev is the no-key fallback only.
  return on && !env["ANTHROPIC_API_KEY"];
}

// Extract claudeAiOauth.accessToken from a credentials JSON blob, returning the
// token only if it is not already expired (expiresAt is epoch-ms). Returns "" on
// any problem so the caller degrades to no-token (fail closed).
function tokenFromBlob(raw: string): string {
  try {
    const cred = JSON.parse(raw)?.claudeAiOauth;
    if (!cred || typeof cred.accessToken !== "string") return "";
    const exp = typeof cred.expiresAt === "number" ? cred.expiresAt : 0;
    // Reject if expired (or within 60s of expiry) -- a stale token 401s.
    if (exp > 0 && exp / 1000 <= Date.now() / 1000 + 60) return "";
    return cred.accessToken;
  } catch {
    return "";
  }
}

// Read the freshest available claude.ai OAuth access token. Order:
//   1. macOS Keychain ("Claude Code-credentials") -- the native CLI refreshes
//      here, so it holds the newest token.
//   2. ${CLAUDE_CONFIG_DIR:-~/.claude}/.credentials.json -- the file-based login.
// Returns "" when no fresh token is available (caller falls back to no-key).
export function readFreshOauthToken(env: NodeJS.ProcessEnv = process.env): string {
  // 1. Keychain (macOS only; execFileSync throws on non-mac / missing entry).
  if (process.platform === "darwin") {
    try {
      const out = execFileSync(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { encoding: "utf8", timeout: 5000 },
      );
      const t = tokenFromBlob(out.trim());
      if (t) return t;
    } catch {
      // no keychain entry / not mac -- fall through to the file.
    }
  }
  // 2. File-based credentials.
  try {
    const dir = env["CLAUDE_CONFIG_DIR"] || `${homedir()}/.claude`;
    const raw = readFileSync(`${dir}/.credentials.json`, "utf8");
    const t = tokenFromBlob(raw);
    if (t) return t;
  } catch {
    // no file -- no token.
  }
  return "";
}
