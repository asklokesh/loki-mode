// FC-TEST-TIMEOUT-OVERRIDES-CLI: the load-aware scaler in tests/preload.ts, and a guard that no test file sets its own
// fixed default timeout (a file-level literal beats the --timeout flag and ignores load).
import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { defaultTimeoutMs, loadAwareTimeoutMs } from "../preload.ts";

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

describe("defaultTimeoutMs (FC-SUBPROCESS-TEST-DEFAULT-TIMEOUT)", () => {
  const at = (load1: number) => defaultTimeoutMs({ load1, cpuCount: 14 });
  it("keeps bun's 5s at or below the load cap (2 x cpus) and scales above it", () => {
    expect(at(0)).toBe(5000);
    expect(at(28)).toBe(5000);
    expect(at(28.5)).toBe(25_000);
    expect(at(10_000)).toBe(50_000);
  });
});

describe("setSpawnTimeout applies the default to the calling file", () => {
  // The child imports setSpawnTimeout. Scale 0.02 makes the default 100ms; a 500ms sleep must time out, and the floor lifts it.
  const dir = mkdtempSync(join(tmpdir(), "loki-tmo-def-"));
  const file = join(dir, "a.test.ts");
  const preload = join(import.meta.dir, "..", "preload.ts");
  writeFileSync(file, `import { it } from "bun:test";\nimport { setSpawnTimeout } from ${JSON.stringify(preload)};\nsetSpawnTimeout();\nit("sleeps", async () => { await new Promise((r) => setTimeout(r, 500)); });\n`);
  const run = (env: Record<string, string>) => spawnSync(process.execPath, ["test", file], { env: { ...process.env, ...env }, encoding: "utf8", timeout: 60_000 });
  it("a scaled-down default fails a spawning-length test; the floor lifts it", () => {
    const failed = run({ LOKI_TEST_TIMEOUT_SCALE: "0.02", LOKI_TEST_TIMEOUT_MS: "" });
    expect(failed.status).not.toBe(0);
    expect(failed.stderr + failed.stdout).toMatch(/timed out after/);
    expect(run({ LOKI_TEST_TIMEOUT_SCALE: "0.02", LOKI_TEST_TIMEOUT_MS: "5000" }).status).toBe(0);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
});

// FC-SUBPROCESS-TEST-DEFAULT-TIMEOUT: a test file that spawns subprocesses must call a load-aware setter, because bun's
// fixed 5s default flakes under load and a preload default reaches only the first file of a run (measured, bun 1.3.13).
const SPAWNS = /Bun\.spawn|spawnSync|execFileSync|execSync|child_process/;
const SETS_TIMEOUT = /\b(setSpawnTimeout|setLoadAwareTimeout)\(/;
type TestFile = { path: string; text: string; imports: string[] };
/** A test file spawns when its own text does or when it imports a src module whose text does (helpers such as util/shell.ts). */
export const untimedSpawners = (files: TestFile[], spawnSrc: Set<string>): string[] =>
  files.filter((f) => (SPAWNS.test(f.text) || f.imports.some((i) => spawnSrc.has(i))) && !SETS_TIMEOUT.test(f.text)).map((f) => f.path);

describe("every spawning test file sets a load-aware timeout", () => {
  const root = join(import.meta.dir, "..");
  const srcRoot = join(root, "..", "src");
  const walkTs = (d: string, keep: (n: string) => boolean): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = join(d, e.name);
    return e.isDirectory() ? (e.name === "node_modules" || e.name === "fixtures" ? [] : walkTs(p, keep)) : keep(e.name) ? [p] : [];
  });
  const spawnSrc = new Set(walkTs(srcRoot, (n) => n.endsWith(".ts")).filter((p) => SPAWNS.test(readFileSync(p, "utf8"))));
  // Resolves a relative import specifier to the absolute .ts path it names (".js" specifiers map to ".ts"), or null.
  const resolveImport = (from: string, spec: string): string | null => {
    if (!spec.startsWith(".")) return null;
    const base = resolve(dirname(from), spec.replace(/\.js$/, ""));
    return [`${base}.ts`, join(base, "index.ts"), base].find((c) => c.endsWith(".ts") && existsSync(c)) ?? null;
  };
  const importsOf = (p: string, text: string): string[] =>
    [...text.matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)].map((m) => resolveImport(p, m[1]!)).filter((x): x is string => x !== null);
  const files: TestFile[] = walkTs(root, (n) => n.endsWith(".test.ts"))
    .filter((p) => !p.endsWith("test_timeout_guard.test.ts"))
    .map((p) => { const text = readFileSync(p, "utf8"); return { path: relative(root, p), text, imports: importsOf(p, text) }; });
  it("no spawning file, direct or through a src helper, is left on bun's fixed default", () => {
    expect(spawnSrc.size).toBeGreaterThan(0);
    expect(untimedSpawners(files, spawnSrc)).toEqual([]);
  });
  it("mutant: removing the call from a helper-spawning file is caught and named", () => {
    const victim = files.find((f) => f.path === join("util", "shell.test.ts"));
    expect(victim).toBeDefined();
    expect(victim!.imports.some((i) => spawnSrc.has(i))).toBe(true);
    const mutated = files.map((f) => (f === victim ? { ...f, text: f.text.replace("setSpawnTimeout();", "") } : f));
    expect(untimedSpawners(mutated, spawnSrc)).toEqual([victim!.path]);
  });
  it("mutant: removing the call from a text-spawning file is caught", () => {
    const victim = files.find((f) => SPAWNS.test(f.text) && f.text.includes("setSpawnTimeout();"));
    expect(victim).toBeDefined();
    const mutated = files.map((f) => (f === victim ? { ...f, text: f.text.replace("setSpawnTimeout();", "") } : f));
    expect(untimedSpawners(mutated, spawnSrc)).toEqual([victim!.path]);
  });
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
