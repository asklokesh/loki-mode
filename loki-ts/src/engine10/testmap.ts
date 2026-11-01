// engine10/testmap.ts -- runner detection and the impacted-test map (E-05). Runners come from real files only (ENGINE.md section 8). Each changed file maps to tests that import/reference it, unioned with a same-stem floor so Go or import-free tests never drop to zero (under-selecting is unsafe). Pure read. EngineTestMap extends types.ts TestMap without editing it.
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { listProjectFiles } from "../util/safe_git.ts";
import { loadProjectApi } from "../project_model/resolve.ts"; import { languageBytes } from "../project_model/linguist.ts"; 
import { attachScope, scopeRefs } from "../project_model/scope.ts";
import { CS_TEST_RE, DOTNET_MANIFEST_RE, JAVA_TEST_RE, missingStackTool, pascalWords, toolOk } from "../util/stack_tools.ts"; export { missingStackTool };
import { projectInterpreter, pytestPython } from "../util/python.ts"; export { projectInterpreter };
import type { RunnerName, TestMap, TestMapProvider, TestRef } from "./types.ts";
import { FOREIGN_SOURCE_RE, GO_TEST_RE, JS_SPEC_RE, JS_TEST_RE, PY_TEST_RE, STDLIB_RUNNERS, coveredStem, detectFromPackageJson, importedRunners, isTestFile, PYTEST_IMPORT_RE, referencedBasenames, scopeRunnersByPackage, COMMANDS, RUNNER_ORDER, guessRunner, type CommandSpec } from "../util/test_file_text.ts";
export { isTestFile, COMMANDS, REPORT_RUNNERS, CARGO_TEST_FILE_RE, guessRunner, type CommandSpec } from "../util/test_file_text.ts"; // tables and guessRunner live in util/test_file_text.ts (core line budget)
/** Extra fields beyond E-01's TestMap. `sourceRefs` is read back by `impacted()` and is not meant for callers outside this file. */
export interface EngineTestMap extends TestMap {
  /** Repo-relative file that proved each detected runner. */
  evidence: Partial<Record<RunnerName, string>>;
  commands: Partial<Record<RunnerName, CommandSpec>>;
  /** source basename -> repo-relative test paths that import/reference it. */
  readonly sourceRefs: Record<string, string[]>;
  /** Package ownership and locally declared runners for each discovered test package. */
  readonly testPackages: Record<string, string>;
  readonly packageRunners: Record<string, RunnerName[]>;
}
/** Detected runner first; the language holding most runnable sources picks its stdlib runner, else Loki's own bun runs the Wall's bun:test file (docs, plugins, config, JS/TS). Off with LOKI_WALL_HARNESS_RUNNER=0 or no bun on PATH, then the repo's own toolchain (RX-1); `focus` (changed or sealed files) picks the toolchain in a polyglot repo. */
export const harnessRunners = (runners: RunnerName[], files: readonly string[] = [], env: NodeJS.ProcessEnv = process.env, root?: string, focus: readonly string[] = []): RunnerName[] => pickHarnessRunners(runners, files, env, root, focus).filter((r) => toolOk(r, env, root)); // HV1-03b: a Java or .NET build tool that is not installed is never a runner (the Wall then skips with the tool named, see missingStackTool) instead of a base run that cannot start
const pickHarnessRunners = (runners: RunnerName[], files: readonly string[], env: NodeJS.ProcessEnv, root: string | undefined, focus: readonly string[]): RunnerName[] => {
  const onPath = (tool: string): boolean => !!Bun.which(tool, { PATH: env.PATH ?? "" }), w = languageBytes(root, files, (f) => STDLIB_RUNNERS.find((r) => r.ext.test(f))?.runner ?? (/\.[cm]?[jt]sx?$/i.test(f) ? "js" : FOREIGN_SOURCE_RE.test(f) ? "other" : null)), at = (k: string): number => w.get(k) ?? 0, js = at("js"), top = STDLIB_RUNNERS.reduce((a, r) => (at(r.runner) > at(a.runner) ? r : a)), bun: RunnerName[] = env.LOKI_WALL_HARNESS_RUNNER !== "0" && onPath("bun") ? ["bun"] : toolchainRunner(files, focus); // RX-1: no bun either: the repo's own toolchain runs the Wall instead of skipping it
  const t = at(top.runner), o = at("other");
  return runners.length > 0 ? runners : js >= t && js >= o ? (js === 0 && w.size > 0 ? [] : bun) : t > o ? (onPath(top.tool) ? [top.runner] : toolchainRunner(files, focus)) : []; // the language holding the most source BYTES wins after linguist's vendored/generated/documentation rules and .gitattributes; a tie with JS goes to bun, a stdlib language whose tool is not on PATH falls to the repo's own manifest toolchain (RX-1; [] without a manifest, so NOT PROVEN), a tie between a stdlib language and an unsupported one yields [] (NOT PROVEN), and bun never runs a repo whose largest language is not JS/TS; one runner, so the Wall brief and verify agree
};
/** RX-1: manifest -> the runner its own language toolchain ships (COMMANDS holds the command), plus that language's source extension. A manifest only makes a toolchain eligible; in a polyglot repo the focus files (changed or sealed) choose among the eligible ones by language, else the first eligible wins. */
const TOOLCHAINS: readonly (readonly [RegExp, RunnerName, RegExp])[] = [[/(?:^|\/)package\.json$/, "node", /\.[cm]?[jt]sx?$/], [/(?:^|\/)go\.mod$/, "go", /\.go$/], [/(?:^|\/)Cargo\.toml$/, "cargo", /\.rs$/], [/(?:^|\/)pom\.xml$/, "maven", /\.java$/], [DOTNET_MANIFEST_RE, "dotnet", /\.cs$/], [/(?:^|\/)(?:build|settings)\.gradle(?:\.kts)?$|(?:^|\/)gradlew$/, "gradle", /\.java$/], [/(?:^|\/)(?:pyproject\.toml|setup\.py|setup\.cfg|requirements(?:[-_.][\w.-]+)?\.txt|tox\.ini|pytest\.ini)$/, "pytest", /\.py$/]];
const toolchainRunner = (files: readonly string[], focus: readonly string[] = []): RunnerName[] => { const el = TOOLCHAINS.filter(([m]) => files.some((f) => m.test(f))), votes = (t: (typeof TOOLCHAINS)[number]): number => focus.filter((f) => t[2].test(f)).length; return el.length ? [el.reduce((b, t) => (votes(t) > votes(b) ? t : b))[1]] : []; };
const readText = (p: string): string => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const normalizeRel = (raw: string): string => raw.split(sep).join("/").replace(/^\.\//, "");
/** Synchronous core: scans `root`, returns the full detected map. `detect()` on TestMapProviderImpl just wraps this in a Promise per the interface. */
export function buildTestMap(root: string): EngineTestMap {
  const files = listProjectFiles(root);
  const evidence: Partial<Record<RunnerName, string>> = {};
  const mark = (r: RunnerName, file: string): void => { if (!(r in evidence)) evidence[r] = file; };
  const jsText = new Map<string, string>();
  const api = loadProjectApi(root);
  for (const rel of files) {
    const name = basename(rel);
    const full = join(root, rel);
    if (JS_TEST_RE.test(name)) {
      const text = readText(full); jsText.set(rel, text);
      for (const r of importedRunners(text)) mark(r, rel);
    } else if (name === "package.json") detectFromPackageJson(readText(full), rel, mark);
    else if (name === "bunfig.toml") mark("bun", rel);
    else if (name === "pytest.ini" || name === "conftest.py") mark("pytest", rel);
    else if (name === "pyproject.toml" && /\[tool\.pytest/.test(readText(full))) mark("pytest", rel);
    else if (name === "setup.cfg" && /\[tool:pytest]/.test(readText(full))) mark("pytest", rel);
    else if (name === "tox.ini" && /\[pytest]/.test(readText(full))) mark("pytest", rel);
    else if (PY_TEST_RE.test(name)) mark("pytest", rel);
    else if (/^vitest\.config\.[cm]?[jt]s$/.test(name)) mark("vitest", rel);
    else if (/^jest\.config\.[cm]?[jt]s(on)?$/.test(name)) mark("jest", rel);
    else if (name === "go.mod" || GO_TEST_RE.test(name)) mark("go", rel);
    else if (name === "Cargo.toml") mark("cargo", rel);
    else if (name === "pom.xml") mark("maven", rel);
    else if (DOTNET_MANIFEST_RE.test(name)) mark("dotnet", rel);
    else if (/^(?:build|settings)\.gradle(?:\.kts)?$/.test(name) || name === "gradlew") mark("gradle", rel);
  }
  const { ownerRoot, packageRunners } = scopeRunnersByPackage(files, evidence, jsText, api, RUNNER_ORDER, (rel) => readText(join(root, rel))); // #233: runners per owning package
  const tests: TestRef[] = [];
  const testPackages: Record<string, string> = Object.create(null);
  for (const rel of files) {
    const name = basename(rel), pkgRoot = ownerRoot(rel);
    const scope = packageRunners.get(pkgRoot) ?? packageRunners.get(".") ?? [];
    let jr: RunnerName | undefined; const jsRunner = JS_TEST_RE.test(name) ? (importedRunners(jsText.get(rel) ?? "")[0] ?? (["vitest", "jest", "bun", "node"] as const).find((r) => scope.includes(r))) : undefined;
    if (jsRunner) { tests.push({ runner: jsRunner, path: rel }); testPackages[rel] = pkgRoot; }
    else if (PY_TEST_RE.test(name) && (scope.includes("pytest") || PYTEST_IMPORT_RE.test(readText(join(root, rel))))) { tests.push({ runner: "pytest", path: rel }); testPackages[rel] = pkgRoot; }
    else if (GO_TEST_RE.test(name) && scope.includes("go")) { tests.push({ runner: "go", path: rel }); testPackages[rel] = pkgRoot; }
    else if ((JAVA_TEST_RE.test(rel) || CS_TEST_RE.test(rel)) && (jr = (rel.endsWith(".cs") ? (["dotnet"] as const) : (["maven", "gradle", "javac"] as const)).find((r) => scope.includes(r)))) { tests.push({ runner: jr, path: rel }); testPackages[rel] = pkgRoot; } // R02: JUnit under the repo's build tool, C# under `dotnet test`
  }
  // Object.create(null): keys come from grep'd file content, so a source named e.g. "constructor" must not collide with Object.prototype.
  const sourceRefs: Record<string, string[]> = Object.create(null);
  const specs: Record<string, string[]> = Object.create(null);
  for (const t of tests) {
    const text = jsText.get(t.path) ?? readText(join(root, t.path));
    specs[t.path] = [...text.matchAll(JS_SPEC_RE)].map((m) => m[1] ?? "");
    const names = referencedBasenames(text);
    names.add(coveredStem(t.path));
    if (/\.(?:java|cs)$/.test(t.path)) for (const w of pascalWords(text)) names.add(w); // R02: a Java or C# test names the classes it exercises
    for (const n of names) { (sourceRefs[n] ??= []).push(t.path); }
  }
  const runners = RUNNER_ORDER.filter((r) => r in evidence);
  const commands: Partial<Record<RunnerName, CommandSpec>> = {};
  for (const r of runners) commands[r] = r === "pytest" ? { ...COMMANDS.pytest, cmd: `${pytestPython(root)} -m pytest -q <files>` } : COMMANDS[r];
  const map: EngineTestMap = { runners, tests, evidence, commands, sourceRefs, testPackages, packageRunners: Object.fromEntries(packageRunners) };
  attachScope(map, api, specs);
  return map;
}
/** Test refs impacted by `changedFiles`: a changed test maps to itself; a changed source maps  to every test that imports/references its basename (built by `buildTestMap`'s grep, read back from `map.sourceRefs`). */
export function impactedRefs(map: TestMap, changedFiles: readonly string[]): TestRef[] {
  // `map` is always what buildTestMap/detect() returned; sourceRefs is this file's own addition to the shared TestMap contract (see EngineTestMap).
  const sourceRefs = (map as EngineTestMap).sourceRefs ?? {};
  const out: TestRef[] = [];
  const seen = new Set<string>();
  const add = (ref: TestRef | undefined): void => {
    if (ref && !seen.has(ref.path)) {
      seen.add(ref.path);
      out.push(ref);
    }
  };
  for (const raw of changedFiles) {
    const rel = normalizeRel(raw);
    const self = map.tests.find((t) => t.path === rel);
    if (self) {
      add(self);
      continue;
    }
    const stem = basename(rel, extname(rel));
    // Directory entry files (index.ts, __init__.py, Rust mod.rs) are also imported by their directory name.
    const stems = [stem];
    const entry = stem === "index" || stem === "__init__" || (stem === "mod" && extname(rel) === ".rs");
    if (entry && dirname(rel) !== ".") stems.push(basename(dirname(rel)));
    for (const s of stems) for (const p of sourceRefs[s] ?? []) add(map.tests.find((t) => t.path === p));
  }
  return scopeRefs(map, changedFiles.map(normalizeRel), out);
}
/** Implements the E-01 contract so RunContext can inject this as `tests`. */
export class RealTestMapProvider implements TestMapProvider {
  async detect(repoDir: string): Promise<TestMap> { return buildTestMap(repoDir); }
  impacted(map: TestMap, changedFiles: string[]): TestRef[] { return impactedRefs(map, changedFiles); }
}
