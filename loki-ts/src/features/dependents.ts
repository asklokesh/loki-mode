// RX-3: tests of the depth-1 reverse dependents of changed JS, TS and Python sources. impacted() finds tests that import a changed file; a test of a module that imports it ran nothing, so a break there could seal VERIFIED.
// Imports are resolved to repo paths (relative specs, dotted Python modules, `from pkg import mod`), never matched by bare basename. Scans every tracked file (listProjectFiles), bounded by bytes and time.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { listProjectFiles } from "../util/safe_git.ts";
import { JS_SPEC_RE } from "../util/test_file_text.ts";
import type { TestMap, TestRef } from "../engine10/types.ts";
import { aliasCandidates, inRepo, posix, readJsResolve, type JsResolve } from "../util/js_resolve.ts";

export const MAX_DEPENDENT_TESTS = 20; // hard cap on extra test files per verify; depth is fixed at 1
const SCAN_MAX_BYTES = 48_000_000, SCAN_MAX_MS = 4000, FILE_MAX_BYTES = 256_000;
const JS = /\.(?:[cm]?[jt]sx?)$/, PY = /\.py$/, JS_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const PY_FROM = /^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n#]+)/gm, PY_IMP = /^[ \t]*import[ \t]+([\w., \t]+)/gm;
const pyMod = (base: string): string[] => [`${base}.py`, `${base}/__init__.py`];
/** Repo paths a source file's imports can resolve to (every candidate; the caller intersects with the changed set). */
export function importTargets(rel: string, text: string, js?: JsResolve | null): string[] {
  const out: string[] = [], dir = dirname(rel);
  if (JS.test(rel)) for (const m of text.matchAll(JS_SPEC_RE)) {
    const spec = m[1] ?? "";
    const cands = spec.startsWith(".") ? [posix(join(dir, spec))] : js ? aliasCandidates(spec, js) : [];
    for (const p of cands.filter(inRepo)) { const stem = p.replace(/\.[cm]?[jt]sx?$/, ""); out.push(p, ...JS_EXT.flatMap((e) => [stem + e, `${p}/index${e}`])); }
  } else if (PY.test(rel)) {
    const add = (dots: number, mod: string, names: string[]): void => {
      const up = dots > 0 ? join(dir, ...Array(dots - 1).fill("..")) : "", roots = dots > 0 ? [up] : [".", dir], path = mod.split(".").filter(Boolean).join("/");
      for (const r of roots) { const b = join(r, path); if (path) out.push(...pyMod(posix(b)).map(posix)); for (const n of names) out.push(...pyMod(posix(join(b, n)))); }
    };
    for (const m of text.matchAll(PY_FROM)) { const dots = /^\.*/.exec(m[1]!)![0].length; add(dots, m[1]!.slice(dots), m[2]!.replace(/[()]/g, "").split(",").map((s) => s.trim().split(/\s+as\s+/)[0]!).filter((s) => /^\w+$/.test(s))); }
    for (const m of text.matchAll(PY_IMP)) for (const part of m[1]!.split(",")) add(0, part.trim().split(/\s+as\s+/)[0]!, []);
  }
  return out;
}
export interface Dependents { tests: TestRef[]; dropped: number; truncated: boolean }
const read = (repoDir: string, rel: string): string => { try { return readFileSync(join(repoDir, rel), "utf8").slice(0, FILE_MAX_BYTES); } catch { return ""; } };
const importsAny = (text: string, rel: string, set: ReadonlySet<string>, js: JsResolve | null): boolean => importTargets(rel, text, js).some((t) => set.has(t));
/** Non-test sources, then tests, that import a changed source; tests not in `already`, sorted, at most MAX_DEPENDENT_TESTS (dropped counts the rest). truncated: the byte or time bound stopped the scan. */
export function dependentTests(repoDir: string, map: TestMap, changed: readonly string[], already: readonly TestRef[]): Dependents {
  const js = readJsResolve(repoDir), chg = new Set(changed.map(posix).filter((f) => JS.test(f) || PY.test(f))), none = { tests: [], dropped: 0, truncated: false };
  if (chg.size === 0) return none;
  const isTest = new Set(map.tests.map((t) => t.path)), have = new Set(already.map((t) => t.path)), t0 = Date.now();
  let bytes = 0, truncated = false; const deps = new Set<string>();
  for (const rel of listProjectFiles(repoDir)) {
    if (!(JS.test(rel) || PY.test(rel)) || isTest.has(rel) || chg.has(rel)) continue;
    if (bytes > SCAN_MAX_BYTES || Date.now() - t0 > SCAN_MAX_MS) { truncated = true; break; }
    const text = read(repoDir, rel); bytes += text.length; if (importsAny(text, rel, chg, js)) deps.add(rel);
  }
  if (deps.size === 0) return { ...none, truncated };
  const all = map.tests.filter((t) => !have.has(t.path) && importsAny(read(repoDir, t.path), t.path, deps, js)).sort((a, b) => a.path.localeCompare(b.path));
  return { tests: all.slice(0, MAX_DEPENDENT_TESTS), dropped: Math.max(0, all.length - MAX_DEPENDENT_TESTS), truncated };
}
/** NOT PROVEN lines for a dependents result. */
export const dependentNotes = (d: Dependents): string[] => [...(d.truncated ? ["reverse-dependent scan hit its byte or time bound: some importers of changed files may not have been tested"] : []), ...(d.dropped ? [`reverse-dependent tests dropped by the ${MAX_DEPENDENT_TESTS}-file cap: ${d.dropped}`] : [])];
