// engine10/testmap.ts -- runner detection and the impacted-test map (E-05).
//
// Detects runners from real files only (never from a prompt or a guess), per
// docs/v10/ENGINE.md section 8: pytest, vitest, jest, bun, npm, go, cargo.
// Maps each changed file to the test files that import or reference it (grep
// over test file text, per section 8), unioned with a same-stem naming floor
// so a same-package test with nothing of its own to import (Go) or a
// deliberately import-free fixture never drops to zero tests: this is
// fast-verify input, and under-selecting is the unsafe direction there.
// Pure read; writes nothing.
//
// TestMap/TestRef/TestMapProvider are E-01's contract (types.ts). This file
// never edits types.ts; EngineTestMap below adds the evidence/commands/
// sourceRefs fields the contract does not carry, disclosed here rather than
// smuggled into the shared type.

import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";
import type { RunnerName, TestMap, TestMapProvider, TestRef } from "./types.ts";

/** One command shape per runner (ENGINE.md section 8 table). `<files>` is a
 *  placeholder the caller (E-09 verify) fills with the selected paths.
 *  `coarse: true` means the command always runs the whole suite: npm and
 *  cargo have no reliable per-file selection. */
export interface CommandSpec {
  cmd: string;
  coarse: boolean;
}

/** Extra fields beyond E-01's TestMap. `sourceRefs` is read back by
 *  `impacted()` and is not meant for callers outside this file. */
export interface EngineTestMap extends TestMap {
  /** Repo-relative file that proved each detected runner. */
  evidence: Partial<Record<RunnerName, string>>;
  commands: Partial<Record<RunnerName, CommandSpec>>;
  /** source basename -> repo-relative test paths that import/reference it. */
  readonly sourceRefs: Record<string, string[]>;
}

const RUNNER_ORDER: readonly RunnerName[] = ["pytest", "vitest", "jest", "bun", "npm", "go", "cargo"];
const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "target", "coverage",
  ".venv", "venv", "__pycache__", ".tox", ".pytest_cache", ".loki", ".next",
]);
const NPM_DEFAULT_TEST = /no test specified/;
const JS_TEST_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const PY_TEST_RE = /^(test_.+|.+_test)\.py$/;
const GO_TEST_RE = /_test\.go$/;

const COMMANDS: Record<RunnerName, CommandSpec> = {
  pytest: { cmd: "python -m pytest -q <files>", coarse: false },
  vitest: { cmd: "npx vitest run <files>", coarse: false },
  jest: { cmd: "npx jest <files>", coarse: false },
  bun: { cmd: "bun test <files>", coarse: false },
  npm: { cmd: "npm test --silent", coarse: true },
  go: { cmd: "go test ./<pkg dirs>", coarse: false },
  cargo: { cmd: "cargo test", coarse: true },
};

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

function normalizeRel(raw: string): string {
  return raw.split(sep).join("/").replace(/^\.\//, "");
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

function detectFromPackageJson(text: string, rel: string, mark: (r: RunnerName, file: string) => void): void {
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
  // ponytail: repo_profile.ts also reads scripts.test, but buildProfile
  // persists a profile file as a side effect, so the one check is inlined here.
  const testScript = pkg.scripts?.test;
  if (typeof testScript === "string" && testScript.trim() !== "" && !NPM_DEFAULT_TEST.test(testScript)) {
    mark("npm", rel);
  }
}

// Import/reference specifiers a test file's text can carry, per language.
// JS: `from "./search"` / `require("./search")`. Python: `from app.ranker
// import x` / `import app.ranker`. Matched textually (grep), never resolved
// against a module graph.
const JS_SPEC_RE = /(?:from\s+|require\(\s*)['"]([^'"]+)['"]/g;
const PY_FROM_RE = /^\s*from\s+([\w.]+)\s+import\b/gm;
const PY_IMPORT_RE = /^\s*import\s+([\w.]+)/gm;

function jsSpecToBasename(spec: string): string {
  const clean = spec.replace(/^\.*\/+/, "");
  const base = clean.split("/").pop() ?? clean;
  return base.replace(/\.[cm]?[jt]sx?$/, "");
}

function pySpecToBasename(spec: string): string {
  const parts = spec.split(".");
  return parts[parts.length - 1] ?? spec;
}

/** Source basenames a test file's text imports or references (section 8). */
function referencedBasenames(text: string): Set<string> {
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

// Source stem a test file covers by naming alone: search.test.ts -> search,
// test_ranker.py -> ranker, handler_test.go -> handler. This is the floor
// the import/reference grep adds on top of, never a replacement for it: a
// same-package Go test that imports nothing of its own (handler_test.go for
// handler.go), or a fixture kept import-free on purpose (test_ranker.py, so
// no collector hits an ImportError), would otherwise map to zero tests --
// the unsafe direction for E-09 fast verify. `from pkg import mod` also
// resolves to `pkg`, not `mod`, with grep alone; the naming floor covers
// the common `test_mod.py` case regardless of exactly what the file imports.
function coveredStem(testPath: string): string {
  const name = basename(testPath);
  if (JS_TEST_RE.test(name)) return name.replace(JS_TEST_RE, "");
  if (name.startsWith("test_")) return name.slice(5, -3);
  return name.replace(/_test\.(py|go)$/, "");
}

/** Synchronous core: scans `root`, returns the full detected map. `detect()`
 *  on TestMapProviderImpl just wraps this in a Promise per the interface. */
export function buildTestMap(root: string): EngineTestMap {
  const files = walk(root);
  const found = new Set<RunnerName>();
  const evidence: Partial<Record<RunnerName, string>> = {};
  const mark = (r: RunnerName, file: string): void => {
    found.add(r);
    if (!(r in evidence)) evidence[r] = file;
  };

  for (const rel of files) {
    const name = basename(rel);
    const full = join(root, rel);
    if (name === "package.json") detectFromPackageJson(readText(full), rel, mark);
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

  // Per-file test entries exist only for narrowly-selectable runners: npm
  // and cargo run the whole suite (coarse), so no individual file earns a
  // TestRef for them.
  const jsRunner: RunnerName | null = found.has("vitest") ? "vitest" : found.has("jest") ? "jest" : found.has("bun") ? "bun" : null;
  const tests: TestRef[] = [];
  for (const rel of files) {
    const name = basename(rel);
    if (JS_TEST_RE.test(name) && jsRunner) tests.push({ runner: jsRunner, path: rel });
    else if (PY_TEST_RE.test(name) && found.has("pytest")) tests.push({ runner: "pytest", path: rel });
    else if (GO_TEST_RE.test(name) && found.has("go")) tests.push({ runner: "go", path: rel });
  }

  // Object.create(null): keys come from grep'd file content, so a source
  // named e.g. "constructor" must not collide with Object.prototype.
  const sourceRefs: Record<string, string[]> = Object.create(null);
  for (const t of tests) {
    const names = referencedBasenames(readText(join(root, t.path)));
    names.add(coveredStem(t.path));
    for (const n of names) {
      (sourceRefs[n] ??= []).push(t.path);
    }
  }

  const runners = RUNNER_ORDER.filter((r) => found.has(r));
  const commands: Partial<Record<RunnerName, CommandSpec>> = {};
  for (const r of runners) commands[r] = COMMANDS[r];

  return { runners, tests, evidence, commands, sourceRefs };
}

/** Test refs impacted by `changedFiles`: a changed test maps to itself; a
 *  changed source maps to every test that imports/references its basename
 *  (built by `buildTestMap`'s grep, read back from `map.sourceRefs`). */
export function impactedRefs(map: TestMap, changedFiles: readonly string[]): TestRef[] {
  // `map` is always what buildTestMap/detect() returned; sourceRefs is this
  // file's own addition to the shared TestMap contract (see EngineTestMap).
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
    for (const p of sourceRefs[stem] ?? []) {
      add(map.tests.find((t) => t.path === p));
    }
  }
  return out;
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
