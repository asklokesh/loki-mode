// INTEL-3: reviewer-first PR body: contract, criteria with files and check, NOT PROVEN last, line budget.
import { describe, expect, test } from "bun:test";
import { PR_BODY_LINE_BUDGET, renderPrBody, type PrBodyInput } from "../../src/engine10/pr_body.ts";

const base = (over: Partial<PrBodyInput> = {}): PrBodyInput => ({
  verdict: "VERIFIED", notProven: ["full suite", "app boot"], receiptPath: "/r/receipt.json", capHit: false,
  outputs: {
    intake: { task: "Fix the parser\n- handles empty input\n- rejects bad tokens" },
    verify: { changed_files: ["src/parser.ts", "tests/parser.test.ts"], checks: [{ name: "wall_parser.test.ts", cmd: "bun test", result: "pass" }] },
    wall: { files: [{ path: "tests/wall_parser.test.ts", sha256: "x" }] },
  },
  ...over,
});

describe("renderPrBody reviewer-first", () => {
  test("contract first, each criterion lists its file and check, NOT PROVEN last", () => {
    const lines = renderPrBody(base()).trimEnd().split("\n");
    expect(lines[0]).toBe("Contract: Fix the parser");
    for (const c of ["handles empty input", "rejects bad tokens"]) {
      const i = lines.findIndex((l) => l === `- ${c}`);
      expect(i).toBeGreaterThan(0);
      expect(lines[i + 1]).toContain("src/parser.ts");
      expect(lines[i + 1]).toContain("check: Wall wall_parser.test.ts (pass)");
    }
    const np = lines.indexOf("NOT PROVEN:");
    expect(np).toBeGreaterThan(lines.indexOf("Receipt: /r/receipt.json"));
    expect(lines.slice(np)).toEqual(["NOT PROVEN:", "- full suite", "- app boot"]);
  });
  test("explicit criteria rows win; missing proof reads honestly", () => {
    const body = renderPrBody(base({ criteria: [{ text: "a", files: ["f.ts"], check: "bun test f" }, { text: "b" }] }));
    expect(body).toContain("files: f.ts; check: bun test f");
    expect(body).toContain("files not recorded; check: no check recorded");
  });
  test("over budget truncates with +N more, NOT PROVEN still last, never exceeds budget", () => {
    const criteria = Array.from({ length: 80 }, (_, i) => ({ text: `crit ${i}`, files: ["a.ts"], check: "t" }));
    const body = renderPrBody(base({ criteria, notProven: Array.from({ length: 30 }, (_, i) => `np ${i}`) }));
    const lines = body.trimEnd().split("\n");
    expect(lines.length).toBeLessThanOrEqual(PR_BODY_LINE_BUDGET);
    expect(body).toMatch(/\+\d+ more criteria/);
    expect(lines[lines.length - 1]).toMatch(/^\+\d+ more not-proven items$/);
    expect(lines.indexOf("NOT PROVEN:")).toBeGreaterThan(lines.findIndex((l) => /^\+\d+ more criteria$/.test(l)));
  });
  test("within budget prints no +N more line", () => {
    expect(renderPrBody(base())).not.toContain("more");
  });
});
