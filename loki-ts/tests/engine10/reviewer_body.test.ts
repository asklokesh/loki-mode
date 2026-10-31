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
    expect(body.startsWith("## Not proven\n")).toBe(true); // PR-FIRST-1: a PARTIAL body leads with what is unproven
    expect(body.indexOf("## Not proven")).toBeLessThan(body.indexOf("## What the issue asked"));
  });
  it("PR-FIRST-1: the leading Not proven section lists the first 10 reasons and the total; VERIFIED has none", () => {
    const many = Array.from({ length: 13 }, (_, k) => `reason ${k + 1}`);
    const b = renderReviewerBody({ ...base, notProven: many });
    const head = b.slice(0, b.indexOf("## What the issue asked"));
    expect(head).toContain("13 things are not proven");
    for (const r of many.slice(0, 10)) expect(head).toContain(`- ${r}\n`);
    expect(head).not.toContain("reason 11");
    expect(head).toContain("+3 more, total 13");
    const v = renderReviewerBody({ ...base, verdict: "VERIFIED", draftReason: null, notProven: [] });
    expect(v.startsWith("## What the issue asked")).toBe(true);
    expect(v).not.toContain("## Not proven");
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
  it("ends the receipt with the digest, loki verify, and the other-machine line", () => {
    expect(body).toContain("sha256:ab12 (signed)");
    expect(body).toContain("- Verify: `loki verify run-1`");
    expect(body).toContain("`loki proof bundle run-1`");
    expect(body).toContain("`loki verify --pubkey pubkey.jwk receipt.json`");
  });
  it("adds the footer, LOKI_PR_FOOTER=0 removes it and keeps the verify lines", () => {
    expect(body.trimEnd().split("\n").pop()).toBe("Built with Loki Mode: https://github.com/asklokesh/loki-mode");
    const off = renderReviewerBody(base, { LOKI_PR_FOOTER: "0" });
    expect(off).not.toContain("Loki Mode:");
    expect(off).toContain("- Verify: `loki verify run-1`");
    expect(off).toContain("loki proof bundle run-1");
  });
  it("footer says verified only for a non-draft VERIFIED body", () => {
    expect(body).not.toMatch(/Built and verified/);
    const ok = renderReviewerBody({ ...base, verdict: "VERIFIED", draftReason: null });
    expect(ok).toContain("Built and verified with Loki Mode: https://github.com/asklokesh/loki-mode");
    const draft = renderReviewerBody({ ...base, verdict: "VERIFIED", draftReason: "cap hit" });
    expect(draft).not.toMatch(/Built and verified/);
    expect(draft).toContain("Built with Loki Mode");
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

// FC-PR-BODY-PUBLIC-HYGIENE: shape of the real #81826 run (template body, excluded Wall file, base-red check, absolute receipt path).
const TEMPLATE_TASK = [
  "[BUG] ralph-loop: --max-iterations 08 silently discards the cap",
  "### Preflight Checklist",
  "- [x] I have searched [existing issues](https://github.com/o/r/issues) and this hasn't been reported yet",
  "- [x] This is a single bug report (please file separate reports for different bugs)",
  "- [x] I am using the latest version of Claude Code (2.1.220)",
  "### Summary",
  "`--max-iterations 08` silently turns a bounded loop into an unbounded one.",
].join("\n");
const real = {
  intake: { task: TEMPLATE_TASK, title: "[BUG] ralph-loop: --max-iterations 08" },
  wall: { files: [{ path: "/private/tmp/x/cc/tests/loki_wall_ralph.test.ts", sha256: "x" }], base_run: { pass: 0, fail: 1, not_run: 0 } },
  verify: {
    changed_files: ["plugins/a/stop-hook.sh", "tests/loki_wall_ralph.test.ts"],
    pre_red_checks: ["lint:shellcheck"],
    checks: [
      { name: "bun:tests/loki_wall_ralph.test.ts", cmd: "bun test tests/loki_wall_ralph.test.ts", result: "pass", n: 8 },
      { name: "lint:shellcheck", cmd: "shellcheck plugins/a/stop-hook.sh", result: "fail" },
    ],
  },
};
const realIn = { ...base, verdict: "VERIFIED", draftReason: null, receiptPath: "/private/tmp/claude-501/x/scratch/.loki/runs/run-1/receipt.json", outputs: real };
describe("FC-PR-BODY-PUBLIC-HYGIENE", () => {
  const body = renderReviewerBody(realIn);
  const asked = body.slice(body.indexOf("## What the issue asked"), body.indexOf("## What changed"));
  it("strips issue-template checklist lines from what the issue asked", () => {
    expect(asked).not.toMatch(/searched|single bug report|latest version/i);
    expect(asked).toContain("--max-iterations 08");
  });
  const card = { intent_card: ["What I think you want: Make leading-zero values enforce the cap.", "Acceptance: a"] };
  const askedOf = (task: string, plan?: Record<string, unknown>) => { const b = renderReviewerBody({ ...realIn, outputs: { ...real, intake: { task }, ...(plan ? { plan } : {}) } }); return b.slice(0, b.indexOf("## What changed")); };
  it("uses the intent card line only when nothing but template text remains", () => {
    const s = askedOf(["### Preflight Checklist", "- [x] I have searched existing issues", "- [x] I am using the latest version of Claude Code"].join("\n"), card);
    expect(s).toContain("- Make leading-zero values enforce the cap.");
    expect(s).not.toMatch(/searched|latest version/i);
  });
  it("(A) keeps real criteria that mention duplicate or latest version under an acceptance heading", () => {
    const s = askedOf(["## Acceptance criteria", "- [ ] Remove duplicate entries from the list", "- [ ] Works on the latest version of Node", "- [ ] Sorted output"].join("\n"));
    for (const c of ["Remove duplicate entries from the list", "Works on the latest version of Node", "Sorted output"]) expect(s).toContain(c);
  });
  it("(B) keeps items under an Acceptance checklist heading", () => {
    const s = askedOf(["## Acceptance checklist", "- [ ] Handles empty input", "- [ ] Rejects bad tokens"].join("\n"));
    expect(s).toContain("Handles empty input"); expect(s).toContain("Rejects bad tokens");
  });
  it("(C) keeps items under a heading that merely contains the word confirm", () => {
    const s = askedOf(["## Confirm dialog behaviour", "- [ ] Shows the dialog once", "- [ ] Esc cancels"].join("\n"));
    expect(s).toContain("Shows the dialog once"); expect(s).toContain("Esc cancels");
  });
  it("(E) keeps every item under a user's own Checklist heading", () => {
    const s = askedOf(["Add dark mode", "## Checklist", "- [ ] Support dark mode toggle", "- [ ] Persist the setting"].join("\n"));
    expect(s).toContain("Support dark mode toggle"); expect(s).toContain("Persist the setting");
  });
  it("(I) keeps every item under a user's own Prerequisites heading", () => {
    const s = askedOf(["Setup CI", "## Prerequisites", "- [ ] Node 20 installed in the image", "- [ ] Cache configured"].join("\n"));
    expect(s).toContain("Node 20 installed in the image"); expect(s).toContain("Cache configured");
  });
  it("(M7) keeps a first-person looking item under an Acceptance heading", () => {
    const s = askedOf(["## Acceptance criteria", "- [ ] I have read the docs", "- [ ] Sorted output"].join("\n"));
    expect(s).toContain("I have read the docs");
  });
  it("(M8) keeps an item that only contains the words agree to", () => {
    const s = askedOf(["Terms flow", "- [ ] User can agree to terms", "- [ ] Shows the terms"].join("\n"));
    expect(s).toContain("User can agree to terms");
  });
  it("(D) with an intent card present, the issue's own acceptance list is still shown", () => {
    const s = askedOf(["## Acceptance criteria", "- Sorted output", "- Stable ties"].join("\n"), card);
    expect(s).toContain("Sorted output"); expect(s).toContain("Stable ties");
    expect(s).not.toContain("Make leading-zero values");
  });
  it("keeps a real unchecked criterion that is not template boilerplate", () => {
    expect(renderReviewerBody(base)).toContain("rejects bad tokens");
  });
  it("lists only files in the commit, never the Wall file", () => {
    expect(body).toContain("- plugins/a/stop-hook.sh");
    expect(body).not.toContain("- tests/loki_wall_ralph.test.ts");
  });
  it("prints the receipt path repo-relative, never an absolute local path", () => {
    expect(body).toContain("- File: .loki/runs/run-1/receipt.json");
    expect(body).not.toContain("/private/tmp");
    expect(renderReviewerBody({ ...realIn, receiptPath: "/somewhere/else/r.json" })).not.toContain("/somewhere");
  });
  it("labels a base-failing check in How it was tested and the Checks line", () => {
    expect(body).toContain("`shellcheck plugins/a/stop-hook.sh` -> fail (already failing on base, not caused by this change)");
    expect(body).toContain("1 passed, 0 failed, 0 not run, 0 flaky (8 individual tests counted); 1 already failing on base");
  });
  it("still reports a real failure as a plain fail", () => {
    const b = renderReviewerBody({ ...realIn, outputs: { ...real, verify: { ...real.verify, pre_red_checks: [] } } });
    expect(b).toContain("-> fail\n");
    expect(b).toContain("1 failed");
  });
});
