import { describe, expect, test } from "bun:test";
import { prNumberFromUrl, renderReceiptComment } from "../../src/util/receipt_surface.ts";

describe("receipt comment", () => {
  test("names outcome, hash, verify, PROVEN and NOT PROVEN", () => {
    const body = renderReceiptComment({
      verdict: "PARTIAL",
      draft: true,
      draftReason: "verdict PARTIAL",
      notProven: ["full suite"],
      receiptSha256: "abc",
      runId: "e10-1",
    });
    expect(body).toContain("Outcome: PARTIAL (DRAFT: verdict PARTIAL)");
    expect(body).toContain("sha256:abc");
    expect(body).toContain("`loki verify e10-1`");
    expect(body).toContain("PROVEN: no verified claim");
    expect(body).toContain("## NOT PROVEN");
    expect(body).toContain("- full suite");
    expect(body).not.toMatch(/[\u2013\u2014]/);
  });

  test("a verified non-draft comment claims PROVEN and none unproven", () => {
    const body = renderReceiptComment({ verdict: "VERIFIED", draft: false, draftReason: null, notProven: [], receiptSha256: null, runId: "e10-2" });
    expect(body).toContain("PROVEN: sealed verdict VERIFIED");
    expect(body).toContain("- none");
    expect(body).toContain("not recorded");
    expect(body).not.toContain("- Proof:");
  });

  test("a fail-to-pass line is the proof a reviewer sees", () => {
    const body = renderReceiptComment({
      verdict: "VERIFIED",
      draft: false,
      draftReason: null,
      notProven: [],
      receiptSha256: "abc",
      runId: "e10-3",
      mutationProof: "test fails without the fix: yes",
    });
    expect(body).toContain("- Proof: test fails without the fix: yes");
  });

  test("only a GitHub pull URL yields a number", () => {
    expect(prNumberFromUrl("https://github.com/o/r/pull/12")).toBe("12");
    expect(prNumberFromUrl("local:///tmp/bare.git#loki/x")).toBeNull();
    expect(prNumberFromUrl("https://gitlab.com/o/r/-/merge_requests/3")).toBeNull();
  });
});
