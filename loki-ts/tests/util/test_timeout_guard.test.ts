// FC-TEST-TIMEOUT-OVERRIDES-CLI: the load-aware scaler in tests/preload.ts, and a guard that no test file sets its own
// fixed default timeout (a file-level literal beats the --timeout flag and ignores load).
import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { loadAwareTimeoutMs, setLoadAwareTimeout } from "../preload.ts";

setLoadAwareTimeout(60_000); // the scale test spawns two child bun runs of 6s+ each

describe("loadAwareTimeoutMs", () => {
  const at = (load1: number, scale?: string, floorMs?: string) =>
    loadAwareTimeoutMs(30_000, { load1, cpuCount: 14, ...(scale ? { scale } : {}), ...(floorMs ? { floorMs } : {}) });
  it("an idle machine keeps the base", () => {
    expect(at(0)).toBe(30_000);
    expect(at(6)).toBe(30_000);
  });
  it("scales with load per cpu: 2x oversubscribed is 4x, and the factor is capped at 10x", () => {
    expect(at(28)).toBe(120_000);
    expect(at(10_000)).toBe(300_000);
  });
  it("LOKI_TEST_TIMEOUT_SCALE replaces the load factor, is capped at 10; junk is ignored", () => {
    expect(at(28, "1")).toBe(30_000);
    expect(at(0, "3")).toBe(90_000);
    expect(at(0, "500")).toBe(300_000);
    expect(at(28, "abc")).toBe(120_000);
  });
  it("LOKI_TEST_TIMEOUT_MS is a floor: it wins when larger and never lowers the scaled base", () => {
    expect(at(0, undefined, "120000")).toBe(120_000);
    expect(at(28, undefined, "1000")).toBe(120_000);
  });
});

describe("the real setLoadAwareTimeout path under bun test", () => {
  // A child bun test file sets setLoadAwareTimeout(100) then sleeps 500ms. No injected argv: the real preload export.
  const dir = mkdtempSync(join(tmpdir(), "loki-tmo-"));
  const preload = join(import.meta.dir, "..", "preload.ts");
  const file = join(dir, "child.test.ts");
  const run = (env: Record<string, string>, sleepMs: number) => {
    writeFileSync(file, `import { it } from "bun:test";\nimport { setLoadAwareTimeout } from ${JSON.stringify(preload)};\nsetLoadAwareTimeout(100);\nit("sleeps", async () => { await new Promise((r) => setTimeout(r, ${sleepMs})); });\n`);
    return spawnSync(process.execPath, ["test", file], { env: { ...process.env, ...env }, encoding: "utf8", timeout: 60_000 });
  };
  const base = { LOKI_TEST_TIMEOUT_SCALE: "1" };
  it("the env floor lets a slow test pass; without it, a 500ms sleep under a 100ms budget fails", () => {
    expect(run({ ...base, LOKI_TEST_TIMEOUT_MS: "5000" }, 500).status).toBe(0);
    expect(run({ ...base, LOKI_TEST_TIMEOUT_MS: "" }, 500).status).not.toBe(0);
  });
  it("a real hang still times out with the floor set", () => {
    expect(run({ ...base, LOKI_TEST_TIMEOUT_MS: "300" }, 5000).status).not.toBe(0);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
});

describe("the preload applies a load-aware global default", () => {
  // A child test file with NO opt-in sleeps 6s. The 5000ms default scaled by 3 passes; unscaled it fails.
  const dir = mkdtempSync(join(tmpdir(), "loki-tmo-"));
  const file = join(dir, "child.test.ts");
  const cwd = join(import.meta.dir, "..", "..");
  const run = (scale: string) => {
    writeFileSync(file, `import { it } from "bun:test";\nit("sleeps 6s", async () => { await new Promise((r) => setTimeout(r, 6000)); });\n`);
    return spawnSync(process.execPath, ["test", file], { cwd, env: { ...process.env, LOKI_TEST_TIMEOUT_SCALE: scale, LOKI_TEST_TIMEOUT_MS: "" }, encoding: "utf8", timeout: 60_000 });
  };
  it("a 6s test passes at scale 3 and fails at scale 1", () => {
    expect(run("3").status).toBe(0);
    expect(run("1").status).not.toBe(0);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
});

describe("no test sets its own fixed default timeout", () => {
  const root = join(import.meta.dir, "..");
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules") return [];
    const p = join(d, e.name);
    return e.isDirectory() ? walk(p) : /\.ts$/.test(e.name) ? [p] : [];
  });
  it("only tests/preload.ts calls setDefaultTimeout; every file uses setLoadAwareTimeout", () => {
    const offenders = walk(root)
      .filter((f) => relative(root, f) !== "preload.ts" && f !== import.meta.path)
      .filter((f) => /\bsetDefaultTimeout\s*\(/.test(readFileSync(f, "utf8")))
      .map((f) => relative(root, f));
    expect(offenders).toEqual([]);
  });
});
