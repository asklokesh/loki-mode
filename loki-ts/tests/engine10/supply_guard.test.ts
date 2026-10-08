// T10 v2: the model declares new registry deps, the harness proves them with a (stubbed) ecosystem resolver.
// No network, no real npm/pip/cargo, and no manifest parsing in the harness (FC-34).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildImplementBrief } from "../../src/engine10/stages/implement.ts";
import { FIXED_RULES } from "../../src/e10ext/context.ts";
import { classify, readDeclared, supplyGuard, supplyVerdict, type DeclaredDep, type Resolver } from "../../src/supply/supply_guard.ts";

const NOW = Date.parse("2026-10-08T00:00:00Z");
const ago = (n: number): number => NOW - n * 86400000;
let root = "";
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "supply-v2-")); mkdirSync(join(root, ".loki")); });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const dep = (name: string, ecosystem = "npm"): DeclaredDep => ({ ecosystem, name, version_spec: "^1", registry: "default" });
const known = (m: Record<string, number | "missing" | "unproven">): Resolver => async (d) => {
  const v = m[d.name];
  if (v === undefined || v === "missing") return { status: "missing" };
  if (v === "unproven") return { status: "unproven" };
  return { status: "exists", firstPublish: ago(v) };
};
const go = (declared: DeclaredDep[], resolver: Resolver, files = ["package.json"], env: NodeJS.ProcessEnv = {}, problem: string | null = null) =>
  supplyGuard(root, files, { deps: declared, problem }, env, { resolver, now: NOW });

describe("supply guard v2", () => {
  test("an existing old package is ok", async () => {
    const r = await go([dep("old")], known({ old: 400 }));
    expect(r.blocked).toBe(false);
    expect(r.block!.entries[0]).toMatchObject({ name: "old", status: "ok", age_days: 400 });
  });

  test("a declared package that does not resolve is FAILED and blocks VERIFIED", async () => {
    const r = await go([dep("old"), dep("ghost")], known({ old: 400 }));
    expect(r.blocked).toBe(true);
    expect(supplyVerdict("VERIFIED" as string, r)).toBe("FAILED");
    expect(r.notProven.join("\n")).toContain("FAILED: declared dependency npm:ghost");
  });

  test("a 2-day-old package only warns: VERIFIED stays VERIFIED with the warning on the receipt", async () => {
    const r = await go([dep("fresh")], known({ fresh: 2 }));
    expect(r.blocked).toBe(false);
    expect(supplyVerdict("VERIFIED" as string, r)).toBe("VERIFIED");
    expect(r.notProven.join("\n")).toContain("supply guard WARNING: npm:fresh");
  });

  test("LOKI_SUPPLY_MIN_AGE_DAYS opts in to a hard fail on age", async () => {
    const r = await go([dep("young")], known({ young: 20 }), ["package.json"], { LOKI_SUPPLY_MIN_AGE_DAYS: "30" });
    expect(r.blocked).toBe(true);
    expect(r.notProven.join("\n")).toContain("FAILED: npm:young");
  });

  test("allowlist accepts a name without calling the resolver", async () => {
    writeFileSync(join(root, ".loki", "supply-allowlist"), "private-lib # internal\n");
    try {
      let calls = 0;
      const r = await go([dep("private-lib")], async () => { calls++; return { status: "missing" }; });
      expect(calls).toBe(0);
      expect(r.blocked).toBe(false);
      expect(r.block!.entries[0]!.status).toBe("allowlisted");
    } finally { rmSync(join(root, ".loki", "supply-allowlist")); }
  });

  test("a resolver that cannot answer (outage, tool absent) is NOT PROVEN, never FAILED", async () => {
    for (const r of [await go([dep("a")], known({ a: "unproven" })), await go([dep("a")], async () => { throw new Error("ENOENT"); })]) {
      expect(r.blocked).toBe(false);
      expect(supplyVerdict("VERIFIED" as string, r)).toBe("VERIFIED");
      expect(r.notProven.join("\n")).toContain("supply guard NOT PROVEN");
      expect(r.notProven.join("\n")).not.toContain("FAILED");
    }
  });

  test("an ecosystem with no resolver is reported as not checked", async () => {
    const r = await go([dep("rails", "gem")], known({}));
    expect(r.blocked).toBe(false);
    expect(r.notProven).toEqual(["supply guard: not checked (ecosystem unsupported in v1): gem:rails"]);
  });

  test("LOKI_SUPPLY_GUARD=0 is inert", async () => {
    let calls = 0;
    const r = await go([dep("ghost")], async () => { calls++; return { status: "missing" }; }, ["package.json"], { LOKI_SUPPLY_GUARD: "0" });
    expect(r).toEqual({ block: null, notProven: [], blocked: false });
    expect(calls).toBe(0);
  });

  test("a diff that touches no dependency file skips the guard", async () => {
    expect(await go([dep("ghost")], known({}), ["src/a.ts"])).toEqual({ block: null, notProven: [], blocked: false });
  });

  test("a manifest changed with nothing declared gives a warning, never FAILED", async () => {
    const r = await go([], known({}), ["package.json", "packages/web/package.json"]);
    expect(r.blocked).toBe(false);
    expect(r.notProven[0]).toContain("dependencies changed");
    expect(r.notProven[0]).toContain("none declared");
    expect(r.notProven.join("\n")).not.toContain("FAILED");
  });

  test("regression R1: a new npm workspace (lockfile gains packages/web) is never probed or FAILED", async () => {
    let calls = 0;
    const r = await go([], async () => { calls++; return { status: "missing" }; }, ["package-lock.json", "package.json", "packages/web/package.json"]);
    expect(calls).toBe(0);
    expect(r.blocked).toBe(false);
  });

  test("regression R2: PEP 508 git/file refs and a poetry path dep are not declared, so never FAILED", async () => {
    let calls = 0;
    const r = await go([], async () => { calls++; return { status: "missing" }; }, ["pyproject.toml", "requirements.txt"]);
    expect(calls).toBe(0);
    expect(r.blocked).toBe(false);
  });

  test("lookups are cached per run", async () => {
    let calls = 0;
    await go([dep("dup"), dep("dup")], async () => { calls++; return { status: "exists", firstPublish: ago(400) }; });
    expect(calls).toBe(1);
  });

  test("past the cap the line says so", async () => {
    const many = Array.from({ length: 52 }, (_, i) => dep(`p${i}`));
    const r = await go(many, known(Object.fromEntries(many.map((d) => [d.name, 400]))));
    expect(r.notProven.filter((l) => l.includes("not checked: cap 50 exceeded")).length).toBe(2);
    expect(r.blocked).toBe(false);
  });

  test("an unreadable declaration is NOT PROVEN, not FAILED", async () => {
    const r = await go([], known({}), ["package.json"], {}, "declaration unreadable");
    expect(r.blocked).toBe(false);
    expect(r.notProven).toEqual(["supply guard NOT PROVEN: declaration unreadable"]);
  });
});

describe("declaration reader", () => {
  test("absent file is empty with no problem", () => { expect(readDeclared(root)).toEqual({ deps: [], problem: null }); });

  test("valid entries are normalized; invalid names, flags and non-objects are dropped", () => {
    writeFileSync(join(root, ".loki", "supply-declared.json"), JSON.stringify([{ ecosystem: "PyPI", name: "requests", version_spec: ">=2", registry: "default" }, { ecosystem: "npm", name: "--evil" }, { ecosystem: "npm", name: "a b" }, 7, { ecosystem: "pip", name: "x".repeat(300) }]));
    expect(readDeclared(root).deps).toEqual([{ ecosystem: "pypi", name: "requests", version_spec: ">=2", registry: "default" }]);
  });

  test("malformed or oversized files are a problem, never a throw", () => {
    writeFileSync(join(root, ".loki", "supply-declared.json"), "{not json");
    expect(readDeclared(root).problem).toBe("declaration unreadable");
    writeFileSync(join(root, ".loki", "supply-declared.json"), "[" + '{"ecosystem":"npm","name":"a"},'.repeat(4000) + "{}]");
    expect(readDeclared(root).problem).toBe("declaration file too large");
    writeFileSync(join(root, ".loki", "supply-declared.json"), '{"a":1}');
    expect(readDeclared(root).problem).toBe("declaration is not a JSON array");
    rmSync(join(root, ".loki", "supply-declared.json"));
  });
});

describe("resolver output classification", () => {
  test("npm", () => {
    expect(classify("npm", "x", 0, '"2020-01-02T03:04:05.000Z"\n', "")).toEqual({ status: "exists", firstPublish: Date.parse("2020-01-02T03:04:05.000Z") });
    expect(classify("npm", "x", 1, "", "npm error code E404")).toEqual({ status: "missing" });
    expect(classify("npm", "x", 1, "", "npm error code ENOTFOUND network")).toEqual({ status: "unproven" });
  });
  test("pip, cargo, go", () => {
    expect(classify("pypi", "x", 0, "x (1.0)\nAvailable versions: 1.0", "")).toEqual({ status: "exists" });
    expect(classify("pypi", "x", 1, "", "ERROR: No matching distribution found for x")).toEqual({ status: "missing" });
    expect(classify("pypi", "x", 1, "", "connection error")).toEqual({ status: "unproven" });
    expect(classify("cargo", "serde", 0, 'serde = "1.0"  # d\n', "")).toEqual({ status: "exists" });
    expect(classify("cargo", "nope", 0, 'other = "1"\n', "")).toEqual({ status: "missing" });
    expect(classify("cargo", "x", 101, "", "")).toEqual({ status: "unproven" });
    expect(classify("go", "x/y", 1, "", "module x/y: no matching versions")).toEqual({ status: "missing" });
    expect(classify("go", "x/y", 1, "", "dial tcp: lookup proxy: no such host")).toEqual({ status: "unproven" });
  });
});

describe("implement brief", () => {
  test("the declaration instruction is fixed text in the cache-stable prefix, identical across runDirs", () => {
    const a = buildImplementBrief("t", null, [], "");
    const b = buildImplementBrief("t", null, [], "");
    expect(a).toBe(b);
    expect(a).toContain(".loki/supply-declared.json");
    expect(a).not.toContain(root);
    const line = FIXED_RULES.split("\n").find((l) => l.includes("supply-declared"))!;
    expect(line.split(/[.!?](?:\s|$)/).filter(Boolean).length).toBeLessThanOrEqual(2);
    expect(line.split(/\s+/).length).toBeLessThan(60);
    expect(a).toContain(FIXED_RULES);
  });
  test("brief text is identical for two different run directories", () => {
    const mk = (d: string) => buildImplementBrief("t", null, [], "") + (d ? "" : "");
    expect(mk(join(root, "run-a"))).toBe(mk(join(root, "run-b")));
  });
});
