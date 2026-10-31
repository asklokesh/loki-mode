// engine10/testmap.ts -- runner detection and the impacted-test map (E-05). Runners come from real files only (ENGINE.md section 8). Each changed file maps to tests that import/reference it, unioned with a same-stem floor so Go or import-free tests never drop to zero (under-selecting is unsafe). Pure read. EngineTestMap extends types.ts TestMap without editing it.
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { listProjectFiles } from "../util/safe_git.ts";
import { loadProjectApi } from "../project_model/resolve.ts"; import { languageBytes } from "../project_model/linguist.ts";
import { attachScope, scopeRefs } from "../project_model/scope.ts";
import { projectInterpreter, pytestPython } from "../util/python.ts"; export { projectInterpreter };
import type { RunnerName, TestMap, TestMapProvider, TestRef } from "./types.ts";
import { FOREIGN_SOURCE_RE, GO_TEST_RE, JS_SPEC_RE, JS_TEST_RE, PY_TEST_RE, STDLIB_RUNNERS, coveredStem, detectFromPackageJson, isTestFile, referencedBasenames } from "../util/test_file_text.ts";
export { isTestFile };
/** One command shape per runner (ENGINE.md section 8 table). `<files>` is a placeholder the  caller (E-09 verify) fills with the selected paths. `coarse: true` means the command always  runs the  whole suite: npm and cargo have no reliable per-file selection. */
export interface CommandSpec { cmd: string; coarse: boolean; }
/** Extra fields beyond E-01's TestMap. `sourceRefs` is read back by `impacted()` and is not meant for callers outside this file. */
export interface EngineTestMap extends TestMap {
  /** Repo-relative file that proved each detected runner. */
  evidence: Partial<Record<RunnerName, string>>;
  commands: Partial<Record<RunnerName, CommandSpec>>;
  /** source basename -> repo-relative test paths that import/reference it. */
  readonly sourceRefs: Record<string, string[]>;
}
const RUNNER_ORDER: readonly RunnerName[] = ["pytest", "vitest", "jest", "bun", "node", "npm", "go", "cargo", "maven", "gradle", "javac"];
export const COMMANDS: Record<RunnerName, CommandSpec> = {
  pytest: { cmd: "python -m pytest -q <files>", coarse: false },
  unittest: { cmd: "python3 -m unittest <files>", coarse: false },
  vitest: { cmd: "npx vitest run <files>", coarse: false },
  jest: { cmd: "npx jest <files>", coarse: false },
  bun: { cmd: "bun test <files>", coarse: false },
  node: { cmd: "node --test <files>", coarse: false },
  npm: { cmd: "npm test --silent", coarse: true },
  go: { cmd: "go test ./<pkg dirs>", coarse: false },
  cargo: { cmd: "cargo test", coarse: true },
  maven: { cmd: "mvn test -Dtest=<class>", coarse: false },
  gradle: { cmd: "gradle cleanTest test --tests <class>", coarse: false },
  javac: { cmd: "javac + java <test class>", coarse: false },
};
/** Runners that can write a machine pass/fail report file: the invocation to find in a check command and the flags that name the report (`<report>` is replaced by the caller's path), and `config`, the basenames that configure or preload that runner (a .json match counts only when it holds the entry's `key`). Go and cargo have no stable file reporter and are absent. verify-pr reads its verdict from that file, never from an exit code or printed totals. */
export const REPORT_RUNNERS: readonly { runner: RunnerName; find: RegExp; flags: string; config: RegExp; key?: string }[] = [
  { runner: "bun", find: /bun test\b/, flags: "--reporter=junit --reporter-outfile=<report>", config: /^bunfig\.toml$/ },
  { runner: "pytest", find: /(?:(?:python3?|py) -m )?py\.?test\b/, flags: "--junitxml=<report>", config: /^(?:conftest\.py|\.?pytest\.ini)$/ },
  { runner: "jest", find: /jest\b/, flags: "--json --outputFile=<report>", config: /^(?:jest\.config\..+|package\.json)$/, key: "jest" },
  { runner: "vitest", find: /vitest\b/, flags: "--reporter=junit --outputFile=<report>", config: /^(?:vitest|vite)\.config\..+$|^vitest\.workspace\..+$/ },
];
/** HV1-03b: the tool each Java runner needs (the repo wrapper counts for maven and gradle). */
const JAVA_TOOLS: Partial<Record<RunnerName, { tool: string; wrapper?: string }>> = { maven: { tool: "mvn", wrapper: "mvnw" }, gradle: { tool: "gradle", wrapper: "gradlew" }, javac: { tool: "javac" } };
const javaToolOk = (r: RunnerName, env: NodeJS.ProcessEnv, root?: string): boolean => { const t = JAVA_TOOLS[r]; return !t || !!Bun.which(t.tool, { PATH: env.PATH ?? "" }) || (!!t.wrapper && !!root && existsSync(join(root, t.wrapper))); };
/** HV1-03b: the Java tool that would run this repo's Wall but is not installed ("mvn", "gradle", "javac"), else null. Names the cause in the skip note so a Java repo is never skipped with a bare "no runnable test command". */
export function missingJavaTool(files: readonly string[], env: NodeJS.ProcessEnv = process.env, root?: string): string | null {
  const want: RunnerName | null = files.some((f) => /(?:^|\/)pom\.xml$/.test(f)) ? "maven" : files.some((f) => /(?:^|\/)(?:build|settings)\.gradle(?:\.kts)?$|(?:^|\/)gradlew$/.test(f)) ? "gradle" : files.some((f) => /\.java$/.test(f)) ? "javac" : null;
  return want && !javaToolOk(want, env, root) ? JAVA_TOOLS[want]!.tool : null;
}
/** Detected runner first; the language holding most runnable sources picks its stdlib runner, else Loki's own bun runs the Wall's bun:test file (docs, plugins, config, JS/TS). Off with LOKI_WALL_HARNESS_RUNNER=0 or no bun on PATH, then the repo's own toolchain (RX-1); `focus` (changed or sealed files) picks the toolchain in a polyglot repo. */
export const harnessRunners = (runners: RunnerName[], files: readonly string[] = [], env: NodeJS.ProcessEnv = process.env, root?: string, focus: readonly string[] = []): RunnerName[] => pickHarnessRunners(runners, files, env, root, focus).filter((r) => javaToolOk(r, env, root)); // HV1-03b: a Java build tool that is not installed is never a runner (the Wall then skips with the tool named, see missingJavaTool) instead of a base run that cannot start
const pickHarnessRunners = (runners: RunnerName[], files: readonly string[], env: NodeJS.ProcessEnv, root: string | undefined, focus: readonly string[]): RunnerName[] => {
  const onPath = (tool: string): boolean => !!Bun.which(tool, { PATH: env.PATH ?? "" }), w = languageBytes(root, files, (f) => STDLIB_RUNNERS.find((r) => r.ext.test(f))?.runner ?? (/\.[cm]?[jt]sx?$/i.test(f) ? "js" : FOREIGN_SOURCE_RE.test(f) ? "other" : null)), at = (k: string): number => w.get(k) ?? 0, js = at("js"), top = STDLIB_RUNNERS.reduce((a, r) => (at(r.runner) > at(a.runner) ? r : a)), bun: RunnerName[] = env.LOKI_WALL_HARNESS_RUNNER !== "0" && onPath("bun") ? ["bun"] : toolchainRunner(files, focus); // RX-1: no bun either: the repo's own toolchain runs the Wall instead of skipping it
  const t = at(top.runner), o = at("other");
  return runners.length > 0 ? runners : js >= t && js >= o ? (js === 0 && w.size > 0 ? [] : bun) : t > o ? (onPath(top.tool) ? [top.runner] : toolchainRunner(files, focus)) : []; // the language holding the most source BYTES wins after linguist's vendored/generated/documentation rules and .gitattributes; a tie with JS goes to bun, a stdlib language whose tool is not on PATH falls to the repo's own manifest toolchain (RX-1; [] without a manifest, so NOT PROVEN), a tie between a stdlib language and an unsupported one yields [] (NOT PROVEN), and bun never runs a repo whose largest language is not JS/TS; one runner, so the Wall brief and verify agree
};
/** RX-1: manifest -> the runner its own language toolchain ships (COMMANDS holds the command), plus that language's source extension. A manifest only makes a toolchain eligible; in a polyglot repo the focus files (changed or sealed) choose among the eligible ones by language, else the first eligible wins. */
const TOOLCHAINS: readonly (readonly [RegExp, RunnerName, RegExp])[] = [[/(?:^|\/)package\.json$/, "node", /\.[cm]?[jt]sx?$/], [/(?:^|\/)go\.mod$/, "go", /\.go$/], [/(?:^|\/)Cargo\.toml$/, "cargo", /\.rs$/], [/(?:^|\/)pom\.xml$/, "maven", /\.java$/], [/(?:^|\/)(?:build|settings)\.gradle(?:\.kts)?$|(?:^|\/)gradlew$/, "gradle", /\.java$/], [/(?:^|\/)(?:pyproject\.toml|setup\.py|setup\.cfg|requirements(?:[-_.][\w.-]+)?\.txt|tox\.ini|pytest\.ini)$/, "pytest", /\.py$/]];
const toolchainRunner = (files: readonly string[], focus: readonly string[] = []): RunnerName[] => { const el = TOOLCHAINS.filter(([m]) => files.some((f) => m.test(f))), votes = (t: (typeof TOOLCHAINS)[number]): number => focus.filter((f) => t[2].test(f)).length; return el.length ? [el.reduce((b, t) => (votes(t) > votes(b) ? t : b))[1]] : []; };
/** Cargo selects one file only as `cargo test --test <stem>`, and only for an integration test directly under a tests/ directory. */
export const CARGO_TEST_FILE_RE = /(?:^|\/)tests\/[^/]+\.rs$/;
/** The runner that executes a Wall-authored file, by its extension; null when no runner of this repo can run it (wall.ts seals it unrun, verify skips it). relPath (repo-relative) decides a .rs file: cargo only under tests/, else null (FC-WALL-RUST-FILE-HAS-NO-RUNNER). */
export function guessRunner(fileName: string, runners: RunnerName[], relPath?: string): RunnerName | null {
  if (fileName.endsWith(".py")) return runners.includes("unittest") && !runners.includes("pytest") ? "unittest" : "pytest";
  if (fileName.endsWith(".go")) return "go";
  if (fileName.endsWith(".rs")) return runners.includes("cargo") && relPath !== undefined && CARGO_TEST_FILE_RE.test(relPath) ? "cargo" : null;
  if (fileName.endsWith(".java")) return (["maven", "gradle", "javac"] as const).find((r) => runners.includes(r)) ?? null; // HV1-03b: a Java test runs under the repo's own build tool, else plain javac
  return /\.[cm]?[jt]sx?$/.test(fileName) ? (["vitest", "jest", "bun", "node"] as const).find((r) => runners.includes(r)) ?? null : null; // a JS runner only ever runs a JS/TS file
}
const readText = (p: string): string => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const normalizeRel = (raw: string): string => raw.split(sep).join("/").replace(/^\.\//, "");
/** Synchronous core: scans `root`, returns the full detected map. `detect()` on TestMapProviderImpl just wraps this in a Promise per the interface. */
export function buildTestMap(root: string): EngineTestMap {
  const files = listProjectFiles(root);
  const evidence: Partial<Record<RunnerName, string>> = {};
  const mark = (r: RunnerName, file: string): void => { if (!(r in evidence)) evidence[r] = file; };
  const jsText = new Map<string, string>();
  for (const rel of files) {
    const name = basename(rel);
    const full = join(root, rel);
    if (JS_TEST_RE.test(name) && !evidence["node"] && /(?:from|require\()\s*['"]node:test['"]/.test(jsText.set(rel, readText(full)).get(rel)!)) mark("node", rel);
    else if (name === "package.json") detectFromPackageJson(readText(full), rel, mark);
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
    else if (/^(?:build|settings)\.gradle(?:\.kts)?$/.test(name) || name === "gradlew") mark("gradle", rel);
  }
  // Per-file test entries exist only for narrowly-selectable runners: npm and cargo run the whole suite (coarse), so no individual file earns a TestRef for them.
  const jsRunner: RunnerName | null = evidence["vitest"] ? "vitest" : evidence["jest"] ? "jest" : evidence["bun"] ? "bun" : evidence["node"] ? "node" : null;
  const tests: TestRef[] = [];
  for (const rel of files) {
    const name = basename(rel);
    if (JS_TEST_RE.test(name) && jsRunner) tests.push({ runner: jsRunner, path: rel });
    else if (PY_TEST_RE.test(name) && evidence["pytest"]) tests.push({ runner: "pytest", path: rel });
    else if (GO_TEST_RE.test(name) && evidence["go"]) tests.push({ runner: "go", path: rel });
  }
  // Object.create(null): keys come from grep'd file content, so a source named e.g. "constructor" must not collide with Object.prototype.
  const sourceRefs: Record<string, string[]> = Object.create(null);
  const specs: Record<string, string[]> = Object.create(null);
  for (const t of tests) {
    const text = jsText.get(t.path) ?? readText(join(root, t.path));
    specs[t.path] = [...text.matchAll(JS_SPEC_RE)].map((m) => m[1] ?? "");
    const names = referencedBasenames(text);
    names.add(coveredStem(t.path));
    for (const n of names) { (sourceRefs[n] ??= []).push(t.path); }
  }
  const runners = RUNNER_ORDER.filter((r) => r in evidence);
  const commands: Partial<Record<RunnerName, CommandSpec>> = {};
  for (const r of runners) commands[r] = r === "pytest" ? { ...COMMANDS.pytest, cmd: `${pytestPython(root)} -m pytest -q <files>` } : COMMANDS[r];
  const map: EngineTestMap = { runners, tests, evidence, commands, sourceRefs };
  attachScope(map, loadProjectApi(root), specs);
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
