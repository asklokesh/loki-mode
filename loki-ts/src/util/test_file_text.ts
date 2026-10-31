// util/test_file_text.ts -- pure test-file naming, import-spec and package.json runner helpers, split out of engine10/testmap.ts to keep the core line budget (TEN-CORE-TRIM). No I/O.
import { basename } from "node:path";
import type { RunnerName } from "../engine10/types.ts";
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
