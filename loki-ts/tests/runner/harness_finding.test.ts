// A harness failure must not be reported as a defect in the user's code.
//
// THE DEFECT, measured on this repo. Every finding in .loki/state/findings-*.json
// read "severity": "Critical" -- 16 of 16 -- and every one of them was
// `structured reviewer produced no valid verdict`. That string is the REVIEWER
// failing to answer, not a bug in the reviewed code. A user reading the findings
// file sees 16 critical bugs in a codebase that has none.
//
// That is a false RED, and it costs exactly what a false green costs: findings
// the user learns to discount. The fix is Devin's split -- severity answers "how
// bad if real", confidence answers "how sure it is real" -- so a dispatch
// failure is legible as a dispatch failure.
//
// TEST 1 IS THE LOAD-BEARING ONE, and it is the thing that MUST NOT change.
// Fail-closed is correct: an unverified change must not pass. The confidence tag
// is additive. If a future edit makes these return PASS, or drops the FAIL, the
// gate silently starts letting unreviewed diffs through -- a much worse bug than
// the mislabelling this fixes.

import { test, expect } from "bun:test";
import { harnessFinding, CONFIDENCE_UNVERIFIED } from "../../src/runner/quality_gates";

test("a harness finding still BLOCKS -- fail-closed is untouched", () => {
  for (const detail of [
    "structured reviewer produced no valid verdict",
    "reviewer dispatch failed (claude exit 1)",
    "reviewer produced no output",
    "reviewer threw: boom",
  ]) {
    const out = harnessFinding(detail);
    expect(out.startsWith("VERDICT: FAIL")).toBe(true);
    expect(out).not.toContain("VERDICT: PASS");
  }
});

test("severity is preserved -- the gate still treats it as blocking", () => {
  // Confidence is a SECOND axis, not a downgrade. Dropping [Critical] would
  // change how downstream severity parsing classifies the finding.
  expect(harnessFinding("x")).toContain("[Critical]");
});

test("the finding is tagged unverified, so it is not read as a code defect", () => {
  const out = harnessFinding("reviewer produced no output");
  expect(out).toContain(`[${CONFIDENCE_UNVERIFIED}]`);
});

test("it says plainly that this is the harness, not the user's code", () => {
  // The tag alone is jargon. The sentence is what a user actually reads.
  const out = harnessFinding("reviewer produced no output");
  expect(out).toContain("not a defect found in your code");
  expect(out).toContain("the gate blocks");
});

test("the detail survives, so the real cause is still diagnosable", () => {
  expect(harnessFinding("reviewer dispatch failed (claude exit 137)"))
    .toContain("claude exit 137");
});
