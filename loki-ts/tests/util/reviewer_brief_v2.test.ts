// REVIEWER-BRIEF-V2: the decision block at the top of the reviewer brief. Golden output for a VERIFIED, a PARTIAL
// and a missing-facts receipt, out-of-scope listing, and "no line claims a fact the receipt lacks".
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leadBlock, parseRiskDecls, renderBrief, type BriefFacts } from "../../src/util/reviewer_brief.ts";

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
