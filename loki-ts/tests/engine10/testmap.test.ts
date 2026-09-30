import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildTestMap, impactedRefs, RealTestMapProvider } from "../../src/engine10/testmap.ts";

const MIXED = resolve(import.meta.dir, "fixtures/testmap");

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

  test("each detected runner has an evidence file", () => {
    for (const r of map.runners) {
      expect(typeof map.evidence[r]).toBe("string");
      expect(map.evidence[r]!.length).toBeGreaterThan(0);
    }
    expect(map.evidence.pytest).toBe("pyproject.toml");
  });

  test("each detected runner has a command, npm and cargo marked coarse", () => {
    for (const r of map.runners) {
      expect(map.commands[r]?.cmd).toBeTruthy();
    }
    expect(map.commands.pytest).toEqual({ cmd: "python -m pytest -q <files>", coarse: false });
    expect(map.commands.vitest).toEqual({ cmd: "npx vitest run <files>", coarse: false });
  });

  test("changed src/search.ts maps to src/search.test.ts (import grep)", () => {
    const refs = impactedRefs(map, ["src/search.ts"]);
    expect(refs).toEqual([{ runner: "vitest", path: "src/search.test.ts" }]);
  });

  test("changed python module maps to its test via the naming floor (fixture is import-free on purpose)", () => {
    const refs = impactedRefs(map, ["app/ranker.py"]);
    expect(refs).toEqual([{ runner: "pytest", path: "tests/test_ranker.py" }]);
  });

  test("a changed test file maps to itself; an unrelated file maps to nothing", () => {
    expect(impactedRefs(map, ["src/search.test.ts"])).toEqual([{ runner: "vitest", path: "src/search.test.ts" }]);
    expect(impactedRefs(map, ["README.md"])).toEqual([]);
  });

  test("the map is JSON-safe for the per-repo cache", () => {
    expect(JSON.parse(JSON.stringify(map))).toEqual(map);
  });
});

describe("TestMapProvider contract (types.ts, E-01)", () => {
  test("detect() and impacted() round-trip through the real provider", async () => {
    const provider = new RealTestMapProvider();
    const map = await provider.detect(MIXED);
    expect(map.runners).toContain("pytest");
    const refs = provider.impacted(map, ["app/ranker.py"]);
    expect(refs).toEqual([{ runner: "pytest", path: "tests/test_ranker.py" }]);
  });
});

describe("runner detection from real files", () => {
  test("go, cargo, jest, bun", () => {
    expect(buildTestMap(repo({ "go.mod": "module x\n" })).runners).toEqual(["go"]);
    expect(buildTestMap(repo({ "Cargo.toml": "[package]\n" })).runners).toEqual(["cargo"]);
    expect(buildTestMap(repo({ "package.json": JSON.stringify({ devDependencies: { jest: "1" } }) })).runners).toEqual(["jest"]);
    expect(buildTestMap(repo({ "package.json": JSON.stringify({ scripts: { test: "bun test" } }) })).runners).toEqual(["bun", "npm"]);
  });

  test("bun from bunfig.toml alone (section 8: bunfig.toml or a bun test script)", () => {
    const map = buildTestMap(repo({ "bunfig.toml": "[test]\n" }));
    expect(map.runners).toEqual(["bun"]);
    expect(map.evidence.bun).toBe("bunfig.toml");
    expect(map.commands.bun).toEqual({ cmd: "bun test <files>", coarse: false });
  });

  test("npm and cargo commands are marked coarse", () => {
    const npmMap = buildTestMap(repo({ "package.json": JSON.stringify({ scripts: { test: "mocha" } }) }));
    expect(npmMap.commands.npm).toEqual({ cmd: "npm test --silent", coarse: true });
    const cargoMap = buildTestMap(repo({ "Cargo.toml": "[package]\n" }));
    expect(cargoMap.commands.cargo).toEqual({ cmd: "cargo test", coarse: true });
  });

  test("pytest from conftest alone, or from a tests/test_*.py file alone", () => {
    expect(buildTestMap(repo({ "conftest.py": "" })).runners).toEqual(["pytest"]);
    expect(buildTestMap(repo({ "tests/test_a.py": "def test_a(): pass\n" })).runners).toEqual(["pytest"]);
  });

  test("pytest command uses the repo's own .venv interpreter when present (E-53)", () => {
    const root = repo({ "conftest.py": "", ".venv/bin/python": "" });
    chmodSync(join(root, ".venv/bin/python"), 0o755);
    const map = buildTestMap(root);
    expect(map.commands.pytest).toEqual({ cmd: `${join(root, ".venv/bin/python")} -m pytest -q <files>`, coarse: false });
  });

  test("pytest command falls back to venv/bin/python, then bare python, when .venv is absent", () => {
    const withVenv = repo({ "conftest.py": "", "venv/bin/python": "" });
    expect(buildTestMap(withVenv).commands.pytest?.cmd).toBe(`${join(withVenv, "venv/bin/python")} -m pytest -q <files>`);
    const bare = repo({ "conftest.py": "" });
    expect(buildTestMap(bare).commands.pytest?.cmd).toBe("python -m pytest -q <files>");
  });

  test(".venv wins over venv when both are present", () => {
    const root = repo({ "conftest.py": "", ".venv/bin/python": "", "venv/bin/python": "" });
    expect(buildTestMap(root).commands.pytest?.cmd).toBe(`${join(root, ".venv/bin/python")} -m pytest -q <files>`);
  });

  test("a same-package Go test with no imports of its own still maps by naming floor", () => {
    const root = repo({
      "go.mod": "module x\n",
      "pkg/handler.go": "package pkg\n",
      "pkg/handler_test.go": "package pkg\n\nfunc TestHandler(t *testing.T) {}\n",
    });
    const map = buildTestMap(root);
    expect(impactedRefs(map, ["pkg/handler.go"])).toEqual([{ runner: "go", path: "pkg/handler_test.go" }]);
  });

  test("`from pkg import mod` grep resolves to pkg, not mod; the naming floor still finds test_mod.py", () => {
    const root = repo({
      "pyproject.toml": "[tool.pytest.ini_options]\n",
      "app/mod.py": "def f():\n    return 1\n",
      "tests/test_mod.py": "from app import mod\n\n\ndef test_f():\n    assert mod.f() == 1\n",
    });
    const map = buildTestMap(root);
    expect(impactedRefs(map, ["app/mod.py"])).toEqual([{ runner: "pytest", path: "tests/test_mod.py" }]);
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

describe("one fixture per runner (A-102)", () => {
  const cases: Array<[string, Record<string, string>, string]> = [
    ["node", { "package.json": '{"scripts":{"test":"node --test"}}', "sum.js": "", "sum.test.js": "const test = require('node:test');\nrequire('./sum');" }, "node --test <files>"],
    ["node", { "package.json": "{}", "a.js": "", "a.test.mjs": "import test from 'node:test';\nimport './a.js';" }, "node --test <files>"],
    ["jest", { "package.json": '{"devDependencies":{"jest":"1"}}', "a.test.js": "" }, "npx jest <files>"],
    ["vitest", { "package.json": '{"devDependencies":{"vitest":"1"}}', "a.test.ts": "" }, "npx vitest run <files>"],
    ["pytest", { "pytest.ini": "", "test_a.py": "" }, "python -m pytest -q <files>"],
    ["go", { "go.mod": "module x", "a_test.go": "" }, "go test ./<pkg dirs>"],
    ["cargo", { "Cargo.toml": "" }, "cargo test"],
  ];
  for (const [runner, files, cmd] of cases) {
    test(`${runner}: ${Object.keys(files)[0]}`, () => {
      const map = buildTestMap(repo(files));
      expect(map.runners).toEqual([runner as never]);
      expect(map.commands[runner as "node"]?.cmd).toBe(cmd);
    });
  }
  test("node: sum.js impacts sum.test.js", () => {
    const map = buildTestMap(repo({ "package.json": '{"scripts":{"test":"node --test"}}', "sum.js": "", "sum.test.js": "require('./sum')" }));
    expect(impactedRefs(map, ["sum.js"])).toEqual([{ runner: "node", path: "sum.test.js" }]);
  });
  test("a custom npm test script stays npm", () => {
    expect(buildTestMap(repo({ "package.json": '{"scripts":{"test":"mocha"}}' })).runners).toEqual(["npm"]);
  });
});
