import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildTestMap, impactedTests } from "../../src/engine10/testmap.ts";

const MIXED = resolve(import.meta.dir, "fixtures/mixed-repo");

const temps: string[] = [];
function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "e10-testmap-"));
  temps.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

describe("mixed pytest plus vitest repo", () => {
  const map = buildTestMap(MIXED);

  test("reports pytest and vitest, never none", () => {
    expect(map.runners).toContain("pytest");
    expect(map.runners).toContain("vitest");
    expect(map.runners.length).toBeGreaterThan(0);
  });

  test("changed src/search.ts maps to src/search.test.ts", () => {
    expect(impactedTests(map, ["src/search.ts"])).toEqual({ "src/search.ts": ["src/search.test.ts"] });
  });

  test("changed python module maps to its test_ file", () => {
    expect(impactedTests(map, ["app/ranker.py"])["app/ranker.py"]).toEqual(["tests/test_ranker.py"]);
  });

  test("a changed test file maps to itself; an unrelated file maps to nothing", () => {
    const got = impactedTests(map, ["src/search.test.ts", "README.md"]);
    expect(got["src/search.test.ts"]).toEqual(["src/search.test.ts"]);
    expect(got["README.md"]).toEqual([]);
  });

  test("the map is JSON-safe for the per-repo cache", () => {
    expect(JSON.parse(JSON.stringify(map))).toEqual(map);
  });
});

describe("runner detection from real files", () => {
  test("go, cargo, jest, bun", () => {
    expect(buildTestMap(repo({ "go.mod": "module x\n" })).runners).toEqual(["go"]);
    expect(buildTestMap(repo({ "Cargo.toml": "[package]\n" })).runners).toEqual(["cargo"]);
    expect(buildTestMap(repo({ "package.json": JSON.stringify({ devDependencies: { jest: "1" } }) })).runners).toEqual(["jest"]);
    expect(buildTestMap(repo({ "package.json": JSON.stringify({ scripts: { test: "bun test" } }) })).runners).toEqual(["bun", "npm"]);
  });

  test("pytest from conftest alone, or from a tests/test_*.py file alone", () => {
    expect(buildTestMap(repo({ "conftest.py": "" })).runners).toEqual(["pytest"]);
    expect(buildTestMap(repo({ "tests/test_a.py": "def test_a(): pass\n" })).runners).toEqual(["pytest"]);
  });

  test("npm's default no-test script is not a runner; an empty repo is empty", () => {
    const npmDefault = { scripts: { test: 'echo "Error: no test specified" && exit 1' } };
    expect(buildTestMap(repo({ "package.json": JSON.stringify(npmDefault) })).runners).toEqual([]);
    expect(buildTestMap(repo({ "README.md": "x" })).runners).toEqual([]);
  });

  test("node_modules is not scanned", () => {
    const root = repo({ "node_modules/pkg/a.test.ts": "", "node_modules/pkg/package.json": JSON.stringify({ devDependencies: { jest: "1" } }) });
    const map = buildTestMap(root);
    expect(map.runners).toEqual([]);
    expect(map.tests).toEqual([]);
  });
});
