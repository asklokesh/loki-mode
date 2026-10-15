// D86 FC-09r: runner-config changes cap the verdict; shared manifests are compared base vs head by section.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { testConfigChanged } from "../../src/features/runner_config.ts";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const sh = (d: string, a: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: d, encoding: "utf8" }).trim();
function repo(files: Record<string, string>): { dir: string; base: string; edit: (f: string, t: string) => void } {
  const dir = mkdtempSync(join(tmpdir(), "rc-")); dirs.push(dir);
  sh(dir, ["init", "-q"]);
  const put = (f: string, t: string): void => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), t); };
  for (const [f, t] of Object.entries(files)) put(f, t);
  sh(dir, ["add", "."]); sh(dir, ["commit", "-qm", "base"]);
  return { dir, base: sh(dir, ["rev-parse", "HEAD"]), edit: put };
}
const pkg = (scripts: Record<string, string>, extra: Record<string, unknown> = {}): string => JSON.stringify({ name: "x", scripts, ...extra }, null, 2);

describe("FC-09r testConfigChanged", () => {
  test.each([["pretest"], ["posttest"], ["test:unit"], ["build"]])("package.json scripts.%s edit caps", (k) => {
    const r = repo({ "package.json": pkg({ test: "node --test", [k]: "echo a" }) });
    r.edit("package.json", pkg({ test: "node --test", [k]: "echo b" }));
    expect(testConfigChanged(r.dir, r.base, ["package.json"])).toEqual(["package.json"]);
  });
  test("a new pretest script caps; a dependency bump or version does not", () => {
    const r = repo({ "package.json": pkg({ test: "node --test" }, { dependencies: { a: "1" } }) });
    r.edit("package.json", pkg({ test: "node --test" }, { dependencies: { a: "2" }, version: "2.0.0" }));
    expect(testConfigChanged(r.dir, r.base, ["package.json"])).toEqual([]);
    r.edit("package.json", pkg({ test: "node --test", pretest: "node mock.js" }));
    expect(testConfigChanged(r.dir, r.base, ["package.json"])).toEqual(["package.json"]);
  });
  test.each([["overrides", { a: "1.0.0" }], ["imports", { "#x": "./x.js" }], ["resolutions", { a: "1" }]])("package.json %s caps", (k, v) => {
    const r = repo({ "package.json": pkg({ test: "t" }) });
    r.edit("package.json", pkg({ test: "t" }, { [k]: v }));
    expect(testConfigChanged(r.dir, r.base, ["package.json"])).toEqual(["package.json"]);
  });
  test("malformed package.json that changed fails closed; unchanged does not cap", () => {
    const r = repo({ "package.json": "{ not json" });
    expect(testConfigChanged(r.dir, r.base, ["package.json"])).toEqual([]);
    r.edit("package.json", "{ still not json");
    expect(testConfigChanged(r.dir, r.base, ["package.json"])).toEqual(["package.json"]);
  });
  test("go.mod replace caps (single and block); require bump does not", () => {
    const r = repo({ "go.mod": "module m\n\nrequire a v1.0.0\n" });
    r.edit("go.mod", "module m\n\nrequire a v1.1.0\n");
    expect(testConfigChanged(r.dir, r.base, ["go.mod"])).toEqual([]);
    r.edit("go.mod", "module m\n\nrequire a v1.0.0\nreplace a => ../fake\n");
    expect(testConfigChanged(r.dir, r.base, ["go.mod"])).toEqual(["go.mod"]);
    r.edit("go.mod", "module m\n\nrequire a v1.0.0\nreplace (\n\ta => ../fake\n)\n");
    expect(testConfigChanged(r.dir, r.base, ["go.mod"])).toEqual(["go.mod"]);
  });
  test("Cargo.toml [patch] caps; dependency version bump does not", () => {
    const r = repo({ "Cargo.toml": '[package]\nname = "x"\n\n[dependencies]\na = "1"\n' });
    r.edit("Cargo.toml", '[package]\nname = "x"\n\n[dependencies]\na = "2"\n');
    expect(testConfigChanged(r.dir, r.base, ["Cargo.toml"])).toEqual([]);
    r.edit("Cargo.toml", '[package]\nname = "x"\n\n[dependencies]\na = "1"\n\n[patch.crates-io]\na = { path = "../fake" }\n');
    expect(testConfigChanged(r.dir, r.base, ["Cargo.toml"])).toEqual(["Cargo.toml"]);
  });
  test("tsconfig paths caps (JSONC tolerated); other compilerOptions do not", () => {
    const ts = (strict: boolean, paths: string): string => `{\n // c\n "compilerOptions": { "strict": ${strict}, "paths": { ${paths} }, },\n}\n`;
    const r = repo({ "tsconfig.json": ts(false, '"@/*": ["src/*"]') });
    r.edit("tsconfig.json", ts(true, '"@/*": ["src/*"]'));
    expect(testConfigChanged(r.dir, r.base, ["tsconfig.json"])).toEqual([]);
    r.edit("tsconfig.json", ts(false, '"@/*": ["mocks/*"]'));
    expect(testConfigChanged(r.dir, r.base, ["tsconfig.json"])).toEqual(["tsconfig.json"]);
  });
  test("pyproject [tool.pytest] caps; [project] edit does not", () => {
    const r = repo({ "pyproject.toml": '[project]\nname = "x"\n\n[tool.pytest.ini_options]\naddopts = "-q"\n' });
    r.edit("pyproject.toml", '[project]\nname = "y"\n\n[tool.pytest.ini_options]\naddopts = "-q"\n');
    expect(testConfigChanged(r.dir, r.base, ["pyproject.toml"])).toEqual([]);
    r.edit("pyproject.toml", '[project]\nname = "x"\n\n[tool.pytest.ini_options]\naddopts = "-q -k nothing"\n');
    expect(testConfigChanged(r.dir, r.base, ["pyproject.toml"])).toEqual(["pyproject.toml"]);
  });
  test("runner-only configs and non-config files", () => {
    expect(testConfigChanged(".", "HEAD", ["bunfig.toml", "sub/vitest.workspace.ts", "src/a.ts"])).toEqual(["bunfig.toml", "sub/vitest.workspace.ts"]);
  });
});

describe("FC-09r no weakening of the main line-keyword guard", () => {
  test.each([["mocha"], ["vitest"], ["ava"], ["nyc"], ["c8"]])("package.json %s key caps", (k) => {
    const r = repo({ "package.json": pkg({ test: "t" }) });
    r.edit("package.json", pkg({ test: "t" }, { [k]: { spec: "x" } }));
    expect(testConfigChanged(r.dir, r.base, ["package.json"])).toEqual(["package.json"]);
  });
  test.each([
    ["pyproject.toml", '[tool.hatch.envs.default.scripts]\ntest = "pytest"\n', '[tool.hatch.envs.default.scripts]\ntest = "pytest -k nothing"\n'],
    ["pyproject.toml", '[tool.poe.tasks]\nt = "echo"\n', '[tool.poe.tasks]\nt = "echo"\ntest = "pytest -k nothing"\n'],
    ["setup.cfg", "[aliases]\ntest=pytest\n", "[aliases]\ntest=pytest -k nothing\n"],
  ])("%s line naming a runner caps outside the pytest section", (f, a, b) => {
    const r = repo({ [f]: a });
    expect(testConfigChanged(r.dir, r.base, [f])).toEqual([]);
    r.edit(f, b);
    expect(testConfigChanged(r.dir, r.base, [f])).toEqual([f]);
  });
  test("pyproject metadata bump without a runner word does not cap", () => {
    const r = repo({ "pyproject.toml": '[project]\nversion = "1"\n' });
    r.edit("pyproject.toml", '[project]\nversion = "2"\n');
    expect(testConfigChanged(r.dir, r.base, ["pyproject.toml"])).toEqual([]);
  });
});

describe("FC-09r dependency swaps, tsconfig extends, section headers, subdir base", () => {
  const dev = (d: Record<string, string>): string => JSON.stringify({ scripts: { test: "t" }, devDependencies: d });
  test.each([
    ["jest file stub", { jest: "^29.0.0" }, { jest: "file:./fakejest" }],
    ["vitest npm alias", { vitest: "^1.0.0" }, { vitest: "npm:noop-vitest@1.0.0" }],
    ["non-runner key to link spec", { left: "1.0.0" }, { left: "link:../x" }],
  ])("%s caps", (_n, a, b) => {
    const r = repo({ "package.json": dev(a) });
    r.edit("package.json", dev(b));
    expect(testConfigChanged(r.dir, r.base, ["package.json"])).toEqual(["package.json"]);
  });
  test("plain non-runner dependency bump does not cap", () => {
    const r = repo({ "package.json": dev({ left: "1.0.0" }) });
    r.edit("package.json", dev({ left: "1.0.1" }));
    expect(testConfigChanged(r.dir, r.base, ["package.json"])).toEqual([]);
  });
  test("subdir base: repoDir under app/ reads base text through the ./ form", () => {
    const r = repo({ "app/package.json": dev({ left: "1.0.0" }) });
    const sub = join(r.dir, "app");
    r.edit("app/package.json", JSON.stringify({ scripts: { test: "changed" }, devDependencies: { left: "1.0.0" } }));
    expect(testConfigChanged(sub, r.base, ["package.json"])).toEqual(["package.json"]);
    r.edit("app/package.json", dev({ left: "1.0.0" }));
    r.edit("app/package.json", dev({ left: "1.0.1" }));
    expect(testConfigChanged(sub, r.base, ["package.json"])).toEqual([]);
  });
  test("tsconfig extends change caps", () => {
    const r = repo({ "tsconfig.json": '{"extends":"./a.json"}' });
    r.edit("tsconfig.json", '{"extends":"./b.json"}');
    expect(testConfigChanged(r.dir, r.base, ["tsconfig.json"])).toEqual(["tsconfig.json"]);
  });
  test("tsconfig rootDirs change caps", () => {
    const r = repo({ "tsconfig.json": '{"compilerOptions":{}}' });
    r.edit("tsconfig.json", '{"compilerOptions":{"rootDirs":["a","b"]}}');
    expect(testConfigChanged(r.dir, r.base, ["tsconfig.json"])).toEqual(["tsconfig.json"]);
  });
  test("array-valued line starting with [ does not end the pytest section", () => {
    const a = '[tool.pytest.ini_options]\nmarkers = [\n  "a",\n]\nfoo = 1\n';
    const r = repo({ "pyproject.toml": a });
    r.edit("pyproject.toml", a.replace("foo = 1", "foo = 2"));
    expect(testConfigChanged(r.dir, r.base, ["pyproject.toml"])).toEqual(["pyproject.toml"]);
  });
});

describe("FC-09s runner_config sibling sweep", () => {
  const CARGO = '[package]\nname = "x"\n\n[dependencies]\nserde = "1"\n\n[dev-dependencies]\ntokio = "1"\n\n[[test]]\nname = "it"\n';
  const capsOn = (f: string, base: string, head: string): string[] => { const r = repo({ [f]: base }); r.edit(f, head); return testConfigChanged(r.dir, r.base, [f]); };
  test("Cargo top-level dotted patch and replace keys before [package] cap", () => {
    expect(capsOn("Cargo.toml", CARGO, 'patch.crates-io.serde = { path = "fake" }\n' + CARGO)).toEqual(["Cargo.toml"]);
    expect(capsOn("Cargo.toml", CARGO, 'replace."serde:1.0.0" = { path = "fake" }\n' + CARGO)).toEqual(["Cargo.toml"]);
  });
  test("Cargo [[test]] harness=false and dev-dependencies path= cap; a plain version bump does not", () => {
    expect(capsOn("Cargo.toml", CARGO, CARGO.replace('name = "it"', 'name = "it"\nharness = false'))).toEqual(["Cargo.toml"]);
    expect(capsOn("Cargo.toml", CARGO, CARGO.replace('tokio = "1"', 'tokio = { path = "../fake" }'))).toEqual(["Cargo.toml"]);
    expect(capsOn("Cargo.toml", CARGO, CARGO.replace("[dependencies]", '[dev-dependencies.mock]\npath = "../m"\n\n[dependencies]'))).toEqual(["Cargo.toml"]);
    expect(capsOn("Cargo.toml", CARGO, CARGO.replace('serde = "1"', 'serde = "2"').replace('tokio = "1"', 'tokio = "2"'))).toEqual([]);
  });
  test("go.work replace directive caps; a comment edit does not", () => {
    const W = "go 1.21\n\nuse ./a\n";
    expect(capsOn("go.work", W, W + "replace example.com/x => ../fake\n")).toEqual(["go.work"]);
    expect(capsOn("go.work", W, W + "// note\n")).toEqual([]);
  });
  test.each([["babel.config.js"], ["babel.config.json"], [".babelrc"], [".babelrc.json"], [".pnpmfile.cjs"], ["sub/.pnpmfile.cjs"]])("%s edit caps", (f) => {
    const r = repo({ [f]: "a\n" });
    r.edit(f, "b\n");
    expect(testConfigChanged(r.dir, r.base, [f])).toEqual([f]);
  });
});
