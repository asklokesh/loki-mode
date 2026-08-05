// Unit tests for the dev-only OAuth fallback gate (loki-ts/src/runner/oauth_dev.ts).
// Hermetic: no network, no real token needed -- asserts the GATE logic (when the
// fallback activates) and the token freshness/expiry rule. The end-to-end "a real
// OAuth token drives a real judge call" is proven separately (live probe), not here.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oauthDevEnabled, readFreshOauthToken } from "../../src/runner/oauth_dev.js";

describe("oauthDevEnabled gate", () => {
  test("off by default (no flag, no key)", () => {
    expect(oauthDevEnabled({})).toBe(false);
  });

  test("on when flag=1 and NO api key", () => {
    expect(oauthDevEnabled({ LOKI_SDK_OAUTH_DEV: "1" })).toBe(true);
    expect(oauthDevEnabled({ LOKI_SDK_OAUTH_DEV: "true" })).toBe(true);
    expect(oauthDevEnabled({ LOKI_SDK_OAUTH_DEV: "yes" })).toBe(true);
  });

  test("OFF when an API key is present, even with the flag (key wins, prod-safe)", () => {
    expect(
      oauthDevEnabled({ LOKI_SDK_OAUTH_DEV: "1", ANTHROPIC_API_KEY: "sk-ant-xxx" }),
    ).toBe(false);
  });

  test("off for falsey/unknown flag values", () => {
    expect(oauthDevEnabled({ LOKI_SDK_OAUTH_DEV: "0" })).toBe(false);
    expect(oauthDevEnabled({ LOKI_SDK_OAUTH_DEV: "" })).toBe(false);
    expect(oauthDevEnabled({ LOKI_SDK_OAUTH_DEV: "off" })).toBe(false);
  });
});

// On non-macOS the reader only consults the file; on macOS it consults the
// Keychain FIRST, so a file-only fixture may be shadowed by a real Keychain
// token. Skip the file-freshness assertions on darwin to stay deterministic.
describe.if(process.platform !== "darwin")("readFreshOauthToken file expiry", () => {
  function withCredFile(body: unknown): { dir: string; env: NodeJS.ProcessEnv } {
    const dir = mkdtempSync(join(tmpdir(), "loki-oauth-"));
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify(body));
    return { dir, env: { CLAUDE_CONFIG_DIR: dir } };
  }

  test("returns a non-expired token", () => {
    const future = Date.now() + 3_600_000; // +1h
    const { dir, env } = withCredFile({ claudeAiOauth: { accessToken: "sk-ant-oat-FRESH", expiresAt: future } });
    try {
      expect(readFreshOauthToken(env)).toBe("sk-ant-oat-FRESH");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects an EXPIRED token (would 401) -> empty", () => {
    const past = Date.now() - 3_600_000; // -1h
    const { dir, env } = withCredFile({ claudeAiOauth: { accessToken: "sk-ant-oat-STALE", expiresAt: past } });
    try {
      expect(readFreshOauthToken(env)).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a token WITHIN the 60s expiry skew (would 401 mid-call) -> empty", () => {
    // 30s out is not-yet-expired but inside the 60s guard, so it must be rejected
    // -- this is the real boundary that prevents a mid-call 401 on a token about
    // to lapse. Locks the fail-closed skew rule (oauth_dev.ts expiresAt guard).
    const soon = Date.now() + 30_000; // +30s, inside the 60s window
    const { dir, env } = withCredFile({ claudeAiOauth: { accessToken: "sk-ant-oat-EDGE", expiresAt: soon } });
    try {
      expect(readFreshOauthToken(env)).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing file / no token -> empty (fail closed)", () => {
    expect(readFreshOauthToken({ CLAUDE_CONFIG_DIR: "/nonexistent-loki-oauth-dir" })).toBe("");
  });
});
