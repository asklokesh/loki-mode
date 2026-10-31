// D86 FC-09r: runner-config changes cap the verdict; shared manifests are compared base vs head by section.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { commitStage, sealStage } from "../../src/engine10/stages/seal.ts";
import { RUNNER_CONFIGS, runnerConfigNotes, testConfigChanged } from "../../src/features/runner_config.ts";
import type { EventType, Receipt, RunContext, StageName } from "../../src/engine10/types.ts";

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

describe("FC-09t runner_config commented headers and path deps", () => {
  const CARGO = '[package]\nname = "x"\n\n[dependencies]\nserde = "1"\n\n[dev-dependencies]\ntokio = "1"\n\n[lib]\nname = "x"\n';
  const capsOn = (f: string, base: string, head: string): string[] => { const r = repo({ [f]: base }); r.edit(f, head); return testConfigChanged(r.dir, r.base, [f]); };
  test.each([
    ['[patch.crates-io] # local\nserde = { path = "f" }\n'],
    ['[ patch.crates-io ]\nserde = { path = "f" }\n'],
    ['[patch . crates-io]\nserde = { path = "f" }\n'],
  ])("patch header variant caps: %s", (add) => {
    expect(capsOn("Cargo.toml", CARGO, CARGO + "\n" + add)).toEqual(["Cargo.toml"]);
  });
  test("[dev-dependencies] # t with path= caps", () => {
    expect(capsOn("Cargo.toml", CARGO, CARGO.replace("[dev-dependencies]", "[dev-dependencies] # t").replace('tokio = "1"', 'tokio = { path = "../f" }'))).toEqual(["Cargo.toml"]);
  });
  test("[dependencies] and [workspace.dependencies] path= cap", () => {
    expect(capsOn("Cargo.toml", CARGO, CARGO.replace('serde = "1"', 'serde = { path = "../f" }'))).toEqual(["Cargo.toml"]);
    expect(capsOn("Cargo.toml", CARGO, CARGO + '\n[workspace.dependencies]\nfoo = { path = "../f" }\n')).toEqual(["Cargo.toml"]);
  });
  test("dev-dependency and [dependencies] git= cap", () => {
    expect(capsOn("Cargo.toml", CARGO, CARGO.replace('tokio = "1"', 'tokio = { git = "https://x/y" }'))).toEqual(["Cargo.toml"]);
    expect(capsOn("Cargo.toml", CARGO, CARGO.replace('serde = "1"', 'serde = { git = "https://x/y" }'))).toEqual(["Cargo.toml"]);
  });
  test("[[test]] path and [lib] test = false cap", () => {
    expect(capsOn("Cargo.toml", CARGO, CARGO + '\n[[test]]\nname = "it"\npath = "fake.rs"\n')).toEqual(["Cargo.toml"]);
    expect(capsOn("Cargo.toml", CARGO, CARGO.replace('[lib]\nname = "x"\n', '[lib]\nname = "x"\ntest = false\n'))).toEqual(["Cargo.toml"]);
  });
  test("comment-only edits and plain version bump do not cap", () => {
    expect(capsOn("Cargo.toml", CARGO, CARGO.replace("[dependencies]", "[dependencies] # deps").replace('serde = "1"', 'serde = "2" # bump'))).toEqual([]);
    expect(capsOn("Cargo.toml", CARGO, CARGO.replace('name = "x"\n\n[dep', 'name = "x"\nversion = "0.2.0"\n\n[dep'))).toEqual([]);
  });
  test("go.work use lines cap: single, block, newly created", () => {
    const W = "go 1.21\n\nuse ./a\n";
    expect(capsOn("go.work", W, W + "use ./x\n")).toEqual(["go.work"]);
    expect(capsOn("go.work", W, "go 1.21\n\nuse (\n\t./a\n\t./x\n)\n")).toEqual(["go.work"]);
    const r = repo({ "README.md": "x\n" });
    r.edit("go.work", "use ./x\n");
    expect(testConfigChanged(r.dir, r.base, ["go.work"])).toEqual(["go.work"]);
  });
  test("go.work go directive bump and package.json version bump do not cap", () => {
    const W = "go 1.21\n\nuse ./a\n";
    expect(capsOn("go.work", W, W.replace("1.21", "1.22"))).toEqual([]);
    expect(capsOn("package.json", '{"version":"1.0.0"}', '{"version":"1.0.1"}')).toEqual([]);
  });
  test(".pnpmfile.mjs edit caps", () => {
    expect(capsOn(".pnpmfile.mjs", "a\n", "b\n")).toEqual([".pnpmfile.mjs"]);
  });
});

describe("FC-09t r2 Cargo dotted-key paths", () => {
  const CARGO = '[package]\nname = "x"\n\n[dependencies]\nserde = "1"\n\n[dev-dependencies]\ntokio = "1"\n\n[lib]\nname = "x"\n';
  const capsOn = (f: string, base: string, head: string): string[] => { const r = repo({ [f]: base }); r.edit(f, head); return testConfigChanged(r.dir, r.base, [f]); };
  test.each([
    ["dotted dependencies under [workspace]", '[workspace]\ndependencies.serde = { path = "../s" }\n'],
    ["dotted dev-dependencies under [target.cfg]", "[target.'cfg(unix)']\ndev-dependencies.serde = { path = \"../s\" }\n"],
    ["top-level dotted target dependencies", "target.'cfg(unix)'.dependencies.serde = { path = \"../s\" }\n"],
    ["top-level lib.test = false", "lib.test = false\n"],
    ["top-level lib inline table", "lib = { test = false }\n"],
    ["top-level inline test array", 'test = [{ name = "t", path = "tests/fake.rs", harness = false }]\n'],
    ["[ workspace . dependencies ] path dep", '[ workspace . dependencies ]\nfoo = { path = "../f" }\n'],
    ["dev-dependency package rename", '[dev-dependencies]\ntokio = { package = "other", version = "1" }\n'],
    ["dev-dependency registry", '[dev-dependencies]\ntokio = { registry = "r", version = "1" }\n'],
    ["[build-dependencies] path", '[build-dependencies]\ncc = { path = "../cc" }\n'],
  ])("%s caps", (_n, add) => {
    expect(capsOn("Cargo.toml", CARGO, add + "\n" + CARGO)).toEqual(["Cargo.toml"]);
  });
  test("dotted dependency version entry does not cap", () => {
    expect(capsOn("Cargo.toml", CARGO, '[workspace]\ndependencies.serde = "2"\n\n' + CARGO)).toEqual([]);
  });
  test("go.work use block gains an entry", () => {
    const B = "go 1.21\n\nuse (\n\t./a\n)\n";
    expect(capsOn("go.work", B, B.replace("\t./a\n", "\t./a\n\t./x\n"))).toEqual(["go.work"]);
  });
});

describe("FC-09t r3 Cargo multi-line, nested inline and legacy sections", () => {
  const CARGO = '[package]\nname = "x"\n\n[dependencies]\nserde = "1"\n\n[dev-dependencies]\ntokio = "1"\n\n[lib]\nname = "x"\n';
  const capsOn = (f: string, base: string, head: string): string[] => { const r = repo({ [f]: base }); r.edit(f, head); return testConfigChanged(r.dir, r.base, [f]); };
  const ML = (h: string, p = "tests/it.rs"): string => `test = [\n  { name = "it", path = "${p}", harness = ${h} },\n]\n`;
  test("multi-line test array harness and path flips cap", () => {
    expect(capsOn("Cargo.toml", ML("true") + CARGO, ML("false") + CARGO)).toEqual(["Cargo.toml"]);
    expect(capsOn("Cargo.toml", ML("true") + CARGO, ML("true", "tests/fake.rs") + CARGO)).toEqual(["Cargo.toml"]);
  });
  test.each([
    ["target inline", 'target = { "cfg(unix)" = { dev-dependencies = { x = { path = ".." } } } }\n'],
    ["target section then inline", '[target]\n"cfg(unix)" = { dev-dependencies = { x = { path = ".." } } }\n'],
    ["workspace inline", 'workspace = { dependencies = { x = { path = ".." } } }\n'],
    ["multi-line workspace inline", 'workspace = {\n  dependencies = {\n    x = { path = ".." },\n  },\n}\n'],
    ["dev_dependencies", '[dev_dependencies]\nfoo = { path = "../evil" }\n'],
    ["build_dependencies", '[build_dependencies]\nfoo = { path = "../evil" }\n'],
    ["autotests false", "[package]\nautotests = false\n"],
    ["lib harness false", "[lib]\nharness = false\n"],
    ["test test false", '[[test]]\nname = "it"\ntest = false\n'],
    ["test required-features", '[[test]]\nname = "it"\nrequired-features = ["nope"]\n'],
    ["lib doctest false", "[lib]\ndoctest = false\n"],
    ["lib path", '[lib]\npath = "src/fake.rs"\n'],
    ["bin test false", '[[bin]]\nname = "b"\ntest = false\n'],
  ])("%s caps", (_n, add) => {
    expect(capsOn("Cargo.toml", CARGO, add + "\n" + CARGO)).toEqual(["Cargo.toml"]);
  });
  test("false positives stay uncapped", () => {
    const H = ML("true") + CARGO;
    expect(capsOn("Cargo.toml", H, H + "# note\n")).toEqual([]);
    expect(capsOn("Cargo.toml", CARGO, CARGO.replace('serde = "1"', 'serde = { version = "2", features = ["a"] }').replace('tokio = "1"', 'tokio = { version = "2", features = ["rt"] }'))).toEqual([]);
    expect(capsOn("Cargo.toml", CARGO, CARGO.replace('name = "x"\n\n[dep', 'name = "y"\ndescription = """\nmulti [ line {\n"""\n\n[dep') + '\n[features]\ndefault = ["a"]\n')).toEqual([]);
  });
});

describe("FC-09t r4 one TOML scanner, escape-decoded keys, empty sides", () => {
  const CARGO = '[package]\nname = "x"\n\n[dependencies]\nserde = "1"\n\n[dev-dependencies]\ntokio = "1"\n\n[lib]\nname = "x"\n';
  const capsOn = (base: string, head: string): string[] => { const r = repo({ "Cargo.toml": base }); r.edit("Cargo.toml", head); return testConfigChanged(r.dir, r.base, ["Cargo.toml"]); };
  const DEV = (desc: string, dep: string): string => `[package]\nname = "x"\n${desc}\n\n[dev-dependencies]\nserde = ${dep}\n# """\n`;
  test.each([
    ["basic ml with inner quote and hash", 'description = """ab"c # x"""'],
    ["literal ml with apostrophe and hash", "description = '''it's a # thing'''"],
  ])("string then comment-looking text: %s", (_n, desc) => {
    expect(capsOn(DEV(desc, '"1"'), DEV(desc, '{ path = "../serde" }'))).toEqual(["Cargo.toml"]);
    expect(capsOn(DEV(desc, '"1"'), DEV(desc, '"2"'))).toEqual([]);
  });
  test("closing triple quote followed by a comment does not cap", () => {
    expect(capsOn(CARGO, CARGO.replace('name = "x"\n\n[dep', 'name = "x"\ndescription = """\nabc\n""" # c\n\n[dep'))).toEqual([]);
    expect(capsOn(CARGO, CARGO.replace('name = "x"\n\n[dep', 'name = "x"\ndescription = """ab""""\n\n[dep'))).toEqual([]);
  });
  test.each([
    ['["dev-dependencies"]'], ["['dev-dependencies']"], ['["dev\\u002ddependencies"]'], ['["dev\\U0000002ddependencies"]'], ['[ "dev-dependencies" ]'],
    ['["dev-dependencies".x]'], ['["patch".crates-io]'], ['["dev\\qdeps"]'],
  ])("quoted header %s caps", (h) => {
    expect(capsOn(CARGO, CARGO + `\n${h}\nserde = { path = "../serde" }\n`)).toEqual(["Cargo.toml"]);
  });
  test("quoted header version bump does not cap", () => {
    const q = (v: string): string => CARGO + `\n["dev-dependencies"]\nserde = ${v}\n`;
    expect(capsOn(q('"1"'), q('"2"'))).toEqual([]);
  });
  test("quoted dotted key in a section caps", () => {
    expect(capsOn(CARGO, CARGO.replace('tokio = "1"', '"tokio" = { "path" = "../f" }'))).toEqual(["Cargo.toml"]);
  });
  test.each([
    ["profile.test", "[profile.test]\nopt-level = 1\n"], ["profile.dev debug-assertions", "[profile.dev]\ndebug-assertions = false\n"],
    ["profile.release overflow-checks", "[profile.release]\noverflow-checks = false\n"], ["workspace members", '[workspace]\nmembers = ["a"]\n'],
    ["workspace default-members", '[workspace]\ndefault-members = ["a"]\n'], ["workspace exclude", '[workspace]\nexclude = ["a"]\n'],
  ])("advisory key %s caps", (_n, add) => {
    expect(capsOn(CARGO, CARGO + "\n" + add)).toEqual(["Cargo.toml"]);
  });
  test("package build caps", () => {
    expect(capsOn(CARGO, CARGO.replace('name = "x"\n', 'name = "x"\nbuild = "fake.rs"\n'))).toEqual(["Cargo.toml"]);
  });
  test("profile.release opt-level does not cap", () => {
    expect(capsOn(CARGO, CARGO + "\n[profile.release]\nopt-level = 3\n")).toEqual([]);
  });
  test("datetime with a space parses and does not cap", () => {
    expect(capsOn(CARGO, "d = 1979-05-27 07:32:00\n" + CARGO)).toEqual([]);
    expect(capsOn(CARGO, "d = 1979-05-27 07:32:00.5Z\ne = 1979-05-27T07:32:00-08:00\n" + CARGO)).toEqual([]);
  });
  const sideCaps = (base: string | null, head: string | null): string[] => {
    const r = repo(base === null ? { README: "x" } : { "Cargo.toml": base });
    if (head === null) rmSync(join(r.dir, "Cargo.toml")); else r.edit("Cargo.toml", head);
    return testConfigChanged(r.dir, r.base, ["Cargo.toml"]);
  };
  test("added or deleted Cargo.toml parses the empty side as an empty document", () => {
    expect(sideCaps(null, CARGO)).toEqual([]);
    expect(sideCaps(CARGO, null)).toEqual([]);
    expect(sideCaps(null, CARGO.replace('tokio = "1"', 'tokio = { path = "../f" }'))).toEqual(["Cargo.toml"]);
    expect(sideCaps(null, '[package]\nname = "x"\nautotests = false\n')).toEqual(["Cargo.toml"]);
    expect(sideCaps(CARGO.replace('tokio = "1"', 'tokio = { path = "../f" }'), null)).toEqual(["Cargo.toml"]);
  });
});

describe("FC-09t r5 target keys and dependency sources", () => {
  const CARGO = '[package]\nname = "x"\n\n[dependencies]\nserde = "1"\n\n[dev-dependencies]\ntokio = "1"\n';
  const B = CARGO + '\n[[bin]]\nname = "a"\npath = "src/main.rs"\n';
  const capsOn = (base: string, head: string): string[] => { const r = repo({ "Cargo.toml": base }); r.edit("Cargo.toml", head); return testConfigChanged(r.dir, r.base, ["Cargo.toml"]); };
  test.each([
    ["bin harness=false", B, B.replace('name = "a"', 'name = "b"\nharness = false')],
    ["bin required-features", B, B.replace('name = "a"', 'name = "a"\nrequired-features = ["never"]')],
    ["bin path change", B, B.replace("src/main.rs", "src/fake.rs")],
    ["bench harness", CARGO, CARGO + '\n[[bench]]\nname = "b"\nharness = false\n'],
    ["example path", CARGO, CARGO + '\n[[example]]\nname = "e"\npath = "x.rs"\n'],
    ["normal dep git", CARGO, CARGO.replace('serde = "1"', 'serde = { git = "file:///tmp/fake" }')],
    ["normal dep package", CARGO, CARGO.replace('serde = "1"', 'serde = { version = "1", package = "evil" }')],
    ["dep workspace=true", CARGO, CARGO.replace('serde = "1"', 'serde = { workspace = true }')],
    ["package.workspace", CARGO, CARGO.replace('name = "x"', 'name = "x"\nworkspace = "../other"')],
  ])("%s caps", (_n, base, head) => {
    expect(capsOn(base, head)).toEqual(["Cargo.toml"]);
  });
  test.each(["rev", "branch", "tag"])("dev-dependency git %s change caps", (k) => {
    const g = (v: string): string => CARGO.replace('tokio = "1"', `tokio = { git = "https://x/y", ${k} = "${v}" }`);
    expect(capsOn(g("a"), g("b"))).toEqual(["Cargo.toml"]);
  });
  test("version bump, bin name, description, keywords, features do not cap", () => {
    expect(capsOn(CARGO, CARGO.replace('serde = "1"', 'serde = { version = "2", features = ["x"] }'))).toEqual([]);
    expect(capsOn(B, B.replace('name = "a"', 'name = "c"'))).toEqual([]);
    expect(capsOn(CARGO, CARGO.replace('name = "x"', 'name = "x"\ndescription = "d"\nkeywords = ["k"]'))).toEqual([]);
    expect(capsOn(CARGO, CARGO + '\n[features]\nf = []\n')).toEqual([]);
  });
});

// FC-09 seal side: a run that edits a runner config, or a file one loads, cannot seal VERIFIED. Real commit + seal stages on a temp repo.
const SBASE = { "calc.ts": "export const add = (a: number, b: number) => a + b;\n", "calc.test.ts": "import { add } from './calc';\n" };
function sealRepo(baseFiles: Record<string, string>, edits: Record<string, string>, baseLinks: Record<string, string> = {}): { repo: string; base: string } {
  const repo = mkdtempSync(join(tmpdir(), "rcs-")); dirs.push(repo);
  const put = (files: Record<string, string>): void => { for (const [f, t] of Object.entries(files)) { mkdirSync(dirname(join(repo, f)), { recursive: true }); writeFileSync(join(repo, f), t); } };
  sh(repo, ["init", "-q", "-b", "main"]); put({ ...SBASE, ...baseFiles });
  for (const [l, t] of Object.entries(baseLinks)) symlinkSync(t, join(repo, l));
  sh(repo, ["add", "."]); sh(repo, ["commit", "-qm", "base"]);
  const base = sh(repo, ["rev-parse", "HEAD"]);
  put({ "calc.ts": "export const add = (a: number, b: number) => a - b;\n", ...edits });
  put({ ".loki/runs/r1/events.jsonl": JSON.stringify({ v: 1, seq: 0, ts: "2026-01-01T00:00:00.000Z", run: "r1", type: "run.started", stage: null, data: {} }) + "\n" });
  return { repo, base };
}
function sealCtx(repo: string, base: string, over: Partial<Record<StageName, Record<string, unknown>>> = {}): RunContext {
  const outputs: Partial<Record<StageName, Record<string, unknown>>> = {
    intake: { source: "text", task_sha256: "ab".repeat(32), repo: "o/r", title: "fix", resumed: false },
    wall: { files: [] },
    implement: { exit: "done", tests_reverted: [], duration_s: 3, iteration_id: "e10-r1-impl" },
    verify: { checks: [{ name: "bun test:calc.test.ts", cmd: "bun test", result: "pass", duration_s: 1, n: 1 }], flaky: [], wall_passed: true, duration_s: 2 },
    ...over,
  };
  return {
    runId: "r1", repoDir: repo, runDir: join(repo, ".loki/runs/r1"), baseSha: base, branch: "loki/r1", provider: "claude", model: "m", deep: false, capS: 900,
    emit: (_t: EventType) => {}, sessions: { run: async () => { throw new Error("none"); } },
    tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] },
    cost: { read: () => ({ usd: null, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 }) }, clock: { now: () => 0 }, outputs: () => outputs,
  };
}
type SealOpt = { links?: Record<string, string>; wallFile?: { path: string; text: string }; wallN?: number; notProven?: string[]; planFiles?: string[]; baseLinks?: Record<string, string> };
async function sealRun(baseFiles: Record<string, string>, edits: Record<string, string>, opt: SealOpt = {}): Promise<Receipt> {
  process.env["LOKI_RECEIPT_SIGNING_KEY"] = ""; process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = join(tmpdir(), "rcs-nokey", "k.pem");
  const { repo, base } = sealRepo(baseFiles, edits, opt.baseLinks);
  for (const [l, t] of Object.entries(opt.links ?? {})) { mkdirSync(dirname(join(repo, l)), { recursive: true }); symlinkSync(t, join(repo, l)); }
  const w = opt.wallFile, runDir = join(repo, ".loki/runs/r1");
  if (w) { mkdirSync(join(runDir, "wall"), { recursive: true }); writeFileSync(join(runDir, "wall", basename(w.path)), w.text); }
  if (opt.planFiles) writeFileSync(join(runDir, "plan-scope.json"), JSON.stringify({ files: opt.planFiles }));
  const over: Partial<Record<StageName, Record<string, unknown>>> = {};
  if (w) { over.wall = { files: [{ path: w.path, sha256: "ab".repeat(32) }] }; over.verify = { checks: [{ name: "bun test:calc.test.ts", cmd: "bun test", result: "pass", duration_s: 1, n: 1 }, { name: `bun test:${w.path}`, cmd: `bun test ${w.path}`, result: "pass", duration_s: 1, n: opt.wallN ?? 4 }], flaky: [], wall_passed: true, duration_s: 2, not_proven: opt.notProven ?? [] }; }
  const ctx = sealCtx(repo, base, over);
  await commitStage.run(ctx, new AbortController().signal);
  const s = await sealStage.run(ctx, new AbortController().signal);
  const rr = JSON.parse(readFileSync(s.data.receipt_path as string, "utf8")) as Receipt; return rr;
}
const cappedOn = (r: Receipt, file: string): void => {
  expect(["PARTIAL", "NOT PROVEN"]).toContain(r.verdict);
  expect(r.not_proven.some((n) => n.includes(file) && /runner (config|setup file)/.test(n))).toBe(true);
};
describe("FC-09 seal caps a run that touches runner config", () => {
  test("control: a clean run still seals VERIFIED", async () => {
    const r = await sealRun({ "bunfig.toml": "[test]\n" }, { "notes.txt": "x\n" });
    expect(r.verdict).toBe("VERIFIED");
    expect(r.not_proven.some((n) => /runner (config|setup file)/.test(n))).toBe(false);
  }, 30000);
  test("bun: bunfig.toml preloads a new setup.ts", async () => {
    const r = await sealRun({ "bunfig.toml": "[test]\n" }, { "bunfig.toml": '[test]\npreload = ["./setup.ts"]\n', "setup.ts": "// mock\n" });
    cappedOn(r, "bunfig.toml"); cappedOn(r, "setup.ts");
  }, 30000);
  test("vitest: an already-listed setupFiles entry is edited", async () => {
    cappedOn(await sealRun({ "vitest.config.ts": "export default { test: { setupFiles: ['./test/setup.ts'] } };\n", "test/setup.ts": "// empty\n" }, { "test/setup.ts": "vi.mock('../calc');\n" }), "test/setup.ts");
  }, 30000);
  test("jest: moduleNameMapper retargets at a new stub", async () => {
    const r = await sealRun({ "package.json": '{"name":"x","jest":{"testEnvironment":"node"}}\n' }, { "package.json": '{"name":"x","jest":{"testEnvironment":"node","moduleNameMapper":{"^./calc$":"<rootDir>/stub.js"}}}\n', "stub.js": "module.exports = {};\n" });
    cappedOn(r, "package.json"); cappedOn(r, "stub.js");
  }, 30000);
  test("jest: <rootDir> is the config folder in a monorepo package", async () => {
    cappedOn(await sealRun({ "packages/foo/jest.config.js": "module.exports = { setupFiles: ['<rootDir>/setup.js'] };\n", "packages/foo/setup.js": "// e\n" }, { "packages/foo/setup.js": "jest.mock('x');\n" }), "packages/foo/setup.js");
  }, 30000);
  test("jest: explicit rootDir fails closed", async () => {
    cappedOn(await sealRun({ "cfg/jest.config.js": "module.exports = { rootDir: '..', setupFiles: ['<rootDir>/setup.js'] };\n", "setup.js": "// e\n" }, { "setup.js": "jest.mock('./calc');\n" }), "setup.js");
  }, 30000);
  test("pytest: a new conftest.py caps", async () => {
    cappedOn(await sealRun({}, { "tests/conftest.py": "import calc\n" }), "tests/conftest.py");
  }, 30000);
  test("__mocks__: added and edited mocks cap", async () => {
    cappedOn(await sealRun({}, { "src/__mocks__/calc.ts": "export const add = () => 3;\n" }), "src/__mocks__/calc.ts");
    cappedOn(await sealRun({ "src/__mocks__/calc.ts": "export const add = () => 1;\n" }, { "src/__mocks__/calc.ts": "export const add = () => 3;\n" }), "src/__mocks__/calc.ts");
  }, 60000);
  test("vitest.workspace: inline setupFiles in an added workspace caps", async () => {
    cappedOn(await sealRun({}, { "vitest.workspace.ts": "export default [{ test: { setupFiles: ['./setup.ts'] } }];\n", "setup.ts": "//\n" }), "vitest.workspace.ts");
  }, 30000);
  test("package.json pretest edit caps the seal verdict", async () => {
    const pk = (s: Record<string, string>): string => JSON.stringify({ name: "x", scripts: s }) + "\n";
    cappedOn(await sealRun({ "package.json": pk({ test: "bun test" }) }, { "package.json": pk({ test: "bun test", pretest: "node mock.js" }) }), "package.json");
  }, 30000);
  test("an unchanged malformed package.json does not cap; a changed one is reported unparseable", async () => {
    const r = await sealRun({ "fixtures/bad/package.json": "{ not json" }, { "notes.txt": "x\n" });
    expect(r.verdict).toBe("VERIFIED");
    const { repo, base } = sealRepo({ "package.json": "{ not json" }, { "package.json": "{ still not json" });
    sh(repo, ["add", "package.json"]); sh(repo, ["commit", "-qm", "c"]);
    expect(runnerConfigNotes(repo, base, sh(repo, ["rev-parse", "HEAD"]), ["package.json"]).join("\n")).toContain("unparseable");
  }, 30000);
  test("LOST-1b: an unchanged unparseable config caps when a non-test file in its tree changed", () => {
    const { repo, base } = sealRepo({ "package.json": "{ not json" }, { "src/helper.ts": "export {};\n", "calc.test.ts": "// t\n" });
    sh(repo, ["add", "src/helper.ts", "calc.test.ts", "calc.ts"]); sh(repo, ["commit", "-qm", "c"]);
    const head = sh(repo, ["rev-parse", "HEAD"]);
    expect(runnerConfigNotes(repo, base, head, ["src/helper.ts"]).join("\n")).toContain("runner config unparseable");
    expect(runnerConfigNotes(repo, base, head, ["calc.test.ts"])).toEqual([]);
  }, 30000);
  test("LOST-1b: an unchanged unparseable config in a subtree ignores changes elsewhere", () => {
    const { repo, base } = sealRepo({ "fixtures/bad/package.json": "{ not json" }, { "src/helper.ts": "export {};\n" });
    sh(repo, ["add", "src/helper.ts"]); sh(repo, ["commit", "-qm", "c"]);
    expect(runnerConfigNotes(repo, base, sh(repo, ["rev-parse", "HEAD"]), ["src/helper.ts"])).toEqual([]);
  }, 30000);
  test("LOST-1b: an unchanged config blob is read once, not twice", () => {
    const { repo, base } = sealRepo({ "bunfig.toml": "[test]\n" }, { "notes.txt": "x\n" });
    sh(repo, ["add", "notes.txt"]); sh(repo, ["commit", "-qm", "c"]);
    const bin = mkdtempSync(join(tmpdir(), "rcbin-")); dirs.push(bin);
    const log = join(bin, "log"), real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$@" >> ${log}\nexec ${real} "$@"\n`, { mode: 0o755 });
    const old = process.env["PATH"]; process.env["PATH"] = `${bin}:${old}`;
    try { runnerConfigNotes(repo, base, sh(repo, ["rev-parse", "HEAD"]), ["notes.txt"]); } finally { process.env["PATH"] = old; }
    expect((readFileSync(log, "utf8").match(/show .*:bunfig\.toml/g) ?? []).length).toBe(1);
  }, 30000);
  test("a package.json change outside runner sections is not runner config", () => {
    const { repo, base } = sealRepo({ "package.json": '{"name":"x","jest":{}}\n' }, { "package.json": '{"name":"x","version":"2","jest":{}}\n' });
    sh(repo, ["add", "package.json"]); sh(repo, ["commit", "-qm", "c"]);
    expect(runnerConfigNotes(repo, base, sh(repo, ["rev-parse", "HEAD"]), ["package.json"])).toEqual([]);
  });
});

describe("FC-09u pnpm-workspace and yarnrc key-level caps", () => {
  const PNPM = 'packages:\n  - "pkgs/*"\n\noverrides:\n  foo: 1.0.0\n\npackageExtensions:\n  bar@1:\n    dependencies:\n      baz: "*"\n';
  const YARN = 'nodeLinker: node-modules\n\npackageExtensions:\n  bar@1:\n    dependencies:\n      baz: "*"\n';
  const capsOn = (f: string, base: string, head: string): string[] => { const r = repo({ [f]: base }); r.edit(f, head); return testConfigChanged(r.dir, r.base, [f]); };
  test("pnpm-workspace.yaml overrides edit caps", () => {
    expect(capsOn("pnpm-workspace.yaml", PNPM, PNPM.replace("foo: 1.0.0", "foo: link:../fake"))).toEqual(["pnpm-workspace.yaml"]);
  });
  test("pnpm-workspace.yaml packageExtensions edit caps", () => {
    expect(capsOn("pnpm-workspace.yaml", PNPM, PNPM.replace('baz: "*"', 'qux: "*"'))).toEqual(["pnpm-workspace.yaml"]);
  });
  test(".yarnrc.yml packageExtensions edit caps", () => {
    expect(capsOn(".yarnrc.yml", YARN, YARN.replace('baz: "*"', 'qux: "*"'))).toEqual([".yarnrc.yml"]);
  });
  test("a new overrides or packageExtensions block caps, including quoted keys and nested paths", () => {
    expect(capsOn("pnpm-workspace.yaml", 'packages:\n  - "a"\n', 'packages:\n  - "a"\noverrides:\n  x: 1\n')).toEqual(["pnpm-workspace.yaml"]);
    expect(capsOn("sub/.yarnrc.yml", "nodeLinker: pnp\n", 'nodeLinker: pnp\n"packageExtensions": { a@1: {} }\n')).toEqual(["sub/.yarnrc.yml"]);
  });
  // D101 fail-closed: YAML runner configs are never compared as parsed values (Bun.YAML and js-yaml 4 disagree), so even an unrelated or comment-only edit caps.
  test("any byte change caps, including a comment-only or unrelated edit", () => {
    expect(capsOn("pnpm-workspace.yaml", PNPM, PNPM.replace('"pkgs/*"', '"other/*"'))).toEqual(["pnpm-workspace.yaml"]);
    expect(capsOn("pnpm-workspace.yaml", PNPM, "# note\n" + PNPM)).toEqual(["pnpm-workspace.yaml"]);
    expect(capsOn(".yarnrc.yml", YARN, YARN.replace("node-modules", "pnp"))).toEqual([".yarnrc.yml"]);
  });
  test("a byte-identical YAML config does not cap", () => {
    const r = repo({ "pnpm-workspace.yaml": PNPM, "x.txt": "1" });
    r.edit("x.txt", "2"); sh(r.dir, ["add", "."]); sh(r.dir, ["commit", "-qm", "c"]);
    expect(runnerConfigNotes(r.dir, r.base, sh(r.dir, ["rev-parse", "HEAD"]), ["x.txt"])).toEqual([]);
  });
  test.each([
    ["block scalar on its own line", "x:\n  foo\npackages: [a]\n", "x:\n  |\noverrides:\n  foo: link:./fake\n"],
    ["folded scalar after comment", "x: 1\n", "x: #\n  >\noverrides:\n  foo: link:./fake\n"],
    ["1_000 number", "overrides:\n  foo: 1_000\n", "overrides:\n  foo: link:./fake\n"],
    ["timestamp", "x: 2001-12-14\n", "x: 2001-12-14t21:59:43.10-05:00\noverrides:\n  foo: link:./fake\n"],
    ["indentation indicator", "x: 1\n", "x: |2\n    a\noverrides:\n  foo: link:./fake\n"],
  ])("FC-09v r2 pnpm-workspace.yaml parser-disagreement case caps: %s", (_n, a, b) => {
    expect(capsOn("pnpm-workspace.yaml", a, b)).toEqual(["pnpm-workspace.yaml"]);
  });
  test("a changed, added or deleted patch file caps", () => {
    expect(capsOn("patches/foo.patch", "a\n", "b\n")).toEqual(["patches/foo.patch"]);
    expect(capsOn("sub/patches/foo.diff", "a\n", "b\n")).toEqual(["sub/patches/foo.diff"]);
    expect(capsOn("x.patch", "a\n", "b\n")).toEqual(["x.patch"]);
    const r = repo({ "patches/foo.patch": "a\n", "k": "1" });
    r.edit("patches/foo.patch", "b\n"); sh(r.dir, ["add", "."]); sh(r.dir, ["commit", "-qm", "c"]);
    expect(runnerConfigNotes(r.dir, r.base, sh(r.dir, ["rev-parse", "HEAD"]), ["patches/foo.patch"]).length).toBe(1);
  });
  test.each([
    ["explicit key", "packages: [a]\n? overrides\n: {foo: 1.0.0}\n", "packages: [a]\n? overrides\n: {foo: link:../fake}\n"],
    ["BOM", "\uFEFFoverrides:\n  foo: 1.0.0\n", "\uFEFFoverrides:\n  foo: link:../fake\n"],
    ["escaped key", '"overrides":\n  foo: 1.0.0\n', '"overrides":\n  foo: link:../fake\n'],
    ["escaped unicode key", '"\\u006fverrides":\n  foo: 1.0.0\n', '"\\u006fverrides":\n  foo: link:../fake\n'],
    ["flow map", "{packages: [a], overrides: {foo: 1.0.0}}\n", "{packages: [a], overrides: {foo: link:../fake}}\n"],
    ["anchor body", "x-base: &o {foo: 1.0.0}\noverrides: *o\n", "x-base: &o {foo: link:../fake}\noverrides: *o\n"],
    ["merge key", "x-base: &o {foo: 1.0.0}\noverrides:\n  <<: *o\n", "x-base: &o {foo: link:../fake}\noverrides:\n  <<: *o\n"],
    ["bare CR", "packages: [a]\roverrides:\r  foo: 1.0.0\r", "packages: [a]\roverrides:\r  foo: link:../fake\r"],
  ])("pnpm-workspace.yaml bypass caps: %s", (_n, a, b) => {
    expect(capsOn("pnpm-workspace.yaml", a, b)).toEqual(["pnpm-workspace.yaml"]);
  });
  test.each([
    ["double BOM", "\uFEFF\uFEFFoverrides:\n  foo: 1.0.0\n", "\uFEFF\uFEFFoverrides:\n  foo: link:./fake\n"],
    ["collection key", "packages: [a]\n? [foo]\n: 1.0.0\n", "packages: [a]\n? [foo]\n: link:./fake\n"],
    ["quoted merge key", 'x: &o {foo: 1.0.0}\noverrides:\n  "<<": *o\n', 'x: &o {foo: link:./fake}\noverrides:\n  "<<": *o\n'],
    ["alias in overrides", "x: &o 1.0.0\noverrides:\n  foo: *o\n", "x: &o link:./fake\noverrides:\n  foo: *o\n"],
    ["CR only", "overrides:\r  foo: 1.0.0\r", "overrides:\r  foo: link:./fake\r"],
    ["tab", "packages: [a]\toverrides: {foo: 1.0.0}\n", "packages: [a]\toverrides: {foo: link:./fake}\n"],
    ["tag", "overrides: !!map\n  foo: 1.0.0\n", "overrides: !!map\n  foo: link:./fake\n"],
    ["document marker", "---\noverrides:\n  foo: 1.0.0\n", "---\noverrides:\n  foo: link:./fake\n"],
  ])("FC-09v pnpm-workspace.yaml outside the strict subset caps: %s", (_n, a, b) => {
    expect(capsOn("pnpm-workspace.yaml", a, b)).toEqual(["pnpm-workspace.yaml"]);
  });
  test("malformed YAML that changed fails closed", () => {
    expect(capsOn("pnpm-workspace.yaml", "packages: [a]\n", "packages: [a\noverrides: {\n")).toEqual(["pnpm-workspace.yaml"]);
  });
  test.each([["patchedDependencies", "a@1: p.patch"], ["catalog", "a: 1"], ["catalogs", "x: {a: 1}"]])("pnpm-workspace.yaml %s edit caps", (k, v) => {
    expect(capsOn("pnpm-workspace.yaml", "packages: [a]\n", `packages: [a]\n${k}:\n  ${v}\n`)).toEqual(["pnpm-workspace.yaml"]);
  });
  test.each([["yarnPath", ".yarn/releases/fake.cjs"], ["plugins", "[./fake.cjs]"]])(".yarnrc.yml %s edit caps", (k, v) => {
    expect(capsOn(".yarnrc.yml", YARN, `${YARN}${k}: ${v}\n`)).toEqual([".yarnrc.yml"]);
  });
  test("runnerConfigNotes caps any edit", () => {
    const r = repo({ "pnpm-workspace.yaml": PNPM });
    r.edit("pnpm-workspace.yaml", PNPM.replace("foo: 1.0.0", "foo: 2.0.0")); sh(r.dir, ["add", "."]); sh(r.dir, ["commit", "-qm", "c"]);
    expect(runnerConfigNotes(r.dir, r.base, sh(r.dir, ["rev-parse", "HEAD"]), ["pnpm-workspace.yaml"]).length).toBe(1);
    r.edit("pnpm-workspace.yaml", PNPM.replace("foo: 1.0.0", "foo: 2.0.0").replace('"pkgs/*"', '"z/*"')); sh(r.dir, ["add", "."]); sh(r.dir, ["commit", "-qm", "d"]);
    expect(runnerConfigNotes(r.dir, sh(r.dir, ["rev-parse", "HEAD~1"]), sh(r.dir, ["rev-parse", "HEAD"]), ["pnpm-workspace.yaml"]).length).toBe(1);
  });
});

describe("FC-09w case-insensitive registry, .npmrc, patchedDependencies targets", () => {
  const NAMES = ["PNPM-Workspace.yaml", ".YARNRC.yml", "Jest.Config.js", "VITEST.config.ts", "Bunfig.TOML", "ConfTest.py", "Tox.INI", "PyTest.ini", ".Mocharc.json", ".CARGO/Config.toml", "Babel.Config.js", ".PnpmFile.cjs", "Patches/a.diff", "x.PATCH", ".NPMRC", "sub/.Npmrc"];
  const commit = (d: string, m: string): string => { sh(d, ["add", "."]); sh(d, ["commit", "-qm", m]); return sh(d, ["rev-parse", "HEAD"]); };
  test.each(NAMES.map((n) => [n]))("capitalized %s: edit caps in both entry points", (f) => {
    const r = repo({ [f]: "a = 1\n", "x.txt": "1" });
    r.edit(f, "a = 2\n");
    expect(testConfigChanged(r.dir, r.base, [f])).toEqual([f]);
    const head = commit(r.dir, "e");
    expect(runnerConfigNotes(r.dir, r.base, head, [f]).length).toBe(1);
  });
  test.each(NAMES.map((n) => [n]))("capitalized %s: add caps in both entry points", (f) => {
    const r = repo({ "x.txt": "1" });
    r.edit(f, "a = 1\n");
    expect(testConfigChanged(r.dir, r.base, [f])).toEqual([f]);
    const head = commit(r.dir, "a");
    expect(runnerConfigNotes(r.dir, r.base, head, [f]).length).toBe(1);
  });
  test("capitalized shared manifest compares by section, not by bytes", () => {
    const r = repo({ "Package.JSON": pkg({ test: "t" }, { version: "1" }) });
    r.edit("Package.JSON", pkg({ test: "t" }, { version: "2" }));
    expect(testConfigChanged(r.dir, r.base, ["Package.JSON"])).toEqual([]);
    r.edit("Package.JSON", pkg({ test: "t", pretest: "x" }));
    expect(testConfigChanged(r.dir, r.base, ["Package.JSON"])).toEqual(["Package.JSON"]);
  });
  test("a byte-identical .npmrc does not cap", () => {
    const r = repo({ ".npmrc": "registry=a\n", "x.txt": "1" });
    r.edit("x.txt", "2");
    expect(runnerConfigNotes(r.dir, r.base, commit(r.dir, "c"), ["x.txt"])).toEqual([]);
  });
  test("every registry regex is case-insensitive", () => {
    for (const s of RUNNER_CONFIGS) expect(s.re.flags).toContain("i");
  });
  test.each([
    ["package.json pnpm key", "package.json", pkg({ test: "t" }, { pnpm: { patchedDependencies: { "foo@1.0.0": "vendor/foo.js" } } }), "vendor/foo.js"],
    ["package.json top-level key", "package.json", pkg({ test: "t" }, { patchedDependencies: { "foo@1.0.0": "./vendor/foo.txt" } }), "vendor/foo.txt"],
    ["pnpm-workspace.yaml", "pnpm-workspace.yaml", 'packages:\n  - a\npatchedDependencies:\n  foo@1.0.0: vendor/foo.js\n  "bar@2": "other/bar.js"\n', "other/bar.js"],
    ["nested manifest resolves relative to it", "sub/package.json", pkg({ test: "t" }, { pnpm: { patchedDependencies: { "foo@1": "v/foo.js" } } }), "sub/v/foo.js"],
  ])("patchedDependencies target outside patches/ caps when edited: %s", (_n, cfg, text, target) => {
    const r = repo({ [cfg]: text, [target]: "old\n" });
    r.edit(target, "new\n");
    const notes = runnerConfigNotes(r.dir, r.base, commit(r.dir, "p"), [target]);
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain(target);
  });
  test("an unrelated file next to a patchedDependencies manifest does not cap", () => {
    const r = repo({ "package.json": pkg({ test: "t" }, { pnpm: { patchedDependencies: { "foo@1": "vendor/foo.js" } } }), "vendor/foo.js": "a", "vendor/other.js": "a" });
    r.edit("vendor/other.js", "b");
    expect(runnerConfigNotes(r.dir, r.base, commit(r.dir, "u"), ["vendor/other.js"])).toEqual([]);
  });
  describe("FC-09x remapped patch target between two committed patch files caps", () => {
    const remap = (cfg: string, baseText: string, headText: string): string[] => {
      const r = repo({ [cfg]: baseText, "p.patch": "p\n", "q.patch": "q\n" });
      r.edit(cfg, headText);
      return runnerConfigNotes(r.dir, r.base, commit(r.dir, "m"), [cfg]);
    };
    test("Bun top-level patchedDependencies mapping compared in package.json", () => {
      const r = repo({ "package.json": pkg({ test: "t" }, { patchedDependencies: { a: "p.patch" } }), "p.patch": "p\n", "q.patch": "q\n" });
      r.edit("package.json", pkg({ test: "t" }, { patchedDependencies: { a: "q.patch" } }));
      expect(testConfigChanged(r.dir, r.base, ["package.json"])).toEqual(["package.json"]);
      expect(runnerConfigNotes(r.dir, r.base, commit(r.dir, "m"), ["package.json"]).length).toBeGreaterThan(0);
    });
    test("CRLF pnpm-workspace.yaml remap caps", () => {
      expect(remap("pnpm-workspace.yaml", "packages:\r\n  - a\r\npatchedDependencies:\r\n  a: p.patch\r\n", "packages:\r\n  - a\r\npatchedDependencies:\r\n  a: q.patch\r\n").length).toBeGreaterThan(0);
    });
    test("CRLF pnpm-workspace.yaml adding b->p.patch caps", () => {
      expect(remap("pnpm-workspace.yaml", "patchedDependencies:\r\n  a: p.patch\r\n", "patchedDependencies:\r\n  a: p.patch\r\n  b: p.patch\r\n").length).toBeGreaterThan(0);
    });
    test("multi-line flow map remap caps", () => {
      expect(remap("pnpm-workspace.yaml", "patchedDependencies: {\n  a: p.patch,\n  b: p.patch\n}\n", "patchedDependencies: {\n  a: q.patch,\n  b: p.patch\n}\n").length).toBeGreaterThan(0);
    });
    test("CRLF pnpm-workspace.yaml targets are parsed as patch targets", () => {
      const r = repo({ "pnpm-workspace.yaml": "packages:\r\n  - a\r\npatchedDependencies:\r\n  a: vendor/a.js\r\n", "vendor/a.js": "x\n" });
      r.edit("vendor/a.js", "y\n");
      const n = runnerConfigNotes(r.dir, r.base, commit(r.dir, "p"), ["vendor/a.js"]);
      expect(n.length).toBe(1);
      expect(n[0]).toContain("vendor/a.js");
    });
    test("multi-line flow map targets are parsed as patch targets", () => {
      const r = repo({ "pnpm-workspace.yaml": "patchedDependencies: {\n  a: vendor/a.js,\n  b: vendor/b.js\n}\nother: 1\n", "vendor/b.js": "x\n" });
      r.edit("vendor/b.js", "y\n");
      const n = runnerConfigNotes(r.dir, r.base, commit(r.dir, "p"), ["vendor/b.js"]);
      expect(n.length).toBe(1);
      expect(n[0]).toContain("vendor/b.js");
    });
  });
});

// Class C: an advisory for a change the plan declared, or a link a passing Wall requires, is disclosed and never caps; every undeclared change still caps.
describe("seal advisories for declared changes disclose and do not cap", () => {
  const PK = JSON.stringify({ name: "validate", scripts: { test: "bun test" } }) + "\n", NOTE = "test configuration changed: packages/validate/package.json";
  const pkgEdits = { "packages/validate/package.json": PK, "packages/validate/validate.mjs": "export const ok = 1;\n", "tests/loki_wall_validate.test.mjs": "import '../packages/validate/validate.mjs';\n" };
  const WALL = { path: "tests/loki_wall_validate.test.mjs", text: "import '../packages/validate/validate.mjs';\n" };
  test("a new package.json the plan declared (Wall passed, n>0) is disclosed, verdict VERIFIED", async () => {
    const r = await sealRun({}, pkgEdits, { wallFile: WALL, notProven: [NOTE], planFiles: ["packages/validate/package.json"] });
    expect(r.verdict).toBe("VERIFIED");
    expect(r.not_proven.some((n) => n.startsWith(NOTE) && n.includes("disclosed, does not cap"))).toBe(true);
  }, 30000);
  test("mutation: the same new package.json with no plan declaration still caps", async () => {
    const r = await sealRun({}, pkgEdits, { wallFile: WALL, notProven: [NOTE], planFiles: ["calc.ts"] });
    expect(r.verdict).toBe("PARTIAL");
    expect(r.not_proven).toContain(NOTE);
  }, 30000);
  test("mutation: a declared package.json that already existed at base (an edit) still caps", async () => {
    const r = await sealRun({ "packages/validate/package.json": '{"name":"validate"}\n' }, pkgEdits, { wallFile: WALL, notProven: [NOTE], planFiles: ["packages/validate/package.json"] });
    expect(r.verdict).toBe("PARTIAL");
  }, 30000);
  test("mutation: a declared new package.json caps when the Wall did not pass with n>0", async () => {
    const r = await sealRun({}, pkgEdits, { wallFile: WALL, wallN: 0, notProven: [NOTE], planFiles: ["packages/validate/package.json"] });
    expect(r.verdict).toBe("PARTIAL");
  }, 30000);
  const LINKW = { path: "tests/loki_wall_bump.test.ts", text: 'join(import.meta.dir, "bump.sh")\n' };
  test("a symlink a passing Wall requires, to a real in-repo file, is disclosed, verdict VERIFIED", async () => {
    const r = await sealRun({}, { "bump.sh": "#!/bin/sh\n", "tests/loki_wall_bump.test.ts": LINKW.text }, { wallFile: LINKW, links: { "tests/bump.sh": "../bump.sh" } });
    expect(r.verdict).toBe("VERIFIED");
    expect(r.not_proven.some((n) => n.startsWith("symlink added by the change") && n.includes("disclosed, does not cap"))).toBe(true);
  }, 30000);
  test("mutation: a symlink no Wall file names and the plan never declared still caps", async () => {
    const r = await sealRun({}, { "bump.sh": "#!/bin/sh\n", "tests/loki_wall_bump.test.ts": LINKW.text }, { wallFile: LINKW, links: { "tests/other_alias": "../bump.sh" } });
    expect(r.verdict).toBe("PARTIAL");
    expect(r.not_proven.some((n) => n.startsWith("symlink added by the change") && n.endsWith("tests/other_alias"))).toBe(true);
  }, 30000);
  test("mutation: a dangling symlink the Wall names still caps", async () => {
    const r = await sealRun({}, { "tests/loki_wall_bump.test.ts": LINKW.text }, { wallFile: LINKW, links: { "tests/bump.sh": "../missing.sh" } });
    expect(r.verdict).toBe("PARTIAL");
  }, 30000);
  test("R1: a plan that declares a sibling file does not declare a new conftest.py beside it (test-runner hook), verdict PARTIAL", async () => {
    const note = "test configuration changed: tests/conftest.py", W = { path: "tests/loki_wall_h.test.ts", text: "import './helper.py';\n" };
    const r = await sealRun({}, { "tests/helper.py": "x = 1\n", "tests/conftest.py": "def pytest_runtest_makereport(item, call): pass\n", [W.path]: W.text }, { wallFile: W, notProven: [note], planFiles: ["tests/helper.py"] });
    expect(r.verdict).toBe("PARTIAL"); expect(r.not_proven).toContain(note);
  }, 30000);
  test("R1b: even a plan that names the conftest.py exactly does not disclose it (not a package manifest)", async () => {
    const note = "test configuration changed: tests/conftest.py", W = { path: "tests/loki_wall_h.test.ts", text: "import './helper.py';\n" };
    const r = await sealRun({}, { "tests/conftest.py": "x = 1\n", [W.path]: W.text }, { wallFile: W, notProven: [note], planFiles: ["tests/conftest.py"] });
    expect(r.verdict).toBe("PARTIAL");
  }, 30000);
  test("R1c: a declared new package.json in a folder that already held files at base still caps", async () => {
    const r = await sealRun({ "packages/validate/old.mjs": "export {};\n" }, pkgEdits, { wallFile: WALL, notProven: [NOTE], planFiles: ["packages/validate/package.json"] });
    expect(r.verdict).toBe("PARTIAL");
  }, 30000);
  test("R2: a Wall-named link to a file that already existed at base (this diff did not add it) caps", async () => {
    const r = await sealRun({ "README.md": "doc\n" }, { "tests/loki_wall_bump.test.ts": LINKW.text }, { wallFile: LINKW, links: { "tests/bump.sh": "../README.md" } });
    expect(r.verdict).toBe("PARTIAL");
  }, 30000);
  test("R2b: a Wall-named link whose target is a test file caps", async () => {
    const r = await sealRun({}, { "tests/real.test.ts": "x\n", "tests/loki_wall_bump.test.ts": LINKW.text }, { wallFile: LINKW, links: { "tests/bump.sh": "real.test.ts" } });
    expect(r.verdict).toBe("PARTIAL");
  }, 30000);
  test("R3: a link named a is not named by the letter a in the Wall prose, so it caps", async () => {
    const W = { path: "tests/loki_wall_x.test.ts", text: "// a basic check\nexpect(1).toBe(1);\n" };
    const r = await sealRun({}, { "real.sh": "#!/bin/sh\n", [W.path]: W.text }, { wallFile: W, links: { a: "real.sh" } });
    expect(r.verdict).toBe("PARTIAL");
  }, 30000);
  test("R4: a link whose target is a base-tracked link out of the repo caps (every hop is resolved)", async () => {
    const r = await sealRun({}, { "tests/loki_wall_bump.test.ts": LINKW.text }, { wallFile: LINKW, baseLinks: { hop: "/etc/hosts" }, links: { "tests/bump.sh": "../hop" } });
    expect(r.verdict).toBe("PARTIAL");
  }, 30000);
});
