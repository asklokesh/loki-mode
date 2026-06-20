import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  isNewer,
  maybePrintUpdateHint,
  resolveLatest,
  shouldSkipUpdateCheck,
} from "../../src/util/update_check.ts";

// Each test injects its own throwaway cache file so nothing touches the real
// ~/.loki (note: os.homedir() ignores a mutated $HOME on macOS, so stubbing
// env is not enough; the cache path is injectable instead).
let prevNoCheck: string | undefined;
let prevCI: string | undefined;
let tmpDir: string;
let cacheFile: string;

beforeEach(() => {
  prevNoCheck = process.env["LOKI_NO_UPDATE_CHECK"];
  prevCI = process.env["CI"];
  delete process.env["LOKI_NO_UPDATE_CHECK"];
  delete process.env["CI"];
  tmpDir = mkdtempSync(resolve(tmpdir(), "loki-update-test-"));
  cacheFile = resolve(tmpDir, "update-check.json");
});

afterEach(() => {
  if (prevNoCheck === undefined) delete process.env["LOKI_NO_UPDATE_CHECK"];
  else process.env["LOKI_NO_UPDATE_CHECK"] = prevNoCheck;
  if (prevCI === undefined) delete process.env["CI"];
  else process.env["CI"] = prevCI;
  rmSync(tmpDir, { recursive: true, force: true });
});

// Run a body with process.stdout.isTTY forced to a value, then restore. Needed
// because the bun test runner is non-TTY, which would short-circuit the check.
async function withTTY(value: boolean, body: () => Promise<void>): Promise<void> {
  const orig = process.stdout.isTTY;
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
  try {
    await body();
  } finally {
    Object.defineProperty(process.stdout, "isTTY", { value: orig, configurable: true });
  }
}

describe("isNewer", () => {
  it("detects strictly newer releases across each component", () => {
    expect(isNewer("7.89.0", "7.88.0")).toBe(true);
    expect(isNewer("7.88.1", "7.88.0")).toBe(true);
    expect(isNewer("8.0.0", "7.88.0")).toBe(true);
  });
  it("returns false for same or older", () => {
    expect(isNewer("7.88.0", "7.88.0")).toBe(false);
    expect(isNewer("7.87.9", "7.88.0")).toBe(false);
    expect(isNewer("7.0.0", "7.88.0")).toBe(false);
  });
  it("never nudges on unparseable input", () => {
    expect(isNewer("unknown", "7.88.0")).toBe(false);
    expect(isNewer("7.89.0", "unknown")).toBe(false);
    expect(isNewer("7.89.0-beta.1", "7.88.0")).toBe(false);
  });
});

describe("shouldSkipUpdateCheck", () => {
  it("skips when opted out via env", () => {
    process.env["LOKI_NO_UPDATE_CHECK"] = "1";
    expect(shouldSkipUpdateCheck()).toBe(true);
  });
  it("skips in CI", () => {
    process.env["CI"] = "true";
    expect(shouldSkipUpdateCheck()).toBe(true);
  });
  it("skips in non-TTY (the test runner itself is non-TTY)", () => {
    // bun test runs with stdout piped, so isTTY is undefined/false here.
    expect(process.stdout.isTTY).toBeFalsy();
    expect(shouldSkipUpdateCheck()).toBe(true);
  });
});

describe("resolveLatest caching", () => {
  it("caches the result so a second call does not hit the fetcher again", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return "7.99.0";
    };
    const t0 = 1_000_000;
    const first = await resolveLatest(t0, fetcher, cacheFile);
    expect(first).toBe("7.99.0");
    expect(calls).toBe(1);
    expect(existsSync(cacheFile)).toBe(true);

    // Within 24h: served from cache, fetcher untouched.
    const second = await resolveLatest(t0 + 60_000, fetcher, cacheFile);
    expect(second).toBe("7.99.0");
    expect(calls).toBe(1);
  });

  it("re-fetches after the 24h TTL expires", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return calls === 1 ? "7.99.0" : "8.0.0";
    };
    const t0 = 2_000_000;
    await resolveLatest(t0, fetcher, cacheFile);
    expect(calls).toBe(1);
    const dayMs = 24 * 60 * 60 * 1000;
    const later = await resolveLatest(t0 + dayMs + 1, fetcher, cacheFile);
    expect(later).toBe("8.0.0");
    expect(calls).toBe(2);
  });

  it("returns null and writes no cache when the fetcher fails (offline)", async () => {
    const fetcher = async () => null;
    const got = await resolveLatest(3_000_000, fetcher, cacheFile);
    expect(got).toBeNull();
    expect(existsSync(cacheFile)).toBe(false);
  });
});

describe("maybePrintUpdateHint", () => {
  it("prints exactly one honest line when a newer version exists", async () => {
    const lines: string[] = [];
    await withTTY(true, async () => {
      await maybePrintUpdateHint("7.88.0", {
        now: 10_000_000,
        fetcher: async () => "7.99.0",
        write: (m) => lines.push(m),
        cacheFile,
      });
    });
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("A newer Loki Mode is available: 7.99.0 (you have 7.88.0)");
    expect(lines[0]).toContain("bun install -g loki-mode");
    expect(lines[0]!.endsWith("\n")).toBe(true);
  });

  it("prints nothing when already on the latest version", async () => {
    const lines: string[] = [];
    await withTTY(true, async () => {
      await maybePrintUpdateHint("7.99.0", {
        now: 11_000_000,
        fetcher: async () => "7.99.0",
        write: (m) => lines.push(m),
        cacheFile,
      });
    });
    expect(lines.length).toBe(0);
  });

  it("prints nothing when opted out, even with a newer version", async () => {
    process.env["LOKI_NO_UPDATE_CHECK"] = "1";
    const lines: string[] = [];
    await withTTY(true, async () => {
      await maybePrintUpdateHint("7.88.0", {
        now: 12_000_000,
        fetcher: async () => "7.99.0",
        write: (m) => lines.push(m),
        cacheFile,
      });
    });
    expect(lines.length).toBe(0);
  });

  it("prints nothing in non-TTY (the default test-runner context)", async () => {
    const lines: string[] = [];
    await maybePrintUpdateHint("7.88.0", {
      now: 13_000_000,
      fetcher: async () => "7.99.0",
      write: (m) => lines.push(m),
      cacheFile,
    });
    expect(lines.length).toBe(0);
  });

  it("never nudges when the running version is unknown", async () => {
    const lines: string[] = [];
    await withTTY(true, async () => {
      await maybePrintUpdateHint("unknown", {
        now: 14_000_000,
        fetcher: async () => "7.99.0",
        write: (m) => lines.push(m),
        cacheFile,
      });
    });
    expect(lines.length).toBe(0);
  });
});
