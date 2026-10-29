import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildTestMap, guessRunner, harnessRunners, impactedRefs, projectInterpreter, RealTestMapProvider } from "../../src/engine10/testmap.ts";

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

describe("directory entry files (TEN-QUALITY-39)", () => {
  test("index source maps to directory", () => {
    const root = repo({
      "package.json": JSON.stringify({ scripts: { test: "bun test" } }),
      "bunfig.toml": "[test]\n",
      "src/search/index.ts": "export const q = 1;\n",
      "tests/search.test.ts": 'import { q } from "../src/search";\ntest("q", () => {});\n',
    });
    const map = buildTestMap(root);
    expect(impactedRefs(map, ["src/search/index.ts"])).toEqual([{ runner: "bun", path: "tests/search.test.ts" }]);
  });

  test("index source still selects colocated and explicit /index importers", () => {
    const root = repo({
      "package.json": JSON.stringify({ scripts: { test: "bun test" } }),
      "bunfig.toml": "[test]\n",
      "src/search/index.ts": "export const q = 1;\n",
      "src/search/index.test.ts": 'import { q } from "./index";\ntest("q", () => {});\n',
      "tests/query.test.ts": 'import { q } from "../src/search/index";\ntest("q", () => {});\n',
      "tests/search.test.ts": 'import { q } from "../src/search";\ntest("q", () => {});\n',
    });
    const paths = impactedRefs(buildTestMap(root), ["src/search/index.ts"]).map((r) => r.path).sort();
    expect(paths).toEqual(["src/search/index.test.ts", "tests/query.test.ts", "tests/search.test.ts"]);
  });

  test("python __init__ maps to package name", () => {
    const root = repo({
      "pytest.ini": "[pytest]\n",
      "app/search/__init__.py": "x = 1\n",
      "tests/test_s.py": "from app.search import x\n",
    });
    const refs = impactedRefs(buildTestMap(root), ["app/search/__init__.py"]);
    expect(refs).toEqual([{ runner: "pytest", path: "tests/test_s.py" }]);
  });
});

describe("package init maps to directory (TEN-QUALITY-32)", () => {
  test("package init maps to directory: nested pkg/search/__init__.py selects tests/test_search.py", () => {
    const root = repo({
      "pytest.ini": "[pytest]\n",
      "pkg/search/__init__.py": "a = 1\n",
      "tests/test_search.py": "from pkg.search import a\n",
    });
    const map = buildTestMap(root);
    expect(impactedRefs(map, ["pkg/search/__init__.py"])).toEqual([{ runner: "pytest", path: "tests/test_search.py" }]);
  });

  test("package init maps to directory: Rust mod.rs uses its directory name, mod.py does not", () => {
    const map = {
      runners: ["pytest"],
      tests: [{ runner: "pytest", path: "tests/t.py" }],
      sourceRefs: { search: ["tests/t.py"] },
    } as unknown as Parameters<typeof impactedRefs>[0];
    expect(impactedRefs(map, ["src/search/mod.rs"])).toEqual([{ runner: "pytest", path: "tests/t.py" }]);
    expect(impactedRefs(map, ["src/search/mod.py"])).toEqual([]);
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

describe("node detection is conservative (A-102 r2)", () => {
  for (const script of ["node -e 1 && node --test", "npm run build && node --test", "eslint . && node --test", "node --test --experimental-test-coverage", "node scripts/run-mocha.js --test"]) {
    test(`compound script stays npm: ${script}`, () => {
      expect(buildTestMap(repo({ "package.json": JSON.stringify({ scripts: { test: script } }) })).runners).toEqual(["npm"]);
    });
  }
  test("bare node --test with paths is node", () => {
    expect(buildTestMap(repo({ "package.json": '{"scripts":{"test":"node --test test/"}}' })).runners).toEqual(["node"]);
  });
  test("a node:test comment in a jest file does not add node", () => {
    const map = buildTestMap(repo({ "package.json": '{"devDependencies":{"jest":"1"}}', "a.test.js": "// not node:test, see 'node:test' docs\n" }));
    expect(map.runners).toEqual(["jest"]);
  });
  test("a real node:test import adds node", () => {
    expect(buildTestMap(repo({ "a.test.js": "import t from 'node:test';" })).runners).toEqual(["node"]);
  });
});

describe("projectInterpreter (TEN-COST-09)", () => {
  test("system without a venv, project with .venv or venv", () => {
    const saved = process.env["VIRTUAL_ENV"]; delete process.env["VIRTUAL_ENV"];
    try {
      expect(projectInterpreter(repo({ "a.py": "" }))).toBe("system");
      expect(projectInterpreter(repo({ ".venv/bin/python": "" }))).toBe("project");
      expect(projectInterpreter(repo({ "venv/bin/python": "" }))).toBe("project");
    } finally { if (saved !== undefined) process.env["VIRTUAL_ENV"] = saved; }
  });
});

describe("git ls-files source (TEN-SPEED-13)", () => {
  const git = (cwd: string, ...a: string[]): void => { execFileSync("git", a, { cwd, stdio: "ignore" }); };
  test("tracked files only: an ignored dir is not walked", () => {
    const root = repo({ ".gitignore": "vendor/\n", "pytest.ini": "", "test_a.py": "", "vendor/test_ignored.py": "" });
    git(root, "init", "-q");
    const map = buildTestMap(root);
    expect(map.tests.map((t) => t.path)).toEqual(["test_a.py"]);
  });
  test("untracked-not-ignored files still count, output sorted", () => {
    const root = repo({ "pytest.ini": "", "test_b.py": "", "test_a.py": "" });
    git(root, "init", "-q");
    expect(buildTestMap(root).tests.map((t) => t.path)).toEqual(["test_a.py", "test_b.py"]);
  });
  test("outside a repo the walk fallback gives the same map", () => {
    const files = { "pytest.ini": "", "test_a.py": "", "sub/test_b.py": "" };
    const plain = buildTestMap(repo(files));
    const root = repo(files);
    git(root, "init", "-q");
    expect(buildTestMap(root).tests).toEqual(plain.tests);
  });
});

describe("single read per test file (TEN-SPEED-22)", () => {
  test("single read per test file: node:test probe and reference scan share one read", () => {
    const root = repo({
      "a.test.js": "import test from 'node:test';\nimport './src/x.js';\n",
      "b.test.js": "import test from 'node:test';\n",
      "c.test.js": "const x = 1;\n",
      "src/x.js": "export const x = 1;\n",
    });
    const reads: string[] = [];
    const orig = fs.readFileSync;
    const spy = spyOn(fs, "readFileSync").mockImplementation(((p: unknown, ...rest: unknown[]) => {
      reads.push(String(p));
      return (orig as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.readFileSync);
    try {
      const map = buildTestMap(root);
      expect(map.runners).toContain("node");
      expect(map.tests.map((t) => t.path).sort()).toEqual(["a.test.js", "b.test.js", "c.test.js"]);
      for (const f of ["a.test.js", "b.test.js", "c.test.js"]) {
        expect(reads.filter((r) => r.endsWith(f)).length).toBe(1);
      }
    } finally {
      spy.mockRestore();
    }
  });
});

describe("harnessRunners (no project runner: the source language's own stdlib runner, else bun only for harness-language repos)", () => {
  const env = { PATH: process.env.PATH ?? "" };
  const bin = mkdtempSync(join(tmpdir(), "loki-hr-"));
  temps.push(bin);
  for (const t of ["python3", "go", "cargo"]) { writeFileSync(join(bin, t), "#!/bin/sh\n"); chmodSync(join(bin, t), 0o755); }
  const withTools = { PATH: `${bin}:${process.env.PATH ?? ""}` };
  test("docs-only repo: bun fallback kept", () => expect(harnessRunners([], ["README.md", "docs/a.md"], env)).toEqual(["bun"]));
  test("a detected runner is kept", () => expect(harnessRunners(["vitest"], [], env)).toEqual(["vitest"]));
  test("Python source with no runner: unittest, never bun", () => {
    expect(harnessRunners([], ["paginate.py"], withTools)).toEqual(["unittest"]);
    expect(harnessRunners([], ["README.md", "plugins/x/hook.py"], withTools)).toEqual(["unittest"]);
    expect(harnessRunners([], ["app.py", "tests/test_app.py"], withTools)).toEqual(["unittest"]);
  });
  test("Go and Rust source with no runner: go test, cargo test", () => {
    expect(harnessRunners([], ["main.go"], withTools)).toEqual(["go"]);
    expect(harnessRunners([], ["src/lib.rs"], withTools)).toEqual(["cargo"]);
  });
  test("source language whose tool is not on PATH or has no stdlib runner: no runner (Wall skips), never bun", () => {
    expect(harnessRunners([], ["paginate.py"], { PATH: "/nonexistent" })).toEqual([]);
    expect(harnessRunners([], ["lib.java"], withTools)).toEqual([]);
  });
  test("bun only when no source in another language", () => expect(harnessRunners([], ["a.ts", "b.js"], withTools)).toEqual(["bun"]));
  test("the majority language of the runnable sources picks the runner, never a stray file", () => {
    expect(harnessRunners([], ["src/index.ts", "src/a.ts", "scripts/release.py"], withTools)).toEqual(["bun"]);
    expect(harnessRunners([], ["src/index.ts", "docs/conf.py"], withTools)).toEqual(["bun"]);
    expect(harnessRunners([], ["index.js", "lib/a.js", "lib/b.js", "src/addon.cc", "src/addon.h"], withTools)).toEqual(["bun"]);
    expect(harnessRunners([], ["a.py", "b.py", "c.py", "stray.js"], withTools)).toEqual(["unittest"]);
  });
  test("one runner only, so the Wall brief and verify agree (mixed Python and Go resolves to the larger)", () => {
    expect(harnessRunners([], ["a.py", "b.py", "m.go"], withTools)).toEqual(["unittest"]);
    expect(harnessRunners([], ["a.py", "m.go", "n.go"], withTools)).toEqual(["go"]);
  });
  test("off with LOKI_WALL_HARNESS_RUNNER=0 or no bun on PATH", () => {
    expect(harnessRunners([], [], { ...env, LOKI_WALL_HARNESS_RUNNER: "0" })).toEqual([]);
    expect(harnessRunners([], [], { PATH: "/nonexistent" })).toEqual([]);
  });
  test("guessRunner: .py maps to unittest when that is the repo runner, pytest otherwise", () => {
    expect(guessRunner("loki_wall_a.py", ["unittest"])).toBe("unittest");
    expect(guessRunner("loki_wall_a.py", ["pytest"])).toBe("pytest");
    expect(guessRunner("loki_wall_a.py", [])).toBe("pytest");
  });
});

describe("FC-WALL-RUST-FILE-HAS-NO-RUNNER: guessRunner for .rs", () => {
  test("cargo only for a file directly under tests/ in a cargo repo", () => {
    expect(guessRunner("loki_wall_x.rs", ["cargo"], "tests/loki_wall_x.rs")).toBe("cargo");
    expect(guessRunner("loki_wall_x.rs", ["cargo"], "crates/a/tests/loki_wall_x.rs")).toBe("cargo");
    expect(guessRunner("loki_wall_x.rs", ["cargo"], "src/loki_wall_x.rs")).toBeNull();
    expect(guessRunner("loki_wall_x.rs", ["cargo"], "tests/sub/loki_wall_x.rs")).toBeNull();
    expect(guessRunner("loki_wall_x.rs", ["cargo"])).toBeNull();
    expect(guessRunner("loki_wall_x.rs", ["pytest"], "tests/loki_wall_x.rs")).toBeNull();
  });
});

describe("harnessRunners language attribution (D122: linguist rules, .gitattributes, bytes not counts)", () => {
  const filler = (bytes: number, prefix = "#"): string => Array.from({ length: Math.ceil(bytes / 40) }, () => `${prefix} ${"x".repeat(37)}\n`).join("");
  const many = (dir: string, n: number, ext: string, body: (i: number) => string): Record<string, string> => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${dir}/${ext === ".py" ? "g" : "f"}${i}${ext}`, body(i)]));
  const PB2 = "# Generated by the protocol buffer compiler.  DO NOT EDIT!\n";
  /** A committed git repo (check-attr and ls-tree read it) plus a PATH holding a fake python3. */
  function lrepo(files: Record<string, string>): { root: string; list: string[]; env: NodeJS.ProcessEnv } {
    const root = repo(files), g = (...a: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: root, encoding: "utf8" });
    g("init", "-q"); g("add", "-A"); g("commit", "-q", "-m", "x");
    const bin = mkdtempSync(join(tmpdir(), "loki-hr2-")); temps.push(bin);
    writeFileSync(join(bin, "python3"), "#!/bin/sh\n"); chmodSync(join(bin, "python3"), 0o755);
    return { root, list: Object.keys(files).filter((f) => f !== ".gitattributes"), env: { PATH: `${bin}:${process.env.PATH ?? ""}` } };
  }
  const ts = (): Record<string, string> => many("src", 5, ".ts", (i) => `export const f${i} = ${i};\n${filler(2000, "//")}`);
  const pick = (r: ReturnType<typeof lrepo>): string[] => harnessRunners([], r.list, r.env, r.root);

  test("tools/gyp: 30 tiny python files do not outweigh five TypeScript files (bytes, not counts)", () => {
    expect(pick(lrepo({ ...ts(), ...many("tools/gyp", 30, ".py", () => filler(100)) }))).toEqual(["bun"]);
  });
  test("deps/gyp: vendored by linguist's ^deps/ rule even when larger than the TypeScript", () => {
    expect(pick(lrepo({ ...ts(), ...many("deps/gyp", 30, ".py", () => filler(1000)) }))).toEqual(["bun"]);
  });
  test("gen/*_pb2.py: generated by the protobuf header even when larger than the TypeScript", () => {
    expect(pick(lrepo({ ...ts(), ...Object.fromEntries([0, 1, 2].map((i) => [`gen/m${i}_pb2.py`, PB2 + filler(5000)])) }))).toEqual(["bun"]);
  });
  test("control: the same gen/m*_pb2.py without the generated header counts, so python wins", () => {
    expect(pick(lrepo({ ...ts(), ...Object.fromEntries([0, 1, 2].map((i) => [`gen/m${i}_pb2.py`, filler(5000)])) }))).toEqual(["unittest"]);
  });
  test(".gitattributes linguist-vendored flips a python directory out of the count", () => {
    const files = { ...ts(), ...many("lib", 3, ".py", () => filler(8000)) };
    expect(pick(lrepo(files))).toEqual(["unittest"]);
    expect(pick(lrepo({ ...files, ".gitattributes": "lib/** linguist-vendored\n" }))).toEqual(["bun"]);
  });
  test(".gitattributes -linguist-vendored brings a built-in vendored path back", () => {
    const files = { ...ts(), ...many("deps/gyp", 30, ".py", () => filler(1000)) };
    expect(pick(lrepo({ ...files, ".gitattributes": "deps/** -linguist-vendored\n" }))).toEqual(["unittest"]);
  });
  test(".gitattributes linguist-language reassigns a file's language", () => {
    expect(pick(lrepo({ ...ts(), ".gitattributes": "src/*.ts linguist-language=Python\n" }))).toEqual(["unittest"]);
  });
  test("bytes beat counts: thirty tiny JS config files against two large python files", () => {
    expect(pick(lrepo({ ...many("cfg", 30, ".js", (i) => `module.exports = ${i};\n`), ...many("app", 2, ".py", () => filler(3000)) }))).toEqual(["unittest"]);
  });
  test("control: a python repo with static/vendor/jquery.min.js stays python", () => {
    expect(pick(lrepo({ "app.py": filler(2000), "tests/test_app.py": filler(500), "static/vendor/jquery.min.js": `/*! jQuery */${"a=1;".repeat(15000)}\n` }))).toEqual(["unittest"]);
  });
  test("rails_with_js: Ruby bytes outweigh the JS, so no runner (never bun on a non-JS repo)", () => {
    expect(pick(lrepo({ ...many("app", 6, ".rb", () => filler(3000)), ...many("app/js", 2, ".js", () => filler(500, "//")) }))).toEqual([]);
  });
  test("java_with_js: Java bytes outweigh the JS and the top stdlib language, so no runner", () => {
    expect(pick(lrepo({ ...many("src", 6, ".java", () => filler(3000, "//")), ...many("web", 2, ".js", () => filler(500, "//")), ...many("tools", 2, ".py", () => filler(300)) }))).toEqual([]);
  });
  test("control: the same JS outweighing the Ruby picks bun", () => {
    expect(pick(lrepo({ ...many("app", 2, ".rb", () => filler(500)), ...many("app/js", 6, ".js", () => filler(3000, "//")) }))).toEqual(["bun"]);
  });
  test("a minified file outside any vendor path is still dropped by the line-length heuristic", () => {
    expect(pick(lrepo({ "app.py": filler(2000), "web/bundle.js": `${"a=1;".repeat(15000)}\n` }))).toEqual(["unittest"]);
  });
});
