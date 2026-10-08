// T10: supply-chain guard v1. Real temp git repo, injected registry fetcher, no network.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDeps, supplyGuard, type RegistryFetcher } from "../../src/supply/supply_guard.ts";

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
      : { status: 200, json: { time: { created: day(v), modified: day(0), "1.0.0": day(v) } } };
  };
}
const down: RegistryFetcher = async () => { throw new Error("ECONNREFUSED"); };
const run = (files: string[], fetcher: RegistryFetcher, env: NodeJS.ProcessEnv = {}) => supplyGuard(repo, base, head, files, env, { fetcher, now: NOW });

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

  test("a 2-day-old package is flagged and blocks", async () => {
    const r = await run(pkgOnly, reg({ "old-pkg": 400, "ghost-pkg": 400, "fresh-pkg": 2, "@s/scoped": 400 }));
    expect(r.blocked).toBe(true);
    expect(r.block!.entries.find((e) => e.name === "fresh-pkg")).toMatchObject({ status: "too_new", age_days: 2 });
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
});
