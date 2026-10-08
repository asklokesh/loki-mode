import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { implementStage } from "../../src/engine10/stages/implement.ts";
import type { RunContext } from "../../src/engine10/types.ts";
import { classify, readDeclared, supplyGuard, type DeclaredDep, type Resolver } from "../../src/supply/supply_guard.ts";

const missing: Resolver = async () => ({ status: "missing" });
const go = (d: DeclaredDep[], r: Resolver, env: NodeJS.ProcessEnv = {}) =>
  supplyGuard("/nonexistent-repo", ["go.mod"], { deps: d, problem: null }, env, { resolver: r, now: Date.now() });

describe("supply guard registry fidelity (HIGH review B1, B2, N8, N9)", () => {
  test("B1: the pip resolver asks for pre-releases and ignores the local python", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/supply/supply_guard.ts"), "utf8");
    expect(src).toContain('"--pre", "--ignore-requires-python"');
    expect(classify("pypi", "fastmcp", 0, "fastmcp (4.0.11)\nAvailable versions: 4.0.11, 3.0.0", "")).toEqual({ status: "exists" });
    expect(classify("pypi", "nope-zz", 1, "", "ERROR: No matching distribution found for nope-zz")).toEqual({ status: "missing" });
  });
  test("B2: the model's declared registry text never moves the verdict (no user config: FAILED)", async () => {
    const priv: DeclaredDep = { ecosystem: "cargo", name: "internal-crate", version_spec: "1", registry: "https://crates.corp.example/index" };
    const r = await go([priv], missing);
    expect(r.blocked).toBe(true);
  });
  test("N9: cargo name match ignores - versus _", () => {
    expect(classify("cargo", "my_crate", 0, 'my-crate = "1.0.0"    # x', "")).toEqual({ status: "exists" });
    expect(classify("cargo", "my_crate", 0, 'other = "1.0.0"', "")).toEqual({ status: "missing" });
  });
  test("N8: a go module matching GOPRIVATE or GONOPROXY is NOT PROVEN when missing", async () => {
    const d: DeclaredDep = { ecosystem: "go", name: "corp.example/team/lib", version_spec: "v1", registry: "default" };
    expect((await go([d], missing, { GOPRIVATE: "corp.example/*" })).blocked).toBe(false);
    expect((await go([d], missing, { GONOPROXY: "corp.example" })).blocked).toBe(false);
    expect((await go([d], missing, { GOPRIVATE: "other.example" })).blocked).toBe(true);
  });
});

describe("B4: only the user's own config can make a missing package NOT PROVEN", () => {
  const vals = ["registry.npmjs.org", "pypi.org", "npmjs.com", "https://www.npmjs.com", "proxy.golang.org", "public", "npm registry", "https://npm.corp.example/made-up"];
  test("any model-written registry string on the default registry is FAILED when there is no user config", async () => {
    for (const registry of vals) {
      const r = await go([{ ecosystem: "npm", name: "ghost-pkg", version_spec: "1", registry }], missing);
      expect({ registry, blocked: r.blocked }).toEqual({ registry, blocked: true });
    }
  });
  const withHome = async (write: (home: string) => void, d: DeclaredDep, env: NodeJS.ProcessEnv = {}) => {
    const home = mkdtempSync(join(tmpdir(), "supply-home-"));
    try { write(home); return await go([d], missing, { ...env, HOME: home }); } finally { rmSync(home, { recursive: true, force: true }); }
  };
  test("a user .npmrc pointing at a private registry gives NOT PROVEN; one pointing at the public registry does not", async () => {
    const d: DeclaredDep = { ecosystem: "npm", name: "ghost-pkg", version_spec: "1", registry: "default" };
    const priv = await withHome((h) => writeFileSync(join(h, ".npmrc"), "@corp:registry=https://npm.corp.example/\n"), d);
    expect(priv.blocked).toBe(true);
    const scoped = await withHome((h) => writeFileSync(join(h, ".npmrc"), "@corp:registry=https://npm.corp.example/\n"), { ...d, name: "@corp/ghost" });
    expect(scoped.blocked).toBe(false);
    expect(scoped.block!.entries[0]!.status).toBe("unreachable");
    const global = await withHome((h) => writeFileSync(join(h, ".npmrc"), "registry=https://npm.corp.example/\n"), d);
    expect(global.blocked).toBe(false);
    const pub = await withHome((h) => writeFileSync(join(h, ".npmrc"), "registry=https://registry.npmjs.org/\n"), d);
    expect(pub.blocked).toBe(true);
  });
  test("PIP_INDEX_URL and pip.conf to a private index give NOT PROVEN", async () => {
    const d: DeclaredDep = { ecosystem: "pypi", name: "ghost-pkg", version_spec: "1", registry: "default" };
    expect((await go([d], missing, { PIP_INDEX_URL: "https://pypi.corp.example/simple" })).blocked).toBe(false);
    const viaConf = await withHome((h) => { mkdirSync(join(h, ".config", "pip"), { recursive: true }); writeFileSync(join(h, ".config", "pip", "pip.conf"), "[global]\nindex-url = https://pypi.corp.example/simple\n"); }, d);
    expect(viaConf.blocked).toBe(false);
  });
  test("a private GOPROXY from go env (go env -w) gives NOT PROVEN", async () => {
    const d: DeclaredDep = { ecosystem: "go", name: "example.org/x/ghost", version_spec: "v1", registry: "default" };
    const r = await supplyGuard("/nonexistent-repo", ["go.mod"], { deps: [d], problem: null }, {}, { resolver: missing, now: Date.now(), goEnv: { GOPROXY: "https://goproxy.corp.example,direct" } });
    expect(r.blocked).toBe(false);
  });
  test("a cargo registries table in the user's config gives NOT PROVEN", async () => {
    const d: DeclaredDep = { ecosystem: "cargo", name: "ghost-crate", version_spec: "1", registry: "default" };
    const r = await withHome((h) => { mkdirSync(join(h, ".cargo"), { recursive: true }); writeFileSync(join(h, ".cargo", "config.toml"), '[registries.corp]\nindex = "sparse+https://crates.corp.example/"\n'); }, d);
    expect(r.blocked).toBe(false);
  });
});

describe("B3: a stale declaration never judges a later run", () => {
  const doneResult = { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 1, killed: false };
  const mkCtx = (repo: string, onRun: () => void): RunContext => ({
    runId: "e10-b3", repoDir: repo, runDir: join(repo, ".loki", "runs", "e10-b3"), baseSha: "deadbeef", branch: "loki/e10-b3",
    provider: "claude", model: "claude-test", deep: false, capS: 900, emit: () => {},
    sessions: { async run() { onRun(); return doneResult; } },
    tests: { async detect() { return { runners: [], tests: [] }; }, impacted() { return []; } },
    cost: { read() { return { usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }; } },
    clock: { now: () => 0 },
    outputs: () => ({ intake: { task: "t", impacted_tests: [] } }),
  } as unknown as RunContext);
  test("run 1 declares a ghost and FAILS; run 2 removes it and is not blocked", async () => {
    const repo = mkdtempSync(join(tmpdir(), "supply-b3-"));
    mkdirSync(join(repo, ".loki"), { recursive: true });
    const decl = join(repo, ".loki", "supply-declared.json");
    try {
      await implementStage.run(mkCtx(repo, () => writeFileSync(decl, JSON.stringify([{ ecosystem: "npm", name: "ghost-pkg", version_spec: "1", registry: "default" }]))), new AbortController().signal);
      const r1 = await supplyGuard(repo, ["package.json"], readDeclared(repo), {}, { resolver: missing, now: Date.now() });
      expect(r1.blocked).toBe(true);
      await implementStage.run(mkCtx(repo, () => {}), new AbortController().signal);
      expect(existsSync(decl)).toBe(false);
      const r2 = await supplyGuard(repo, ["package.json"], readDeclared(repo), {}, { resolver: missing, now: Date.now() });
      expect(r2.blocked).toBe(false);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});
