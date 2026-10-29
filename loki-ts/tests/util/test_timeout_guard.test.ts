// FC-TEST-TIMEOUT-OVERRIDES-CLI: the load-aware scaler in tests/preload.ts, and a guard that no test file sets its own
// fixed default timeout (a file-level literal beats the --timeout flag and ignores load).
import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { loadAwareTimeoutMs, setLoadAwareTimeout } from "../preload.ts";

setLoadAwareTimeout(60_000); // the scale test spawns two child bun runs of three 6s files each

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

describe("the test script gives every file of a multi-file run the scaled default", () => {
  // Three child files with NO opt-in each sleep 6s, run in ONE `bun run test` process (the package script owns the default).
  // A preload-time setDefaultTimeout reached only one of them; the script's --timeout reaches all three.
  const dir = mkdtempSync(join(tmpdir(), "loki-tmo-"));
  const files =[1, 2, 3].map((i) => join(dir, `child${i}.test.ts`));
  const cwd = join(import.meta.dir, "..", "..");
  const run = (scale: string) => {
    for (const f of files) writeFileSync(f, `import { it } from "bun:test";\nit("sleeps 6s", async () => { await new Promise((r) => setTimeout(r, 6000)); });\n`);
    return spawnSync(process.execPath, ["run", "test", ...files], { cwd, env: { ...process.env, LOKI_TEST_TIMEOUT_SCALE: scale, LOKI_TEST_TIMEOUT_MS: "" }, encoding: "utf8", timeout: 90_000 });
  };
  it("all three 6s tests pass at scale 3 and all three fail at scale 1", () => {
    const ok = run("3");
    expect(ok.status).toBe(0);
    expect(`${ok.stdout}${ok.stderr}`).toMatch(/\b3 pass/);
    const bad = run("1");
    expect(bad.status).not.toBe(0);
    expect(`${bad.stdout}${bad.stderr}`).toMatch(/\b3 fail/);
  });
  it("a zero or non-numeric scale falls back to 3 and a 20s hang still times out", () => {
    for (const f of files) writeFileSync(f, `import { it } from "bun:test";\nit("hangs 20s", async () => { await new Promise((r) => setTimeout(r, 20000)); });\n`);
    for (const scale of ["0", "abc"]) {
      const r = spawnSync(process.execPath, ["run", "test", files[0]!], { cwd, env: { ...process.env, LOKI_TEST_TIMEOUT_SCALE: scale, LOKI_TEST_TIMEOUT_MS: "" }, encoding: "utf8", timeout: 60_000 });
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toMatch(/timed out after 15000ms/);
    }
  });
  it("the script clamps the scale to 1..10 by string pattern, so an overflowing value never reaches the arithmetic", () => {
    const script = (JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { scripts: { test: string } }).scripts.test;
    // The substitution must really happen: if the script text is renamed or reformatted, replace() is a silent no-op and the
    // spawn below would run the real suite once per case. Fail before any spawn, and bound every spawn.
    const echoed = script.replace("bash ../scripts/test-slot.sh --full-only -- bun test --timeout", "echo");
    expect(echoed).not.toBe(script);
    expect(echoed).toContain("echo");
    expect(echoed).not.toContain("bun test");
    const resolved = (shell: string, scale?: string) => {
      const env: Record<string, string | undefined> = { ...process.env, LOKI_TEST_TIMEOUT_SCALE: scale };
      if (scale === undefined) delete env["LOKI_TEST_TIMEOUT_SCALE"];
      return spawnSync(shell, ["-c", echoed], { env: env as NodeJS.ProcessEnv, encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" }).stdout.trim();
    };
    const cases: Array<[string | undefined, string]> = [
      [undefined, "15000"], ["", "15000"], ["abc", "15000"], ["0", "15000"], ["05", "15000"], ["-2", "15000"],
      ["1", "5000"], ["3", "15000"], ["9", "45000"], ["10", "50000"], ["11", "50000"], ["99", "50000"],
      ["100", "50000"], ["99999999", "50000"], ["3689348814741910", "50000"], ["18446744073709551616", "50000"],
    ];
    for (const shell of ["/bin/sh", "/bin/bash"]) for (const [scale, ms] of cases) expect(`${shell} ${scale}: ${resolved(shell, scale)}`).toBe(`${shell} ${scale}: ${ms}`);
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
