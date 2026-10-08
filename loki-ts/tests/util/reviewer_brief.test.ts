// T4: reviewer brief. Ranking, not-measured path, with-coverage path (lcov produced by a real
// `bun test --coverage` run in a fixture repo), and the opt-out flag.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callerCounts, changedLines, renderBrief, reviewerBriefEnabled } from "../../src/util/reviewer_brief.ts";

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
