// util/test_file_text.ts -- pure test-file naming, import-spec and package.json runner helpers, split out of engine10/testmap.ts to keep the core line budget (TEN-CORE-TRIM). No I/O.
import { basename, dirname } from "node:path";
import type { RunnerName } from "../engine10/types.ts";
import type { ProjectApi } from "../project_model/api.ts";
import { pytestBoot } from "./runner_boot.ts";
export const NPM_DEFAULT_TEST = /no test specified/;
export const JS_TEST_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
export const PY_TEST_RE = /^(test_.+|.+_test)\.py$/;
export const GO_TEST_RE = /_test\.go$/;
export const RS_TEST_RE = /(^|\/)tests\/[^/]+\.rs$/; // a cargo integration test
export const SH_TEST_RE = /(^|\/)(tests?|__tests__)\/[^/]+\.(sh|bash)$/;
export function isTestFile(rel: string): boolean {
  const name = basename(rel);
  return JS_TEST_RE.test(name) || PY_TEST_RE.test(name) || GO_TEST_RE.test(name) || RS_TEST_RE.test(rel) || SH_TEST_RE.test(rel) || /^test[-_].+\.(sh|bash)$/.test(name);
}
export function detectFromPackageJson(text: string, rel: string, mark: (r: RunnerName, file: string) => void): void {
  let pkg: {
    scripts?: Record<string, unknown>;
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
  };
  try {
    pkg = JSON.parse(text);
  } catch {
    return;
  }
  if (!pkg || typeof pkg !== "object") return;
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const scripts = Object.values(pkg.scripts ?? {}).filter((s): s is string => typeof s === "string");
  const inScripts = (re: RegExp) => scripts.some((s) => re.test(s));
  if ("vitest" in deps || inScripts(/\bvitest\b/)) mark("vitest", rel);
  if ("jest" in deps || inScripts(/\bjest\b/)) mark("jest", rel);
  if (inScripts(/\bbun\s+test\b/)) mark("bun", rel);
  // ponytail: repo_profile.ts also reads scripts.test, but buildProfile persists a profile file as a side effect, so the one check is inlined here.
  const testScript = pkg.scripts?.test; // node only for a bare `node --test [paths]`: anything else (flags, &&) must run whole via npm
  if (typeof testScript === "string" && testScript.trim() !== "" && !NPM_DEFAULT_TEST.test(testScript)) mark(/^\s*node\s+--test(?:\s+[^\s\-&;|<>$`()][^\s&;|<>$`()]*)*\s*$/.test(testScript) ? "node" : "npm", rel);
}
// Import/reference specifiers a test file's text can carry, per language. JS: `from "./search"`
// / `require("./search")`. Python: `from app.ranker import x` / `import app.ranker`. Matched
// textually (grep), never resolved against a module graph.
export const JS_SPEC_RE = /(?:from\s+|require\(\s*)['"]([^'"]+)['"]/g;
export const PY_FROM_RE = /^\s*from\s+([\w.]+)\s+import\b/gm;
export const PY_IMPORT_RE = /^\s*import\s+([\w.]+)/gm;
export function jsSpecToBasename(spec: string): string {
  const clean = spec.replace(/^\.*\/+/, "");
  const base = clean.split("/").pop() ?? clean;
  return base.replace(/\.[cm]?[jt]sx?$/, "");
}
export function pySpecToBasename(spec: string): string {
  const parts = spec.split(".");
  return parts[parts.length - 1] ?? spec;
}
/** Source basenames a test file's text imports or references (section 8). */
export function referencedBasenames(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(JS_SPEC_RE)) {
    const spec = m[1];
    if (spec) out.add(jsSpecToBasename(spec));
  }
  for (const m of text.matchAll(PY_FROM_RE)) {
    const spec = m[1];
    if (spec) out.add(pySpecToBasename(spec));
  }
  for (const m of text.matchAll(PY_IMPORT_RE)) {
    const spec = m[1];
    if (spec) out.add(pySpecToBasename(spec));
  }
  return out;
}
// Source stem a test covers by naming alone: search.test.ts -> search, test_ranker.py -> ranker, handler_test.go -> handler. The floor under the
// import/reference grep, never a replacement: import-free tests (same-package Go, test_ranker.py) would otherwise map to zero tests (unsafe for E-09).
export function coveredStem(testPath: string): string {
  const name = basename(testPath);
  if (JS_TEST_RE.test(name)) return name.replace(JS_TEST_RE, "");
  if (name.startsWith("test_")) return name.slice(5, -3);
  return name.replace(/_test\.(py|go)$/, "");
}
/** One runner resolver for a repo whose Project Model names no runner (FC-WALL-HARNESS-TOOLCHAIN-ON-FOREIGN-STACK). A source file in another language selects that language's own stdlib runner (python3 -m unittest, the go tool, cargo) when its tool is on PATH; a source language with no stdlib runner here, or a missing tool, yields [] (Wall skips with NOT PROVEN, before any model session). Loki's own bun runs the Wall only when JS/TS holds at least as many source bytes as any other language (or the repo has no source at all: docs, plugins, config). The env switch LOKI_WALL_HARNESS_RUNNER=0 or no bun on PATH turns off the bun fallback only. */
export const STDLIB_RUNNERS: ReadonlyArray<{ ext: RegExp; runner: RunnerName; tool: string }> = [{ ext: /\.py$/, runner: "unittest", tool: "python3" }, { ext: /\.go$/, runner: "go", tool: "go" }, { ext: /\.rs$/, runner: "cargo", tool: "cargo" }, { ext: /\.java$/, runner: "javac", tool: "javac" }];
export const FOREIGN_SOURCE_RE = /\.(?:py|go|rs|java|kt|kts|scala|rb|php|cs|c|cc|cpp|cxx|h|hpp|swift|m|mm|ex|exs|erl|hs|clj|lua|pl|dart|r|jl|zig)$/i;

/** JS test frameworks a test file imports, in preference order. Reads test source text, never model output. */
const FRAMEWORK_IMPORTS: readonly (readonly [RunnerName, RegExp])[] = [["bun", /(?:from|require\()\s*['"]bun:test['"]/], ["vitest", /(?:from|require\()\s*['"]vitest['"]/], ["node", /(?:from|require\()\s*['"]node:test['"]/]];
export const importedRunners = (src: string): RunnerName[] => FRAMEWORK_IMPORTS.filter(([, re]) => re.test(src)).map(([r]) => r);
export const PYTEST_IMPORT_RE = /^\s*(?:import pytest|from pytest import)/m;

/**
 * #233: runner evidence scoped to the package that owns each test. A framework import in the test itself is stronger
 * evidence than a manifest, and a nested package never owns its siblings. `read` supplies file text (this module does no I/O).
 */
export function scopeRunnersByPackage(files: readonly string[], evidence: Partial<Record<RunnerName, string>>, jsText: ReadonlyMap<string, string>, api: ProjectApi | null | undefined, order: readonly RunnerName[], read: (rel: string) => string): { ownerRoot: (file: string) => string; packageRunners: Map<string, RunnerName[]> } {
  const roots = [...new Set([".", ...(api?.packages().map((p) => p.root) ?? []), ...files.filter((f) => basename(f) === "package.json").map((f) => dirname(f))])];
  const ownerRoot = (file: string): string => api?.packageRootOf(file) ?? roots.filter((p) => p === "." || file.startsWith(`${p}/`)).sort((a, b) => b.length - a.length)[0] ?? ".";
  const packageRunners = new Map<string, RunnerName[]>();
  for (const pkgRoot of roots) {
    const manifest = pkgRoot === "." ? "package.json" : `${pkgRoot}/package.json`, found = new Set<RunnerName>(), add = (r: RunnerName): void => { found.add(r); };
    detectFromPackageJson(read(manifest), manifest, add);
    const modelPkg = api?.packages().find((p) => p.root === pkgRoot), modelRunner = modelPkg?.runner?.toLowerCase() as RunnerName | undefined, modelTest = modelPkg?.commands?.test?.cmd;
    if (modelRunner && order.includes(modelRunner)) found.add(modelRunner);
    if (modelTest) detectFromPackageJson(JSON.stringify({ scripts: { test: modelTest } }), manifest, add);
    for (const [path, text] of jsText) if (ownerRoot(path) === pkgRoot) importedRunners(text).forEach(add);
    for (const [r, path] of Object.entries(evidence) as [RunnerName, string][]) if (ownerRoot(path) === pkgRoot) found.add(r);
    packageRunners.set(pkgRoot, order.filter((r) => found.has(r)));
  }
  return { ownerRoot, packageRunners };
}

/** One command shape per runner (ENGINE.md section 8 table). `<files>` is a placeholder the  caller (E-09 verify) fills with the selected paths. `coarse: true` means the command always  runs the  whole suite: npm and cargo have no reliable per-file selection. */
export interface CommandSpec { cmd: string; coarse: boolean; }
export const RUNNER_ORDER: readonly RunnerName[] = ["pytest", "vitest", "jest", "bun", "node", "npm", "go", "cargo", "maven", "gradle", "javac"];
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
/** Runners that can write a machine pass/fail report file: the invocation to find in a check command and the flags that name the report (`<report>` is replaced by the caller's path), `boot` (wraps the check in a sandbox script that records what the runner loads before it collects tests), `inline` (a text pattern for a pytest section or key in a shared ini, cfg or toml file), and `config`, the basenames that configure or preload that runner (a .json match counts only when it holds the entry's `key`). Go and cargo have no stable file reporter and are absent. verify-pr reads its verdict from that file, never from an exit code or printed totals. */
export const REPORT_RUNNERS: readonly { runner: RunnerName; find: RegExp; flags: string; config: RegExp; key?: string; boot?: (cmd: string) => string; inline?: RegExp }[] = [
  { runner: "bun", find: /bun test\b/, flags: "--reporter=junit --reporter-outfile=<report>", config: /^bunfig\.toml$/ },
  { runner: "pytest", find: /(?:(?:python3?|py) -m )?py\.?test\b/, flags: "--junitxml=<report>", config: /^(?:conftest\.py|\.?pytest\.ini)$/, boot: pytestBoot, inline: /^[ \t]*[\w.\"' \t-]*\bpytest\b[\"']?[ \t]*(?:\.|=[ \t]*\{)/im },
  { runner: "jest", find: /jest\b/, flags: "--json --outputFile=<report>", config: /^(?:jest\.config\..+|package\.json)$/, key: "jest" },
  { runner: "vitest", find: /vitest\b/, flags: "--reporter=junit --outputFile=<report>", config: /^(?:vitest|vite)\.config\..+$|^vitest\.workspace\..+$/ },
];
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
