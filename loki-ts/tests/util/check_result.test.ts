import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deepGaps, classifyCheck, isExitCodedScript, EXIT_CODED_COUNT, UNMEASURED_REASON, baseJobs, mapPool, verifyJobs, classifyRisk, classifyWithRerun, diffFiles, hasExecutedProof, hasExogenousProof, manifestDepsChanged, markExecuted, type ClassifyInput } from "../../src/util/check_result.ts";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const git = (cwd: string, ...a: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8" }).trim();
function repo(base: Record<string, string>, change: Record<string, string | null>): ReturnType<typeof classifyRisk> {
  const d = mkdtempSync(join(tmpdir(), "gates18-")); dirs.push(d);
  git(d, "init", "-q");
  const put = (m: Record<string, string | null>): void => { for (const [p, c] of Object.entries(m)) { if (c === null) { rmSync(join(d, p)); continue; } mkdirSync(dirname(join(d, p)), { recursive: true }); writeFileSync(join(d, p), c); } };
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

describe("mapPool and jobs env (TEN-SPEED-18/19 shared pool)", () => {
  const withEnv = (k: string, v: string | undefined, f: () => void): void => { const o = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; try { f(); } finally { if (o === undefined) delete process.env[k]; else process.env[k] = o; } };
  test("results keep input order whatever order they finish in", async () => {
    const r = await mapPool([30, 1, 15, 2], 4, async (ms) => { await new Promise((res) => setTimeout(res, ms)); return ms; });
    expect(r).toEqual([30, 1, 15, 2]);
  });
  test("never runs more than jobs at once; jobs below 1 means sequential", async () => {
    for (const jobs of [2, 0]) {
      let live = 0, peak = 0;
      await mapPool([1, 2, 3, 4, 5], jobs, async () => { peak = Math.max(peak, ++live); await new Promise((res) => setTimeout(res, 3)); live--; });
      expect(peak).toBe(Math.max(1, jobs));
    }
  });
  test("stop() prevents new items from starting and leaves their slots empty", async () => {
    let n = 0;
    const r = await mapPool([1, 2, 3], 1, async (x) => { n++; return x; }, () => n >= 1);
    expect(n).toBe(1); expect(r.filter((x) => x !== undefined)).toEqual([1]);
  });
  test("default 1, invalid falls back to 1, valid is capped", () => {
    for (const [fn, key, cap] of [[verifyJobs, "LOKI_E10_VERIFY_JOBS", 8], [baseJobs, "LOKI_E10_BASE_JOBS", 16]] as const) {
      withEnv(key, undefined, () => expect(fn()).toBe(1));
      withEnv(key, "abc", () => expect(fn()).toBe(1));
      withEnv(key, "0", () => expect(fn()).toBe(1));
      withEnv(key, "-3", () => expect(fn()).toBe(1));
      withEnv(key, "3", () => expect(fn()).toBe(3));
      withEnv(key, "999", () => expect(fn()).toBe(cap));
    }
  });
});

describe("FC-SEAL-NA-AS-UNPROVEN deepGaps", () => {
  const r = (tier: string, selected: string[], deferred: string[]) => ({ tier, checks_selected: selected, checks_deferred: deferred });
  const base = ["targeted tests", "lint of changed files"];
  test("no usable risk record: every deep item NOT PROVEN, none N/A", () => {
    for (const bad of [undefined, null, {}, { tier: "weird", checks_selected: [], checks_deferred: [] }]) expect(deepGaps(bad, [])).toEqual({ notProven: ["full suite", "app boot", "council", "security scan"], notSelected: [] });
  });
  test("low tier: nothing was asked for, all of it is not selected", () => {
    const g = deepGaps(r("low", base, ["full test command", "reviewer", "council", "security scan"]), []);
    expect(g.notProven).toEqual([]); expect(g.notSelected).toContain("not selected by risk tier: reviewer"); expect(g.notSelected).toContain("not selected by risk tier: full suite");
  });
  test("medium: a selected full test command that did not run is a gap; one that ran drops the full suite", () => {
    const sel = [...base, "full test command", "one reviewer"];
    expect(deepGaps(r("medium", sel, ["full test command", "one reviewer"]), []).notProven).toEqual(["full suite", "full test command", "one reviewer"]);
    const ran = deepGaps(r("medium", sel, ["one reviewer"]), []);
    expect(ran.notProven).toEqual(["one reviewer"]); expect(ran.notSelected).toContain("not selected by risk tier: council");
  });
  test("medium reviewer: credited only by a review that really ran", () => {
    const sel = [...base, "full test command", "one reviewer"], rec = r("medium", sel, ["one reviewer"]);
    expect(deepGaps(rec, []).notProven).toContain("one reviewer"); // tier alone never credits it
    expect(deepGaps(rec, [], [], false).notProven).toContain("one reviewer"); // a cross-review that did not run stays NOT PROVEN
    expect(deepGaps(rec, [], [], true).notProven).not.toContain("one reviewer"); // seal's cross-review returned a verdict
    expect(deepGaps(rec, [], [{ name: "council", result: "pass" }]).notProven).not.toContain("one reviewer"); // deep reviewer session ran
    expect(deepGaps(rec, [], [{ name: "council", result: "not_run" }]).notProven).toContain("one reviewer");
    expect(deepGaps(r("high", [...base, "full test command", "full suite", "council", "security scan"], ["council"]), [], [], true).notProven).toContain("council"); // a cross-review does not credit high's council
    expect(deepGaps(r("low", base, ["full test command", "reviewer", "council", "security scan"]), [], [], true).notProven).toEqual([]);
  });
  test("PR-FIRST-4: a security scan verify executed is credited; a not_run or a look-alike name never is", () => {
    const rec = r("high", [...base, "full test command", "full suite", "council", "security scan"], ["council", "security scan"]);
    for (const result of ["pass", "fail"]) expect(deepGaps(rec, [{ name: "security scan", result }]).notProven).not.toContain("security scan");
    for (const result of ["not_run", "flaky", undefined]) expect(deepGaps(rec, [{ name: "security scan", result }]).notProven).toContain("security scan");
    expect(deepGaps(rec, [{ name: "security scan x", result: "pass" }]).notProven).toContain("security scan");
    expect(deepGaps(rec, [{ name: "council", result: "pass" }]).notProven).toContain("council"); // verify never runs the council; only the deep session credits it
  });
  test("an executed deep check is dropped", () => {
    const g = deepGaps(r("high", [...base, "full test command", "full suite", "council", "security scan"], ["council", "security scan"]), [], [{ name: "security scan", result: "pass" }]);
    expect(g.notProven).toEqual(["council"]);
  });
});

describe("FC-FULL-SUITE-EXIT-CODED-SCRIPT", () => {
  const checker = "python3 .github/scripts/check_workflow_hardening.py", okOut = "OK: checked 3 job(s) that call Claude and found no problems.";
  const cls = (cmd: string, ok: boolean, out: string) => classifyCheck({ kind: "test", ok, out, exitCoded: isExitCodedScript(cmd) });
  test("a python checker script exiting 0 with no summary is an exit-coded pass", () => {
    expect(cls(checker, true, okOut)).toEqual({ result: "pass", count: EXIT_CODED_COUNT });
  });
  test("the same script exiting 1 is a fail", () => {
    expect(cls(checker, false, "ERROR: job x is unhardened").result).toBe("fail");
  });
  test("python3 -m pytest with no summary stays not_run UNMEASURED", () => {
    expect(cls("python3 -m pytest", true, okOut)).toEqual({ result: "not_run", reason: UNMEASURED_REASON });
  });
  test("npm test with no summary stays not_run", () => {
    expect(cls("npm test", true, okOut).result).toBe("not_run");
  });
  test("a wrapper script that prints a real pytest summary keeps its count, exactly as without the flag", () => {
    const out = "collecting\n============== 5 passed in 0.12s ==============\n";
    expect(cls("bash ci.sh", true, out)).toEqual({ result: "pass", n: 5 });
    expect(classifyCheck({ kind: "test", ok: true, out })).toEqual({ result: "pass", n: 5 });
  });
  test("an exit-coded pass carries no n, so it is never executed proof", () => {
    expect(hasExecutedProof([cls(checker, true, okOut)])).toBe(false);
  });
  test("framework and ambiguous commands are never exit-coded", () => {
    for (const c of ["pytest -q", "python -m unittest", "npx jest", "yarn test", "bun test", "node --test", "go test ./...", "cargo test", "make check", "./run.sh", "bash scripts/run_tests.sh", "(cd pkg && pnpm run test)", "dotnet test", "mvn test", "tox", "nox -s lint", "python3 -c 'print(1)'"]) expect(isExitCodedScript(c)).toBe(false);
    expect(isExitCodedScript(`(cd tools && ${checker})`)).toBe(true);
  });
});

describe("FC-CRITICAL-CLASS-GRADED-LOW critical classes derived from the repo", () => {
  const OWNERS = "# owners\n*  @org/all\n/ship/  @org/release\n*.pem  @org/sec\n";
  const cases: { name: string; base: Record<string, string>; change: Record<string, string>; tier: "low" | "high"; reason?: string }[] = [
    { name: "CODEOWNERS directory entry", base: { CODEOWNERS: OWNERS }, change: { "ship/step.txt": "x\n" }, tier: "high", reason: "CODEOWNERS /ship/" },
    { name: ".github/CODEOWNERS glob entry", base: { ".github/CODEOWNERS": OWNERS }, change: { "certs/a.pem": "x\n" }, tier: "high", reason: "CODEOWNERS *.pem" },
    { name: ".loki/config.json critical_paths", base: { ".loki/config.json": JSON.stringify({ critical_paths: ["lib/gate/**"] }) }, change: { "lib/gate/a.txt": "x\n" }, tier: "high", reason: "critical_paths lib/gate/**" },
    { name: "added signing call", base: { "a.txt": "x\n" }, change: { "tool.sh": "cosign sign --key k img\n" }, tier: "high", reason: "added signing call" },
    { name: "added publish command", base: { "a.txt": "x\n" }, change: { "rel.sh": "npm publish --tag latest\n" }, tier: "high", reason: "added publish command" },
    { name: "added git push", base: { "a.txt": "x\n" }, change: { "up.sh": "git push origin main\n" }, tier: "high", reason: "added git push" },
    { name: "added credential assignment", base: { "a.txt": "x\n" }, change: { "c.py": "api_key = load()\n" }, tier: "high", reason: "added credential or token" },
    { name: "plain docs change with owners file stays low", base: { CODEOWNERS: OWNERS }, change: { "docs/guide.md": "run git push to share\n" }, tier: "low" },
    { name: "match-everything owner line is not critical", base: { CODEOWNERS: "* @org/all\n" }, change: { "src/a.txt": "x\n" }, tier: "low" },
  ];
  for (const c of cases) test(c.name, () => {
    const r = repo(c.base, c.change);
    expect(r.tier).toBe(c.tier);
    if (c.reason) { expect(r.reasons.join(" ")).toContain(c.reason); expect(r.summary).toContain("critical class"); expect(r.checks_selected).toEqual(expect.arrayContaining(["full test command", "full suite", "council", "security scan"])); }
    else expect(r.stats.critical).toBeUndefined();
  });
});

describe("FC-CRITICAL-CLASS-GRADED-LOW rules are read from the base tree, never the diff", () => {
  const OWNERS = "/ship/  @org/release\n";
  const cfg = JSON.stringify({ critical_paths: ["lib/gate/**"] });
  const cases: { name: string; base: Record<string, string>; change: Record<string, string | null>; reason: string }[] = [
    { name: "emptied CODEOWNERS still grades the owned path", base: { CODEOWNERS: OWNERS }, change: { CODEOWNERS: "", "ship/a.txt": "x\n" }, reason: "CODEOWNERS /ship/" },
    { name: "git rm CODEOWNERS still grades the owned path", base: { CODEOWNERS: OWNERS }, change: { CODEOWNERS: null, "ship/a.txt": "x\n" }, reason: "CODEOWNERS /ship/" },
    { name: "critical_paths set to [] still grades the path", base: { ".loki/config.json": cfg }, change: { ".loki/config.json": JSON.stringify({ critical_paths: [] }), "lib/gate/a.txt": "x\n" }, reason: "critical_paths lib/gate/**" },
    { name: "root CODEOWNERS shadowing docs/CODEOWNERS still grades the path", base: { "docs/CODEOWNERS": OWNERS }, change: { CODEOWNERS: "* @org/all\n", "ship/a.txt": "x\n" }, reason: "CODEOWNERS /ship/" },
    { name: "touching CODEOWNERS alone is critical", base: { CODEOWNERS: OWNERS }, change: { CODEOWNERS: "/ship/  @someone-else\n" }, reason: "ownership file CODEOWNERS changed" },
    { name: "touching .loki/config.json alone is critical", base: { ".loki/config.json": cfg }, change: { ".loki/config.json": "{}\n" }, reason: "critical-paths config .loki/config.json changed" },
  ];
  for (const c of cases) test(c.name, () => {
    const r = repo(c.base, c.change);
    expect(r.tier).toBe("high");
    expect(r.reasons.join(" ")).toContain(c.reason);
  });
});

describe("FC-CRITICAL-CLASS-GRADED-LOW built-in floor with no CODEOWNERS and no config", () => {
  const cases: { name: string; path: string; tier: "low" | "high" }[] = [
    { name: "seal path", path: "src/stages/seal.ts", tier: "high" },
    { name: "verifier path", path: "lib/verifier/run.py", tier: "high" },
    { name: "publish path", path: "scripts/publish.sh", tier: "high" },
    { name: "release path", path: "tools/release/notes.ts", tier: "high" },
    { name: "signing path", path: "pkg/signing/key_ops.go", tier: "high" },
    { name: "security path", path: "app/security/policy.ts", tier: "high" },
    { name: "auth path", path: "web/auth_handler.ts", tier: "high" },
    { name: "similar words are not tokens (signal, design, sealed-ish)", path: "src/signal_design.ts", tier: "low" },
    { name: "a test file is not graded by its path", path: "tests/seal.test.ts", tier: "low" },
    { name: "a shell test under tests/ is not graded by its path", path: "tests/test-seal-check.sh", tier: "low" },
    { name: "a doc is not graded by its path", path: "docs/release-notes.md", tier: "low" },
    { name: "ordinary source stays low", path: "src/render/list.ts", tier: "low" },
  ];
  for (const c of cases) test(c.name, () => {
    const r = repo({ "README.txt": "x\n" }, { [c.path]: "export const a = 1;\n" });
    expect(r.tier).toBe(c.tier);
    if (c.tier === "high") expect(r.reasons.join(" ")).toContain("trust boundary");
  });
});
