// engine10/testmap.ts -- runner detection and the impacted-test map (E-05). Runners come from real files only (ENGINE.md section 8). Each changed file maps to tests that import/reference it, unioned
// with a same-stem floor so Go or import-free tests never drop to zero (under-selecting is unsafe). Pure read. EngineTestMap extends types.ts TestMap without editing it.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { listProjectFiles } from "../util/safe_git.ts";
import { loadProjectApi } from "../project_model/resolve.ts";
import { attachScope, scopeRefs } from "../project_model/scope.ts";
import type { RunnerName, TestMap, TestMapProvider, TestRef } from "./types.ts";
import { GO_TEST_RE, JS_SPEC_RE, JS_TEST_RE, PY_TEST_RE, coveredStem, detectFromPackageJson, isTestFile, referencedBasenames } from "../util/test_file_text.ts";
export { isTestFile };
/** One command shape per runner (ENGINE.md section 8 table). `<files>` is a placeholder the  caller (E-09 verify) fills with the selected paths. `coarse: true` means the command always  runs the
 *  whole suite: npm and cargo have no reliable per-file selection. */
export interface CommandSpec {
  cmd: string;
  coarse: boolean;
}
/** Extra fields beyond E-01's TestMap. `sourceRefs` is read back by `impacted()` and is not meant for callers outside this file. */
export interface EngineTestMap extends TestMap {
  /** Repo-relative file that proved each detected runner. */
  evidence: Partial<Record<RunnerName, string>>;
  commands: Partial<Record<RunnerName, CommandSpec>>;
  /** source basename -> repo-relative test paths that import/reference it. */
  readonly sourceRefs: Record<string, string[]>;
}
const RUNNER_ORDER: readonly RunnerName[] = ["pytest", "vitest", "jest", "bun", "node", "npm", "go", "cargo"];
const COMMANDS: Record<RunnerName, CommandSpec> = {
  pytest: { cmd: "python -m pytest -q <files>", coarse: false },
  vitest: { cmd: "npx vitest run <files>", coarse: false },
  jest: { cmd: "npx jest <files>", coarse: false },
  bun: { cmd: "bun test <files>", coarse: false },
  node: { cmd: "node --test <files>", coarse: false },
  npm: { cmd: "npm test --silent", coarse: true },
  go: { cmd: "go test ./<pkg dirs>", coarse: false },
  cargo: { cmd: "cargo test", coarse: true },
};
/** Repo's own interpreter first (E-53): `<root>/.venv/bin/python`, then  `<root>/venv/bin/python`, else bare `python` on PATH. */
function pytestPython(root: string): string {
  for (const venv of [".venv", "venv"]) {
    const bin = join(root, venv, "bin", "python");
    if (existsSync(bin)) return bin;
  }
  return "python";
}
/** No detected runner and no Python/Go test suite (docs, plugins, config): Loki's own bun runs the Wall's bun:test file, in the Wall and in verify. Off with LOKI_WALL_HARNESS_RUNNER=0 or no bun on PATH (FC-17 skip, as before). */
export const harnessRunners = (runners: RunnerName[], files: readonly string[] = [], env: NodeJS.ProcessEnv = process.env): RunnerName[] => runners.length === 0 && !files.some((f) => PY_TEST_RE.test(basename(f)) || GO_TEST_RE.test(f)) && env.LOKI_WALL_HARNESS_RUNNER !== "0" && Bun.which("bun", { PATH: env.PATH ?? "" }) ? ["bun"] : runners;
/** Cargo selects one file only as `cargo test --test <stem>`, and only for an integration test directly under a tests/ directory. */
export const CARGO_TEST_FILE_RE = /(?:^|\/)tests\/[^/]+\.rs$/;
/** The runner that executes a Wall-authored file, by its extension; null when no runner of this repo can run it (wall.ts seals it unrun, verify skips it). relPath (repo-relative) decides a .rs file: cargo only under tests/, else null (FC-WALL-RUST-FILE-HAS-NO-RUNNER). */
export function guessRunner(fileName: string, runners: RunnerName[], relPath?: string): RunnerName | null {
  if (fileName.endsWith(".py")) return "pytest";
  if (fileName.endsWith(".go")) return "go";
  if (fileName.endsWith(".rs")) return runners.includes("cargo") && relPath !== undefined && CARGO_TEST_FILE_RE.test(relPath) ? "cargo" : null;
  return /\.[cm]?[jt]sx?$/.test(fileName) ? (["vitest", "jest", "bun", "node"] as const).find((r) => runners.includes(r)) ?? null : null; // a JS runner only ever runs a JS/TS file
}
/** TEN-COST-09: "project" when a repo-local interpreter exists (.venv, venv, or an in-repo VIRTUAL_ENV), else "system". Mirrors verify.ts resolveTool, which marks a system pytest result not_run. */
export function projectInterpreter(root: string): "project" | "system" {
  const ve = process.env["VIRTUAL_ENV"], inRepo = (p: string): boolean => { try { const r = relative(realpathSync(root), realpathSync(p)); return r !== "" && !r.startsWith("..") && !isAbsolute(r); } catch { return false; } };
  return [join(root, ".venv", "bin", "python"), join(root, "venv", "bin", "python"), ...(ve && inRepo(ve) ? [join(ve, "bin", "python")] : [])].some(existsSync) ? "project" : "system";
}
const readText = (p: string): string => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const normalizeRel = (raw: string): string => raw.split(sep).join("/").replace(/^\.\//, "");
/** Synchronous core: scans `root`, returns the full detected map. `detect()` on TestMapProviderImpl just wraps this in a Promise per the interface. */
export function buildTestMap(root: string): EngineTestMap {
  const files = listProjectFiles(root);
  const evidence: Partial<Record<RunnerName, string>> = {};
  const mark = (r: RunnerName, file: string): void => {
    if (!(r in evidence)) evidence[r] = file;
  };
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
    for (const n of names) {
      (sourceRefs[n] ??= []).push(t.path);
    }
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
  async detect(repoDir: string): Promise<TestMap> {
    return buildTestMap(repoDir);
  }
  impacted(map: TestMap, changedFiles: string[]): TestRef[] {
    return impactedRefs(map, changedFiles);
  }
}
