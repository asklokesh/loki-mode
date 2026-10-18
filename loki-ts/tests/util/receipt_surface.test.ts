import { describe, expect, test } from "bun:test";
import { prNumberFromUrl, renderProofCard, renderReceiptComment } from "../../src/util/receipt_surface.ts";

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

  test("the card states money, time, checks, fail-to-pass and the hash", () => {
    const card = renderProofCard({
      verdict: "VERIFIED",
      usd: 0.42,
      wallS: 38.2,
      checks: 4,
      mutationProof: "test fails without the fix: yes",
      sha: "abc",
    });
    expect(card).toBe("LOKI VERIFIED\n$0.42 in 38s, 4 checks run outside the model\ntest fails without the fix: yes\nsha256:abc");
    const unknown = renderProofCard({ verdict: "PARTIAL", usd: null, wallS: 1, checks: 0, mutationProof: null, sha: null, tampered: true });
    expect(unknown.startsWith("LOKI TAMPERED\n")).toBe(true);
    expect(unknown).toContain("cost not measured");
    expect(unknown).toContain("fail-to-pass: not recorded");
    expect(unknown).toContain("receipt not sealed");
  });

  test("only a GitHub pull URL yields a number", () => {
    expect(prNumberFromUrl("https://github.com/o/r/pull/12")).toBe("12");
    expect(prNumberFromUrl("local:///tmp/bare.git#loki/x")).toBeNull();
    expect(prNumberFromUrl("https://gitlab.com/o/r/-/merge_requests/3")).toBeNull();
  });
});
