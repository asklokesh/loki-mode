import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import {
  findShadowedNewerInstall,
  isNewer,
  maybePrintWhatsNew,
  maybePrintUpdateHint,
  resolveLatest,
  shouldSkipUpdateCheck,
} from "../../src/util/update_check.ts";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";

// Each test injects its own throwaway cache file so nothing touches the real
// ~/.loki (note: os.homedir() ignores a mutated $HOME on macOS, so stubbing
// env is not enough; the cache path is injectable instead).
let prevNoCheck: string | undefined;
let prevCI: string | undefined;
let prevPath: string | undefined;
let tmpDir: string;
let cacheFile: string;

beforeEach(() => {
  prevNoCheck = process.env["LOKI_NO_UPDATE_CHECK"];
  prevCI = process.env["CI"];
  prevPath = process.env["PATH"];
  delete process.env["LOKI_NO_UPDATE_CHECK"];
  delete process.env["CI"];
  // ISOLATE FROM THE HOST PATH. The shadowed-install check walks PATH looking
  // for other loki installs, and this developer machine genuinely has one -- so
  // without this, an unrelated test that never mentions PATH started failing
  // because it found the real shadow. A test must not read host state it did
  // not ask for; tests that exercise the check inject their own PATH.
  process.env["PATH"] = "";
  tmpDir = mkdtempSync(resolve(tmpdir(), "loki-update-test-"));
  cacheFile = resolve(tmpDir, "update-check.json");
});

afterEach(() => {
  if (prevNoCheck === undefined) delete process.env["LOKI_NO_UPDATE_CHECK"];
  else process.env["LOKI_NO_UPDATE_CHECK"] = prevNoCheck;
  if (prevPath === undefined) delete process.env["PATH"];
  else process.env["PATH"] = prevPath;
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

// --- Shadowed install (reported by a user) ------------------------------------
//
// THE BUG: `bun install -g loki-mode` reported "installed loki-mode@9.35.0",
// then `loki --version` printed 9.22.3, and the nudge told the user to run the
// install they had just run. A leftover ~/.local/bin/loki symlink into an old
// npm-global tree was shadowing ~/.bun/bin/loki on PATH. Reinstalling updates a
// copy PATH never reaches, so the advice sent them round a loop with no exit.
describe("shadowed install detection", () => {
  // Build a fake PATH with two package layouts: <dir>/loki -> <pkg>/bin/loki,
  // with <pkg>/package.json carrying the version.
  function makeInstall(root: string, name: string, version: string): string {
    const pkg = resolve(root, name);
    mkdirSync(resolve(pkg, "bin"), { recursive: true });
    writeFileSync(resolve(pkg, "bin", "loki"), "#!/bin/sh\n");
    writeFileSync(resolve(pkg, "package.json"), JSON.stringify({ version }));
    const bindir = resolve(root, name + "-bin");
    mkdirSync(bindir, { recursive: true });
    symlinkSync(resolve(pkg, "bin", "loki"), resolve(bindir, "loki"));
    return bindir;
  }

  it("finds a newer copy that sits later on PATH", () => {
    const oldBin = makeInstall(tmpDir, "old", "9.22.3");
    const newBin = makeInstall(tmpDir, "new", "9.35.0");
    const found = findShadowedNewerInstall("9.22.3", {
      PATH: [oldBin, newBin].join(":"),
    } as NodeJS.ProcessEnv);
    expect(found).not.toBeNull();
    expect(found!.version).toBe("9.35.0");
    expect(found!.path).toBe(resolve(newBin, "loki"));
  });

  it("reports nothing when the running copy is already the newest", () => {
    const oldBin = makeInstall(tmpDir, "o2", "9.22.3");
    const newBin = makeInstall(tmpDir, "n2", "9.35.0");
    expect(
      findShadowedNewerInstall("9.35.0", {
        PATH: [oldBin, newBin].join(":"),
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("is fail-silent on an unreadable or non-package entry", () => {
    const junk = resolve(tmpDir, "junk");
    mkdirSync(junk, { recursive: true });
    writeFileSync(resolve(junk, "loki"), "#!/bin/sh\n"); // no package.json above
    expect(
      findShadowedNewerInstall("9.22.3", { PATH: junk } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("names the shadowing problem instead of telling the user to reinstall", async () => {
    const oldBin = makeInstall(tmpDir, "o3", "9.22.3");
    const newBin = makeInstall(tmpDir, "n3", "9.35.0");
    const lines: string[] = [];
    await withTTY(true, async () => {
      await maybePrintUpdateHint("9.22.3", {
        now: 20_000_000,
        fetcher: async () => "9.35.0",
        write: (m) => lines.push(m),
        cacheFile,
        env: { PATH: [oldBin, newBin].join(":") } as NodeJS.ProcessEnv,
      });
    });
    const msg = lines.join("");
    // The load-bearing assertion: it must NOT repeat the install command, which
    // is the advice that cannot work here.
    expect(msg).not.toContain("bun install -g loki-mode");
    expect(msg).toContain("installed but not the one running");
    expect(msg).toContain("which -a loki");
    expect(msg).toContain(resolve(newBin, "loki"));
  });

  it("still gives the ordinary update hint when nothing is shadowed", async () => {
    const onlyBin = makeInstall(tmpDir, "solo", "9.22.3");
    const lines: string[] = [];
    await withTTY(true, async () => {
      await maybePrintUpdateHint("9.22.3", {
        now: 21_000_000,
        fetcher: async () => "9.35.0",
        write: (m) => lines.push(m),
        cacheFile,
        env: { PATH: onlyBin } as NodeJS.ProcessEnv,
      });
    });
    expect(lines.join("")).toContain("bun install -g loki-mode");
  });
});

// The shadow check must NOT depend on the registry.
//
// THE FIELD REPORT, twice: `bun install -g loki-mode` says "installed
// loki-mode@9.39.0", `loki --version` prints 9.22.3, and the nudge advises
// installing 9.35.0. Three different numbers, and the advice cannot work
// because the newer copy is ALREADY on disk -- every reinstall updates the copy
// that is not winning on PATH.
//
// Cause: the shadow check sat INSIDE the "a newer release exists" branch, so it
// was gated on a registry lookup and on a <=24h cache. Shadowing is a local,
// on-disk condition; nothing about the registry should gate reporting it.
describe("shadow check is independent of the registry", () => {
  const origTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  beforeEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  });
  afterEach(() => {
    if (origTTY) Object.defineProperty(process.stdout, "isTTY", origTTY);
  });

  function mkInstalls(root: string, specs: Array<[string, string]>): string {
    for (const [dir, ver] of specs) {
      mkdirSync(`${root}/${dir}/loki-mode/bin`, { recursive: true });
      writeFileSync(`${root}/${dir}/loki-mode/package.json`, JSON.stringify({ version: ver }));
      writeFileSync(`${root}/${dir}/loki-mode/bin/loki`, "#!/bin/sh\n");
      mkdirSync(`${root}/${dir}/bin`, { recursive: true });
      try { symlinkSync(`${root}/${dir}/loki-mode/bin/loki`, `${root}/${dir}/bin/loki`); } catch {}
    }
    return specs.map(([d]) => `${root}/${d}/bin`).join(":");
  }

  it("a shadowed install is reported even when the registry is unreachable", async () => {
    const root = mkdtempSync(join(tmpdir(), "loki-shadow-reg-"));
    const PATH = mkInstalls(root, [["stale", "9.22.3"], ["fresh", "9.39.0"]]);
    let out = "";
    await maybePrintUpdateHint("9.22.3", {
      env: { PATH } as NodeJS.ProcessEnv,
      fetcher: async () => null, // registry down
      cacheFile: join(root, "cache.json"),
      write: (m) => { out += m; },
    });
    // Before the fix this printed NOTHING: no registry result meant no branch.
    expect(out).toContain("is installed but not the one running");
    expect(out).toContain("9.39.0");
  });

  it("a stale cache does not produce advice that cannot work", async () => {
    const root = mkdtempSync(join(tmpdir(), "loki-shadow-stale-"));
    const PATH = mkInstalls(root, [["stale", "9.22.3"], ["fresh", "9.39.0"]]);
    let out = "";
    await maybePrintUpdateHint("9.22.3", {
      env: { PATH } as NodeJS.ProcessEnv,
      fetcher: async () => "9.35.0", // the exact stale value from the field report
      cacheFile: join(root, "cache.json"),
      write: (m) => { out += m; },
    });
    expect(out).toContain("is installed but not the one running");
    // must NOT tell them to reinstall; that is the advice that loops forever
    expect(out).not.toContain("Update: bun install -g loki-mode");
  });

  it("with no shadow the ordinary nudge is unchanged", async () => {
    const root = mkdtempSync(join(tmpdir(), "loki-shadow-none-"));
    const PATH = mkInstalls(root, [["only", "9.22.3"]]);
    let out = "";
    await maybePrintUpdateHint("9.22.3", {
      env: { PATH } as NodeJS.ProcessEnv,
      fetcher: async () => "9.41.0",
      cacheFile: join(root, "cache.json"),
      write: (m) => { out += m; },
    });
    expect(out).toContain("A newer Loki Mode is available: 9.41.0");
  });
});

describe("maybePrintWhatsNew", () => {
  const seenFile = () => resolve(tmpDir, "last-seen-version.json");
  const run = (cur: string, out: string[]) =>
    maybePrintWhatsNew(cur, { write: (m) => out.push(m), seenFile: seenFile() });

  it("first run records silently, an upgrade prints one line once", async () => {
    await withTTY(true, async () => {
      const out: string[] = [];
      expect(run("1.0.0", out)).toBe(false);
      expect(run("1.0.0", out)).toBe(false);
      expect(run("1.1.0", out)).toBe(true);
      expect(run("1.1.0", out)).toBe(false);
      expect(out.length).toBe(1);
      expect(out[0]).toContain("1.0.0 -> 1.1.0");
      expect(out[0]!.trimEnd().includes("\n")).toBe(false);
    });
  });

  it("silent in opt-out, CI and non-TTY modes and does not record", async () => {
    const out: string[] = [];
    await withTTY(true, async () => { run("1.0.0", out); });
    process.env["LOKI_NO_UPDATE_CHECK"] = "1";
    await withTTY(true, async () => { expect(run("1.1.0", out)).toBe(false); });
    delete process.env["LOKI_NO_UPDATE_CHECK"];
    process.env["CI"] = "1";
    await withTTY(true, async () => { expect(run("1.1.0", out)).toBe(false); });
    delete process.env["CI"];
    await withTTY(false, async () => { expect(run("1.1.0", out)).toBe(false); });
    expect(out.length).toBe(0);
    await withTTY(true, async () => { expect(run("1.1.0", out)).toBe(true); });
  });

  it("boundaries: downgrade, unknown version, corrupt record", async () => {
    await withTTY(true, async () => {
      const out: string[] = [];
      run("2.0.0", out);
      expect(run("1.9.0", out)).toBe(false);
      expect(run("unknown", out)).toBe(false);
      writeFileSync(seenFile(), "not json");
      expect(run("2.1.0", out)).toBe(false);
      expect(out.length).toBe(0);
    });
  });

  it("maybePrintUpdateHint entry point emits the notice once", async () => {
    await withTTY(true, async () => {
      const out: string[] = [];
      const o = { write: (m: string) => out.push(m), cacheFile, env: { PATH: "" } as NodeJS.ProcessEnv, fetcher: async () => null };
      await maybePrintUpdateHint("3.0.0", o);
      await maybePrintUpdateHint("3.1.0", o);
      await maybePrintUpdateHint("3.1.0", o);
      expect(out.filter((m) => m.includes("upgraded")).length).toBe(1);
    });
  });
});
