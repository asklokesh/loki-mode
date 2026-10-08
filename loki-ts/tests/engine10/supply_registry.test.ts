import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classify, supplyGuard, type DeclaredDep, type Resolver } from "../../src/supply/supply_guard.ts";

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
  test("B2: a private-registry dep the resolver calls missing is NOT PROVEN, not FAILED", async () => {
    const priv: DeclaredDep = { ecosystem: "cargo", name: "internal-crate", version_spec: "1", registry: "https://crates.corp.example/index" };
    const r = await go([priv], missing);
    expect(r.blocked).toBe(false);
    expect(r.notProven.join("\n")).toContain("NOT PROVEN");
    expect(r.block!.entries[0]!.status).toBe("unreachable");
    const pub = await go([{ ...priv, registry: "https://index.crates.io/" }], missing);
    expect(pub.blocked).toBe(true);
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
