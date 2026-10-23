import { setSpawnTimeout } from "../preload.ts";
setSpawnTimeout();
// T4: reviewer brief. Ranking, not-measured path, with-coverage path (lcov produced by a real
// `bun test --coverage` run in a fixture repo), and the opt-out flag.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callerCounts, changedLines, renderBrief, reviewerBriefEnabled, leadBlock, parseRiskDecls, type BriefFacts } from "../../src/util/reviewer_brief.ts";

const git = (cwd: string, a: string[]): string => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
let dir: string; let base: string;

function commit(msg: string): void { git(dir, ["add", "-A"]); git(dir, ["-c", "user.name=t", "-c", "user.email=t@e.x", "commit", "-q", "-m", msg]); }

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "e10-brief-"));
  git(dir, ["init", "-q"]);
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "src/b.ts"), "export function b(x: number) {\n  return x + 1;\n}\n");
  writeFileSync(join(dir, "src/c.ts"), 'import { a } from "./a.ts";\nimport { b } from "./b";\nexport const c = a + b(1);\n');
  writeFileSync(join(dir, "src/d.ts"), 'import { a } from "./a";\nexport const d = a;\n');
  writeFileSync(join(dir, "README.md"), "x\n");
  commit("init");
  base = git(dir, ["rev-parse", "HEAD"]).trim();
  writeFileSync(join(dir, "src/a.ts"), "export const a = 2;\n");
  writeFileSync(join(dir, "src/b.ts"), "export function b(x: number) {\n  if (x > 100) {\n    return -1;\n  }\n  return x + 1;\n}\n");
  writeFileSync(join(dir, "README.md"), "y\n");
  commit("change a and b");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("reviewer brief", () => {
  test("ranks changed files by caller count, ties by name", () => {
    const out = renderBrief({ repoDir: dir, baseSha: base });
    const section = out.split("### Changed files by caller count")[1]!.split("###")[0]!;
    expect(section.trim().split("\n")).toEqual(["- src/a.ts: 2 callers", "- src/b.ts: 1 caller", "- README.md: callers n/a (not a JS/TS module)"]);
    expect(callerCounts(dir, ["src/a.ts"]).get("src/a.ts")).toBe(2);
  });

  test("behavior changes: plan wins, then commit summary, else not stated", () => {
    expect(renderBrief({ repoDir: dir, baseSha: base, plan: "step one" })).toContain("Plan:\nstep one");
    expect(renderBrief({ repoDir: dir, baseSha: base })).toContain("Commit summary:\n- change a and b");
    expect(renderBrief({ repoDir: dir, baseSha: "" })).toContain("### Behavior changes\nnot stated");
  });

  test("no coverage file: NOT MEASURED with a reason, never a guess", () => {
    expect(existsSync(join(dir, "coverage"))).toBe(false);
    const out = renderBrief({ repoDir: dir, baseSha: base });
    expect(out).toContain("uncovered lines: NOT MEASURED (no coverage report from an executed test run");
  });

  test("changedLines reads added line numbers", () => {
    const m = changedLines(dir, base)!;
    expect(m.get("src/a.ts")).toEqual([1]);
    expect(m.get("src/b.ts")).toEqual([2, 3, 4]);
  });

  test("with real lcov from bun test --coverage: lists only the uncovered changed lines", () => {
    writeFileSync(join(dir, "b.test.ts"), 'import { test, expect } from "bun:test";\nimport { b } from "./src/b.ts";\ntest("b", () => { expect(b(1)).toBe(2); });\n');
    execFileSync(process.execPath, ["test", "--coverage", "--coverage-reporter=lcov", "b.test.ts"], { cwd: dir, stdio: "pipe" });
    expect(existsSync(join(dir, "coverage/lcov.info"))).toBe(true);
    const future = new Date(Date.now() + 5000);
    utimesSync(join(dir, "coverage/lcov.info"), future, future);
    const section = renderBrief({ repoDir: dir, baseSha: base }).split("### Changed lines no test covers")[1]!;
    expect(section).toContain("- src/b.ts: 3");
    expect(section).not.toContain("NOT MEASURED (no coverage");
    expect(section).toContain("absent from the coverage report): README.md, src/a.ts");
  });

  test("stale coverage (older than a changed file) is NOT MEASURED", () => {
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(join(dir, "coverage/lcov.info"), past, past);
    expect(renderBrief({ repoDir: dir, baseSha: base })).toContain("NOT MEASURED (coverage report is older than");
  });

  test("opt-out flag", () => {
    expect(reviewerBriefEnabled({ LOKI_REVIEWER_BRIEF: "0" })).toBe(false);
    expect(reviewerBriefEnabled({})).toBe(true);
  });
});

describe("reviewer brief v2", () => {
  // REVIEWER-BRIEF-V2: the decision block at the top of the reviewer brief. Golden output for a VERIFIED, a PARTIAL
  // and a missing-facts receipt, out-of-scope listing, and "no line claims a fact the receipt lacks".

  const git = (cwd: string, a: string[]): string => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  let dir: string; let base: string;
  const commit = (m: string): void => { git(dir, ["add", "-A"]); git(dir, ["-c", "user.name=t", "-c", "user.email=t@e.x", "commit", "-q", "-m", m]); };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "e10-brief2-"));
    git(dir, ["init", "-q"]);
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "src/b.ts"), "export const b = 1;\n");
    writeFileSync(join(dir, "src/c.ts"), "export const c = 1;\n");
    commit("init");
    base = git(dir, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(dir, "src/a.ts"), "export const a = 2;\nexport const a2 = 3;\n");
    writeFileSync(join(dir, "src/b.ts"), "export const b = 2;\n");
    writeFileSync(join(dir, "src/c.ts"), "export const c = 2;\n");
    commit("change");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const verified: BriefFacts = {
    runId: "run-1", verdict: "VERIFIED", receiptSha256: "abcdef0123456789".repeat(4),
    receipt: { checks: [{ name: "t1", result: "pass" }, { name: "t2", result: "pass" }], mutation_proof: "test fails without the fix: yes", not_proven: [] },
    intentCard: ["What I think you want: x", "Acceptance: y"],
    declaredFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
    risks: [{ path: "src/b.ts", risk: 2, why: "changes b" }, { path: "src/a.ts", line: 2, risk: 3, why: "new export a2" }],
  };

  describe("reviewer brief v2 lead block", () => {
    test("golden VERIFIED", () => {
      expect(leadBlock(dir, base, verified)).toBe([
        "## Reviewer brief",
        "Verdict: VERIFIED (seal receipt abcdef012345)",
        "Look here first (risk as declared by the plan model):",
        "- src/a.ts:2 (risk 3): new export a2",
        "- src/b.ts:1 (risk 2): changes b",
        "Proven:",
        "- checks run: 2 (2 pass, 0 fail, 0 not_run)",
        "- mutation proof: test fails without the fix: yes",
        "- intent card: recorded (1 acceptance line)",
        "NOT PROVEN: none recorded",
        "Outside the declared scope: none",
        "Verify locally: loki verify run-1",
        "",
      ].join("\n"));
    });

    test("FC-PR-BODY-PUBLIC-HYGIENE: a base-red check is labeled and a long flag ends with an ellipsis", () => {
      const flag = `cross-review flag (claude): ${"a complete sentence about missing tests. ".repeat(10)}`.trim();
      const f: BriefFacts = { ...verified, receipt: { checks: [{ name: "t1", result: "pass" }, { name: "lint", result: "fail", pre_red: true }], not_proven: [flag] } };
      const out = leadBlock(dir, base, f);
      expect(out).toContain("- checks run: 2 (1 pass, 1 fail, 0 not_run; 1 fail already failing on base, not caused by this change)");
      const line = out.split("\n").find((l) => l.startsWith("- cross-review flag"))!;
      expect(line.endsWith("...")).toBe(true);
      const short = leadBlock(dir, base, { ...f, receipt: { ...f.receipt, not_proven: ["short whole flag."] } });
      expect(short).toContain("- short whole flag.\n");
    });

    test("golden PARTIAL", () => {
      const f: BriefFacts = { ...verified, verdict: "PARTIAL", receipt: { checks: [{ name: "t1", result: "pass" }, { name: "t2", result: "not_run" }], not_proven: ["not run: t2", "no tests executed"] }, declaredFiles: ["src/a.ts"] };
      expect(leadBlock(dir, base, f)).toBe([
        "## Reviewer brief",
        "Verdict: PARTIAL (seal receipt abcdef012345)",
        "Look here first (risk as declared by the plan model):",
        "- src/a.ts:2 (risk 3): new export a2",
        "- src/b.ts:1 (risk 2): changes b",
        "Proven:",
        "- checks run: 2 (1 pass, 0 fail, 1 not_run)",
        "- mutation proof: NOT RECORDED",
        "- intent card: recorded (1 acceptance line)",
        "NOT PROVEN:",
        "- not run: t2",
        "- no tests executed",
        "Outside the declared scope (2): src/b.ts, src/c.ts",
        "Verify locally: loki verify run-1",
        "",
      ].join("\n"));
    });

    test("golden missing facts: every absent fact reads NOT RECORDED", () => {
      expect(leadBlock(dir, base, { runId: "run-2" })).toBe([
        "## Reviewer brief",
        "Verdict: NOT RECORDED",
        "Look here first: NOT RECORDED (no model-declared risk)",
        "Proven:",
        "- checks run: NOT RECORDED",
        "- mutation proof: NOT RECORDED",
        "- intent card: NOT RECORDED",
        "NOT PROVEN: NOT RECORDED",
        "Outside the declared scope: NOT RECORDED (no declared scope)",
        "Verify locally: loki verify run-2",
        "",
      ].join("\n"));
    });

    test("out-of-scope files are listed, capped with a count", () => {
      const f: BriefFacts = { ...verified, declaredFiles: ["README.md"] };
      const out = leadBlock(dir, base, f);
      expect(out).toContain("Outside the declared scope (3): src/a.ts, src/b.ts, src/c.ts");
    });

    test("no line claims a fact absent from the receipt", () => {
      const out = leadBlock(dir, base, { runId: "r", verdict: "PARTIAL", receipt: { checks: [] } });
      expect(out).not.toMatch(/VERIFIED|\byes\b|\bpass\b/);
      expect(out).toContain("- checks run: 0");
      expect(out).toContain("- mutation proof: NOT RECORDED");
      expect(out).toContain("Look here first: NOT RECORDED");
    });

    test("risk entries naming files outside the diff are dropped, never shown", () => {
      const out = leadBlock(dir, base, { ...verified, risks: [{ path: "src/zzz.ts", risk: 3, why: "ghost" }] });
      expect(out).not.toContain("zzz");
      expect(out).toContain("Look here first: NOT RECORDED");
    });

    test("lead block stays under 25 lines in the worst case", () => {
      const many = Array.from({ length: 40 }, (_, i) => `n${i}`);
      const out = leadBlock(dir, base, { ...verified, receipt: { ...verified.receipt!, not_proven: many }, declaredFiles: ["x"], risks: [{ path: "src/a.ts", risk: 1, why: "a" }, { path: "src/b.ts", risk: 1, why: "b" }, { path: "src/c.ts", risk: 1, why: "c" }, { path: "src/a.ts", risk: 1, why: "d" }] });
      expect(out.trimEnd().split("\n").length).toBeLessThan(25);
    });

    test("renderBrief leads with the block when facts are given, and is unchanged without", () => {
      expect(renderBrief({ repoDir: dir, baseSha: base, facts: verified }).startsWith("## Reviewer brief\nVerdict: VERIFIED")).toBe(true);
      expect(renderBrief({ repoDir: dir, baseSha: base }).startsWith("## Reviewer brief\n\n### Behavior changes")).toBe(true);
    });

    test("parseRiskDecls keeps only well-formed entries, sanitizes why", () => {
      const r = parseRiskDecls({ risky_hunks: [{ path: "a.ts", risk: 3, why: "x\ny" }, { path: 5 }, { path: "b.ts", risk: "high" }, "junk"] });
      expect(r).toEqual([{ path: "a.ts", risk: 3, why: "x y" }]);
      expect(parseRiskDecls({})).toBeNull();
    });
  });
});

describe("reviewer brief: tests that import the changed files", () => {
  let d: string; let b0: string;
  const g = (a: string[]): string => git(d, a);
  beforeAll(() => {
    d = mkdtempSync(join(tmpdir(), "e10-brief-tm-"));
    g(["init", "-q"]);
    mkdirSync(join(d, "src")); mkdirSync(join(d, "tests"));
    writeFileSync(join(d, "bunfig.toml"), "[test]\n");
    for (const n of ["a", "b", "c"]) writeFileSync(join(d, `src/${n}.ts`), `export const ${n} = 1;\n`);
    for (const n of ["t1", "t2", "t3", "t4", "t5"]) writeFileSync(join(d, `tests/${n}.test.ts`), 'import { a } from "../src/a.ts";\nvoid a;\n');
    writeFileSync(join(d, "tests/b.test.ts"), 'import { b } from "../src/b.ts";\nvoid b;\n');
    g(["add", "-A"]); g(["-c", "user.name=t", "-c", "user.email=t@e.x", "commit", "-q", "-m", "init"]);
    b0 = g(["rev-parse", "HEAD"]).trim();
    for (const n of ["a", "b", "c"]) writeFileSync(join(d, `src/${n}.ts`), `export const ${n} = 2;\n`);
    g(["add", "-A"]); g(["-c", "user.name=t", "-c", "user.email=t@e.x", "commit", "-q", "-m", "chg"]);
  });
  afterAll(() => rmSync(d, { recursive: true, force: true }));

  test("lists importing tests, capped at 3 plus +N more, and flags files with none", () => {
    const sec = renderBrief({ repoDir: d, baseSha: b0 }).split("### Tests that import the changed files")[1]!.split("###")[0]!.trim().split("\n");
    expect(sec.find((l) => l.startsWith("- src/b.ts"))).toBe("- src/b.ts: tests/b.test.ts");
    expect(sec.find((l) => l.startsWith("- src/c.ts"))).toBe("- src/c.ts: no test imports this file");
    const a = sec.find((l) => l.startsWith("- src/a.ts"))!;
    expect(a).toMatch(/^- src\/a\.ts: tests\/t\d\.test\.ts, tests\/t\d\.test\.ts, tests\/t\d\.test\.ts, \+2 more$/);
  });

  test("no runner detected: not measured, never a false 'no test'", () => {
    const sec = renderBrief({ repoDir: dir, baseSha: base }).split("### Tests that import the changed files")[1]!.split("###")[0]!;
    expect(sec).toContain("not measured (no test runner or test files detected)");
  });
});
