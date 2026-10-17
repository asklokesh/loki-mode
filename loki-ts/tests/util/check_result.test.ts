import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { classifyRisk, classifyWithRerun, diffFiles, hasExecutedProof, hasExogenousProof, manifestDepsChanged, markExecuted, type ClassifyInput } from "../../src/util/check_result.ts";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const git = (cwd: string, ...a: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8" }).trim();
function repo(base: Record<string, string>, change: Record<string, string>): ReturnType<typeof classifyRisk> {
  const d = mkdtempSync(join(tmpdir(), "gates18-")); dirs.push(d);
  git(d, "init", "-q");
  const put = (m: Record<string, string>): void => { for (const [p, c] of Object.entries(m)) { mkdirSync(dirname(join(d, p)), { recursive: true }); writeFileSync(join(d, p), c); } };
  put(base); git(d, "add", "-A"); git(d, "commit", "-q", "-m", "base");
  const sha = git(d, "rev-parse", "HEAD"); put(change);
  return classifyRisk(diffFiles(d, sha), {});
}
const pkg = (o: object): string => JSON.stringify(o, null, 2) + "\n";
const FLAG = "manifest changed without lockfile";
const base = { "package.json": pkg({ scripts: { a: "x" }, dependencies: { left: "1.0.0" } }), "package-lock.json": "{}\n" };

describe("TEN-GATES-18 manifest without lockfile", () => {
  test("package.json dependency change alone is flagged, tier unchanged", () => {
    const r = repo(base, { "package.json": pkg({ scripts: { a: "x" }, dependencies: { left: "2.0.0" } }) });
    expect(r.advisories).toEqual([`${FLAG}: package.json`]);
    expect(r.summary).toContain(`advisory: ${FLAG}: package.json`);
    expect(r.tier).toBe("low");
  });
  test("scripts-only change is clean", () => {
    const r = repo(base, { "package.json": pkg({ scripts: { a: "y" }, dependencies: { left: "1.0.0" } }) });
    expect(r.advisories).toBeUndefined();
    expect(r.summary).not.toContain("advisory");
  });
  test("manifest plus lockfile is clean", () => {
    const r = repo(base, { "package.json": pkg({ dependencies: { left: "2.0.0" } }), "package-lock.json": "{\"v\":2}\n" });
    expect(r.advisories).toBeUndefined();
  });
  test("workspace package with root lockfile change is clean; without is flagged", () => {
    const b = { "packages/a/package.json": pkg({ dependencies: { x: "1" } }), "package-lock.json": "{}\n" };
    const c = { "packages/a/package.json": pkg({ dependencies: { x: "2" } }) };
    expect(repo(b, c).advisories).toEqual([`${FLAG}: packages/a/package.json`]);
    expect(repo(b, { ...c, "package-lock.json": "{\"v\":2}\n" }).advisories).toBeUndefined();
  });
  test("sibling dir lockfile does not satisfy another dir", () => {
    const b = { "a/package.json": pkg({ dependencies: { x: "1" } }), "b/package-lock.json": "{}\n" };
    const r = repo(b, { "a/package.json": pkg({ dependencies: { x: "2" } }), "b/package-lock.json": "{\"v\":2}\n" });
    expect(r.advisories).toEqual([`${FLAG}: a/package.json`]);
  });
  test("go.mod require change without go.sum is flagged; go directive only is clean", () => {
    const b = { "go.mod": "module m\n\ngo 1.21\n\nrequire a v1.0.0\n", "go.sum": "x\n" };
    expect(repo(b, { "go.mod": "module m\n\ngo 1.21\n\nrequire a v1.1.0\n" }).advisories).toEqual([`${FLAG}: go.mod`]);
    expect(repo(b, { "go.mod": "module m\n\ngo 1.22\n\nrequire a v1.0.0\n" }).advisories).toBeUndefined();
    expect(repo(b, { "go.mod": "module m\n\ngo 1.21\n\nrequire a v1.1.0\n", "go.sum": "y\n" }).advisories).toBeUndefined();
  });
  test("pyproject dependency change flagged; version bump clean; uv.lock pairs", () => {
    const b = { "pyproject.toml": "[project]\nname = \"p\"\nversion = \"1.0\"\ndependencies = [\n  \"requests>=2.0\",\n]\n", "uv.lock": "a\n" };
    expect(repo(b, { "pyproject.toml": b["pyproject.toml"].replace("2.0", "2.1") }).advisories).toEqual([`${FLAG}: pyproject.toml`]);
    expect(repo(b, { "pyproject.toml": b["pyproject.toml"].replace("version = \"1.0\"", "version = \"1.1\"") }).advisories).toBeUndefined();
    expect(repo(b, { "pyproject.toml": b["pyproject.toml"].replace("2.0", "2.1"), "uv.lock": "b\n" }).advisories).toBeUndefined();
  });
  test("new package.json with dependencies and no lockfile is flagged", () => {
    expect(repo({ "README.md": "x\n" }, { "package.json": pkg({ dependencies: { x: "1" } }) }).advisories).toEqual([`${FLAG}: package.json`]);
  });
  test("markExecuted keeps the advisory in the summary", () => {
    const r = repo(base, { "package.json": pkg({ dependencies: { left: "2.0.0" } }) });
    expect(markExecuted(r, ["full test command"]).summary).toContain(FLAG);
  });
  test("manifestDepsChanged: unparseable package.json counts as changed", () => {
    expect(manifestDepsChanged("package.json", "{}", "{bad", "")).toBe(true);
  });
});


// TEN-QUALITY-17: flaky classification for a test that fails then passes on one immediate rerun.

const RED: ClassifyInput = { kind: "test", ok: false, out: "Ran 3 tests in 0.002s\n\nFAILED (failures=1)\n" };
const GREEN: ClassifyInput = { kind: "test", ok: true, out: "Ran 3 tests in 0.002s\n\nOK\n" };

describe("classifyWithRerun", () => {
  test("fail then pass on rerun is flaky with rerun evidence", () => {
    const c = classifyWithRerun(RED, () => GREEN);
    expect(c.result).toBe("flaky");
    expect(c.rerun).toEqual({ first: "fail", second: "pass", n: 3 });
    expect(c.n).toBeUndefined();
  });
  test("deterministic fail stays fail", () => {
    expect(classifyWithRerun(RED, () => RED).result).toBe("fail");
  });
  test("fail then not_run on rerun stays fail", () => {
    expect(classifyWithRerun(RED, () => ({ ...GREEN, out: "Ran 0 tests in 0.000s\n\nOK\n" })).result).toBe("fail");
  });
  test("a first pass is never rerun", () => {
    let calls = 0;
    expect(classifyWithRerun(GREEN, () => { calls++; return RED; }).result).toBe("pass");
    expect(calls).toBe(0);
  });
  test("static and not_run are never rerun", () => {
    let calls = 0;
    const rr = (): ClassifyInput => { calls++; return GREEN; };
    expect(classifyWithRerun({ kind: "static", ok: false, out: "" }, rr).result).toBe("fail");
    expect(classifyWithRerun({ ...RED, cut: true }, rr).result).toBe("not_run");
    expect(calls).toBe(0);
  });
  test("flaky is never executed or exogenous proof", () => {
    const c = classifyWithRerun(RED, () => GREEN);
    expect(hasExecutedProof([c])).toBe(false);
    expect(hasExogenousProof([{ name: "pytest:tests/a.py", ...c }], { addedFiles: [], wallFiles: [] })).toBe(false);
  });
});
