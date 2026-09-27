// engine10/testmap.ts -- runner detection and the impacted-test map (E-05).
//
// Detects runners from real files only (never from a prompt or a guess):
// pytest, vitest, jest, bun, npm, go, cargo. Maps each changed file to the
// test files that exercise it by stem. Pure read; writes nothing.
//
// E-01 owns types.ts; until it lands, the TestMap shape lives here so E-01
// can re-export it.

import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";

export type Runner = "pytest" | "vitest" | "jest" | "bun" | "npm" | "go" | "cargo";

/** changed file (repo-relative) -> impacted test files (repo-relative). */
export type ImpactedTests = Record<string, string[]>;

export interface TestMap {
  /** Detected runners in a stable order. Empty means none were found. */
  readonly runners: Runner[];
  /** Repo-relative test files, sorted, forward slashes. */
  readonly tests: string[];
  /** Impacted tests for the changed files passed to buildTestMap. */
  readonly impacted: ImpactedTests;
}

const RUNNER_ORDER: readonly Runner[] = ["pytest", "vitest", "jest", "bun", "npm", "go", "cargo"];
const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "target", "coverage",
  ".venv", "venv", "__pycache__", ".tox", ".pytest_cache", ".loki", ".next",
]);
const NPM_DEFAULT_TEST = /no test specified/;
const JS_TEST_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const PY_TEST_RE = /^(test_.+|.+_test)\.py$/;
const GO_TEST_RE = /_test\.go$/;

function isTestFile(rel: string): boolean {
  const name = basename(rel);
  return JS_TEST_RE.test(name) || PY_TEST_RE.test(name) || GO_TEST_RE.test(name);
}

function readText(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

// ponytail: full recursive walk minus SKIP_DIRS; add a file cap or
// `git ls-files` if a huge monorepo makes this slow.
function walk(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
      } else if (e.isFile()) {
        out.push(relative(root, full).split(sep).join("/"));
      }
    }
  }
  return out.sort();
}

function detectFromPackageJson(text: string, found: Set<Runner>): void {
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
  if ("vitest" in deps || inScripts(/\bvitest\b/)) found.add("vitest");
  if ("jest" in deps || inScripts(/\bjest\b/)) found.add("jest");
  if (inScripts(/\bbun\s+test\b/)) found.add("bun");
  // ponytail: repo_profile.ts also reads scripts.test, but buildProfile
  // persists a profile file as a side effect, so the one check is inlined here.
  const testScript = pkg.scripts?.test;
  if (typeof testScript === "string" && testScript.trim() !== "" && !NPM_DEFAULT_TEST.test(testScript)) {
    found.add("npm");
  }
}

export function buildTestMap(root: string, changed: readonly string[] = []): TestMap {
  const files = walk(root);
  const found = new Set<Runner>();
  for (const rel of files) {
    const name = basename(rel);
    const full = join(root, rel);
    if (name === "package.json") detectFromPackageJson(readText(full), found);
    else if (name === "pytest.ini" || name === "conftest.py") found.add("pytest");
    else if (name === "pyproject.toml" && /pytest/.test(readText(full))) found.add("pytest");
    else if (name === "setup.cfg" && /\[tool:pytest\]/.test(readText(full))) found.add("pytest");
    else if (name === "tox.ini" && /\[pytest\]/.test(readText(full))) found.add("pytest");
    else if (PY_TEST_RE.test(name)) found.add("pytest");
    else if (/^vitest\.config\.[cm]?[jt]s$/.test(name)) found.add("vitest");
    else if (/^jest\.config\.[cm]?[jt]s(on)?$/.test(name)) found.add("jest");
    else if (name === "go.mod" || GO_TEST_RE.test(name)) found.add("go");
    else if (name === "Cargo.toml") found.add("cargo");
  }
  const tests = files.filter(isTestFile);
  return {
    runners: RUNNER_ORDER.filter((r) => found.has(r)),
    tests,
    impacted: impactedTests({ tests }, changed),
  };
}

// Source stem a test file covers: search.test.ts -> search, test_ranker.py
// -> ranker, ranker_test.py -> ranker, handler_test.go -> handler.
function coveredStem(testRel: string): string {
  const name = basename(testRel);
  if (JS_TEST_RE.test(name)) return name.replace(JS_TEST_RE, "");
  if (name.startsWith("test_")) return name.slice(5, -3);
  return name.replace(/_test\.(py|go)$/, "");
}

// ponytail: stem match across the repo; same-named modules in different
// dirs over-select (safe for verify). Add import-graph tracing if too broad.
export function impactedTests(map: Pick<TestMap, "tests">, changed: readonly string[]): ImpactedTests {
  const out: ImpactedTests = {};
  for (const raw of changed) {
    const rel = raw.split(sep).join("/").replace(/^\.\//, "");
    if (isTestFile(rel)) {
      out[raw] = [rel];
      continue;
    }
    const stem = basename(rel, extname(rel));
    out[raw] = map.tests.filter((t) => coveredStem(t) === stem);
  }
  return out;
}
