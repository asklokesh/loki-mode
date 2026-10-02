// INTEL-3: the reviewer-first PR body leads with the contract and ends with the receipt.
import { describe, expect, it } from "bun:test";
import { renderReviewerBody } from "../../src/e10ext/reviewer_body.ts";

const outputs = {
  intake: { task: "Fix the parser\n\n- handles empty input\n- [ ] rejects bad tokens\n3. keeps old API" },
  wall: { files: [{ path: "/repo/tests/parser.test.ts", sha256: "x" }], base_run: { pass: 0, fail: 2, not_run: 0 } },
  verify: {
    changed_files: ["src/parser.ts", "tests/parser.test.ts"],
    checks: [
      { name: "bun:tests/parser.test.ts", cmd: "bun test tests/parser.test.ts", result: "pass", n: 4 },
      { name: "lint:src/parser.ts", cmd: "eslint src/parser.ts", result: "fail" },
    ],
  },
};
const base = { verdict: "PARTIAL", draftReason: "verdict PARTIAL", notProven: ["lint failed"], receiptPath: "/r/receipt.json", receiptSha256: "ab12", signed: true, runId: "run-1", outputs };

describe("renderReviewerBody", () => {
  const body = renderReviewerBody(base);
  it("orders the five sections contract, change, tests, NOT PROVEN, receipt", () => {
    const at = ["## What the issue asked", "## What changed and why", "## How it was tested", "## NOT PROVEN", "## Receipt"].map((h) => body.indexOf(h));
    expect(at.every((n) => n >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(body.startsWith("## What the issue asked")).toBe(true);
  });
  it("lists every contract criterion and the files in scope", () => {
    for (const c of ["handles empty input", "rejects bad tokens", "keeps old API", "src/parser.ts", "tests/parser.test.ts"]) expect(body).toContain(c);
  });
  it("reports real counts, the command, and failing-then-passing target tests", () => {
    expect(body).toContain("1 passed, 1 failed, 0 not run, 0 flaky (4 individual tests counted)");
    expect(body).toContain("`bun test tests/parser.test.ts` -> pass");
    expect(body).toContain("parser.test.ts");
    expect(body).toContain("2 failing, 0 passing on base; after: pass");
    expect(body).toContain("Verdict: PARTIAL (DRAFT: verdict PARTIAL)");
  });
  it("ends with the digest and loki verify instructions", () => {
    expect(body).toContain("sha256:ab12 (signed)");
    expect(body.trimEnd().split("\n").pop()).toBe("- Verify: `loki verify run-1`");
  });
  it("prints not recorded, never a number, when data is absent", () => {
    const empty = renderReviewerBody({ ...base, outputs: {}, receiptSha256: null, signed: null, notProven: [] });
    expect(empty).toContain("- Tests: not recorded");
    expect(empty).toContain("- Files in scope: not recorded");
    expect(empty).toContain("Digest: not recorded");
    expect(empty).toContain("- none");
    expect(empty).not.toMatch(/\d+ passed/);
  });
  it("omits any screenshot section and stays inside a fixed line budget", () => {
    expect(body).not.toMatch(/screenshot|playwright/i);
    const many = renderReviewerBody({ ...base, outputs: { ...outputs, verify: { ...outputs.verify, changed_files: Array.from({ length: 60 }, (_, i) => `f${i}.ts`) } } });
    expect(many.split("\n").length).toBeLessThanOrEqual(45);
    expect(many).toContain("(+50 more)");
  });
  it("contains no em or en dashes", () => {
    expect(body).not.toMatch(/[\u2013\u2014]/);
  });
});
