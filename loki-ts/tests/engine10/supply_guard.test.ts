// T10: supply-chain guard v1. Real temp git repo, injected registry fetcher, no network.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDeps, supplyGuard, supplyVerdict, type RegistryFetcher } from "../../src/supply/supply_guard.ts";

const NOW = Date.parse("2026-10-08T00:00:00Z");
const day = (n: number): string => new Date(NOW - n * 86400000).toISOString();
let repo = "", base = "", head = "";
const git = (...a: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, encoding: "utf8" }).trim();

function reg(map: Record<string, number | "missing">): RegistryFetcher {
  return async (url) => {
    const name = decodeURIComponent(url.split("/").slice(url.includes("pypi.org") ? -2 : -1)[0]!);
    const v = map[name];
    if (v === undefined || v === "missing") return { status: 404 };
    return url.includes("pypi.org")
      ? { status: 200, json: { releases: { "1.0": [{ upload_time_iso_8601: day(v) }], "2.0": [{ upload_time_iso_8601: day(1) }] } } }
      : { status: 200, json: { versions: { "1.0.0": {} }, time: { created: day(v), modified: day(0), "1.0.0": day(v) } } };
  };
}
const down: RegistryFetcher = async () => { throw new Error("ECONNREFUSED"); };
const run = (files: string[], fetcher: RegistryFetcher, env: NodeJS.ProcessEnv = {}) => supplyGuard(repo, base, head, files, { HOME: repo, ...env }, { fetcher, now: NOW });

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "supply-"));
  git("init", "-q"); mkdirSync(join(repo, ".loki"));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { express: "^4" } }));
  writeFileSync(join(repo, "requirements.txt"), "requests==2.0\n");
  writeFileSync(join(repo, "go.mod"), "module x\n\nrequire (\n\tgithub.com/a/b v1.0.0\n)\n");
  git("add", "-A"); git("commit", "-qm", "base"); base = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { express: "^4", "old-pkg": "^1", "ghost-pkg": "^1", "fresh-pkg": "^1", "@s/scoped": "^1", local: "file:../x" } }));
  writeFileSync(join(repo, "requirements.txt"), "requests==2.0\nOld_Py>=1\n# c\n-r other.txt\n");
  writeFileSync(join(repo, "go.mod"), "module x\n\nrequire (\n\tgithub.com/a/b v1.0.0\n\tgithub.com/c/d v1.2.0\n)\n");
  git("add", "-A"); git("commit", "-qm", "head"); head = git("rev-parse", "HEAD");
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const pkgOnly = ["package.json"];

describe("supply guard", () => {
  test("parsers find only added deps and skip non-registry specs", () => {
    expect(parseDeps("a/package.json", JSON.stringify({ dependencies: { a: "1", b: "file:../b" } }))).toEqual(["a"]);
    expect(parseDeps("requirements-dev.txt", "Foo_Bar==1\n-e .\n# x\n")).toEqual(["foo-bar"]);
    expect(parseDeps("pyproject.toml", '[project]\ndependencies = [\n  "httpx>=0.2",\n]\n')).toEqual(["httpx"]);
    expect(parseDeps("Cargo.toml", "[dependencies]\nserde = \"1\"\n")).toEqual(["serde"]);
  });

  test("existing old package passes (ok)", async () => {
    const r = await run(pkgOnly, reg({ "old-pkg": 400, "ghost-pkg": 400, "fresh-pkg": 400, "@s/scoped": 400 }));
    expect(r.blocked).toBe(false);
    expect(r.block!.entries.find((e) => e.name === "old-pkg")).toMatchObject({ status: "ok", age_days: 400 });
    expect(r.block!.entries.some((e) => e.name === "local")).toBe(false);
  });

  test("nonexistent package fails closed and is recorded", async () => {
    const r = await run(pkgOnly, reg({ "old-pkg": 400, "fresh-pkg": 400, "@s/scoped": 400, "ghost-pkg": "missing" }));
    expect(r.blocked).toBe(true);
    expect(r.block!.entries.find((e) => e.name === "ghost-pkg")!.status).toBe("nonexistent");
    expect(r.notProven.join("\n")).toContain("npm:ghost-pkg");
  });

  test("a 2-day-old package only warns: VERIFIED stays VERIFIED and the warning is on the receipt", async () => {
    const r = await run(pkgOnly, reg({ "old-pkg": 400, "ghost-pkg": 400, "fresh-pkg": 2, "@s/scoped": 400 }));
    expect(r.blocked).toBe(false);
    expect(supplyVerdict("VERIFIED" as string, r)).toBe("VERIFIED");
    expect(r.block!.entries.find((e) => e.name === "fresh-pkg")).toMatchObject({ status: "too_new", age_days: 2 });
    expect(r.notProven.join("\n")).toContain("supply guard WARNING: npm:fresh-pkg");
  });

  test("LOKI_SUPPLY_MIN_AGE_DAYS opts in to a hard fail on age", async () => {
    const r = await run(pkgOnly, reg({ "old-pkg": 400, "ghost-pkg": 400, "fresh-pkg": 20, "@s/scoped": 400 }), { LOKI_SUPPLY_MIN_AGE_DAYS: "30" });
    expect(r.blocked).toBe(true);
    expect(supplyVerdict("VERIFIED" as string, r)).toBe("FAILED");
    expect(r.notProven.join("\n")).toContain("FAILED: npm:fresh-pkg");
  });

  test("registry outage is NOT PROVEN, never FAILED", async () => {
    const r = await run(pkgOnly, down);
    expect(supplyVerdict("VERIFIED" as string, r)).toBe("VERIFIED");
    expect(r.notProven.join("\n")).not.toContain("FAILED");
  });

  test("lookups are cached per run", async () => {
    let calls = 0;
    const f = reg({ "old-pkg": 400, "ghost-pkg": 400, "fresh-pkg": 400, "@s/scoped": 400 });
    await run(pkgOnly, async (u, t) => { calls++; return f(u, t); });
    expect(calls).toBe(4);
  });

  test("allowlist accepts a new or unknown package without a registry call", async () => {
    writeFileSync(join(repo, ".loki", "supply-allowlist"), "fresh-pkg\nghost-pkg # private\n");
    try {
      const r = await run(pkgOnly, reg({ "old-pkg": 400, "@s/scoped": 400, "fresh-pkg": 2, "ghost-pkg": "missing" }));
      expect(r.blocked).toBe(false);
      expect(r.block!.entries.filter((e) => e.status === "allowlisted").map((e) => e.name).sort()).toEqual(["fresh-pkg", "ghost-pkg"]);
    } finally { rmSync(join(repo, ".loki", "supply-allowlist")); }
  });

  test("registry down is NOT PROVEN and does not block", async () => {
    const r = await run(pkgOnly, down);
    expect(r.blocked).toBe(false);
    expect(r.block!.entries.every((e) => e.status === "unreachable")).toBe(true);
    expect(r.notProven[0]).toContain("supply guard NOT PROVEN");
  });

  test("PyPI: normalized name, first release age, missing", async () => {
    const r = await run(["requirements.txt"], reg({ "old-py": 900 }));
    expect(r.block!.entries).toEqual([{ ecosystem: "pypi", name: "old-py", manifest: "requirements.txt", status: "ok", age_days: 900 }]);
    expect((await run(["requirements.txt"], reg({}))).blocked).toBe(true);
  });

  test("unsupported ecosystem is reported as not checked", async () => {
    const r = await run(["go.mod"], down);
    expect(r.blocked).toBe(false);
    expect(r.block!.entries).toEqual([{ ecosystem: "go", name: "github.com/c/d", manifest: "go.mod", status: "unsupported" }]);
    expect(r.notProven).toEqual(["supply guard: not checked (ecosystem unsupported in v1): go:github.com/c/d (go.mod)"]);
  });

  test("LOKI_SUPPLY_GUARD=0 is inert: no block, no lines, no registry call", async () => {
    let calls = 0;
    const r = await run(pkgOnly, async () => { calls++; return { status: 404 }; }, { LOKI_SUPPLY_GUARD: "0" });
    expect(r).toEqual({ block: null, notProven: [], blocked: false });
    expect(calls).toBe(0);
  });

  test("no manifest touched yields no block", async () => {
    expect(await run(["src/a.ts"], down)).toEqual({ block: null, notProven: [], blocked: false });
  });

  test("a manifest touched without a dependency change skips the guard", async () => {
    const r = await mk({ "package.json": JSON.stringify({ dependencies: { a: "1" }, version: "1" }) }, { "package.json": JSON.stringify({ dependencies: { a: "2" }, version: "2" }) }, ["package.json"], down);
    expect(r).toEqual({ block: null, notProven: [], blocked: false });
  });

  test("B1: pyproject keywords, classifiers and tool tables are not dependencies", async () => {
    const t = '[project]\nname = "x"\nkeywords = ["E501", "foo"]\ndependencies = [\n  "httpx>=1",\n]\n[project.optional-dependencies]\ndev = ["pytest>=7"]\n[tool.ruff]\nselect = ["E501", "W"]\n[tool.ruff.lint]\nignore = [\n  "E402",\n]\n[build-system]\nrequires = ["setuptools"]\n[dependency-groups]\ntest = ["coverage"]\n';
    expect(parseDeps("pyproject.toml", t).sort()).toEqual(["coverage", "httpx", "pytest", "setuptools"]);
    const before = '[project]\ndependencies = ["httpx"]\n[tool.ruff]\nselect = ["E"]\nkeywords = ["a"]\n';
    const after = '[project]\ndependencies = ["httpx"]\nkeywords = ["a", "E501"]\n[tool.ruff]\nselect = ["E", "E501"]\n';
    expect(await mk({ "pyproject.toml": before }, { "pyproject.toml": after }, ["pyproject.toml"], down)).toEqual({ block: null, notProven: [], blocked: false });
  });

  test("B2a: an npm: alias checks the target name", () => {
    expect(parseDeps("package.json", JSON.stringify({ dependencies: { mine: "npm:real-pkg@^1", sc: "npm:@o/p@1" } }))).toEqual(["real-pkg", "@o/p"]);
  });

  test("B2b: non-registry specs are skipped", () => {
    const d = { a: "catalog:", b: "portal:../b", c: "workspace:*", d: "file:../d", e: "link:../e", f: "./f", g: "/abs", h: "~/h", i: "owner/repo", j: "owner/repo#main", k: "^1.0.0" };
    expect(parseDeps("package.json", JSON.stringify({ dependencies: d }))).toEqual(["k"]);
  });

  test("B2c: a configured private registry is queried but a 404 is NOT PROVEN, never a block", async () => {
    const urls: string[] = [];
    const f: RegistryFetcher = async (u) => { urls.push(u); return { status: 404 }; };
    const npmrc = "registry=https://npm.corp.example/\n@acme:registry=https://acme.example/npm\n";
    const r = await mk({ "package.json": "{}", ".npmrc": npmrc }, { "package.json": JSON.stringify({ dependencies: { plain: "1", "@acme/x": "1" } }), ".npmrc": npmrc }, ["package.json"], f, {}, true);
    expect(r.blocked).toBe(false);
    expect(urls.sort()).toEqual(["https://acme.example/npm/@acme%2Fx", "https://npm.corp.example/plain"]);
    expect(r.block!.entries.every((e) => e.status === "unreachable")).toBe(true);
  });

  test("B2d: workspace sibling packages are not looked up", async () => {
    let calls = 0;
    const root = JSON.stringify({ name: "root", workspaces: ["packages/*"] });
    const r = await mk({ "package.json": root, "packages/a/package.json": JSON.stringify({ name: "@w/a" }) },
      { "package.json": root, "packages/a/package.json": JSON.stringify({ name: "@w/a" }), "packages/b/package.json": JSON.stringify({ name: "@w/b", dependencies: { "@w/a": "1.0.0" } }) },
      ["packages/b/package.json"], async () => { calls++; return { status: 404 }; });
    expect(calls).toBe(0);
    expect(r.blocked).toBe(false);
  });

  test("B2e: a requirements file with its own index makes its deps NOT PROVEN", async () => {
    let calls = 0;
    const r = await mk({ "requirements.txt": "a==1\n" }, { "requirements.txt": "--extra-index-url https://pip.corp/simple\na==1\nprivlib==2\n" }, ["requirements.txt"], async () => { calls++; return { status: 404 }; });
    expect(calls).toBe(0);
    expect(r.blocked).toBe(false);
    expect(r.block!.entries).toMatchObject([{ name: "privlib", status: "unreachable" }]);
  });

  test("N1: past the cap the line says so", async () => {
    const deps: Record<string, string> = {}; for (let i = 0; i < 52; i++) deps[`p${i}`] = "1";
    const r = await mk({ "package.json": "{}" }, { "package.json": JSON.stringify({ dependencies: deps }) }, ["package.json"], async () => ({ status: 200, json: { versions: { "1": {} }, time: { created: day(400) } } }));
    expect(r.notProven.filter((l) => l.includes("not checked: cap 50 exceeded")).length).toBe(2);
    expect(r.blocked).toBe(false);
  });

  test("N2: an unpublished npm package counts as nonexistent", async () => {
    const r = await mk({ "package.json": "{}" }, { "package.json": JSON.stringify({ dependencies: { gone: "1", empty: "1" } }) }, ["package.json"],
      async (u) => ({ status: 200, json: u.endsWith("/gone") ? { versions: { "1": {} }, time: { created: day(900), unpublished: { time: day(1) } } } : { time: { created: day(900) } } }));
    expect(r.blocked).toBe(true);
    expect(r.block!.entries.map((e) => e.status)).toEqual(["nonexistent", "nonexistent"]);
  });
});

// Builds a throwaway repo with a base and head commit and runs the guard over it.
async function mk(baseFiles: Record<string, string>, headFiles: Record<string, string>, changed: string[], fetcher: RegistryFetcher, env: NodeJS.ProcessEnv = {}, _npmrc = false) {
  const d = mkdtempSync(join(tmpdir(), "supply2-"));
  const g = (...a: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: d, encoding: "utf8" }).trim();
  try {
    g("init", "-q");
    const put = (fs: Record<string, string>): void => { for (const [k, v] of Object.entries(fs)) { mkdirSync(join(d, k, ".."), { recursive: true }); writeFileSync(join(d, k), v); } };
    put(baseFiles); g("add", "-A"); g("commit", "-qm", "b"); const b = g("rev-parse", "HEAD");
    put(headFiles); g("add", "-A"); g("commit", "-qm", "h"); const h = g("rev-parse", "HEAD");
    return await supplyGuard(d, b, h, changed, { HOME: d, ...env }, { fetcher, now: NOW });
  } finally { rmSync(d, { recursive: true, force: true }); }
}
