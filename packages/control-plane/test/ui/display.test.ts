import { expect, test } from "bun:test";
import { displayOutcome, stripAnsi } from "../../ui/src/display";

test("displayOutcome: the eight RELEASE-11 labels", () => {
  expect(displayOutcome("VERIFIED")).toEqual({ label: "Verified", tone: "good" });
  expect(displayOutcome("PARTIAL").label).toBe("Partly verified");
  expect(displayOutcome("FAILED")).toEqual({ label: "Failed", tone: "bad" });
  expect(displayOutcome("BLOCKED").label).toBe("Needs your answer");
  expect(displayOutcome("SPEC_CONFLICT").label).toBe("Needs your answer");
  expect(displayOutcome("ALREADY_SATISFIED")).toEqual({ label: "Already done", tone: "good" });
  expect(displayOutcome("BUDGET_EXHAUSTED").label).toBe("Stopped (budget)");
  expect(displayOutcome("VERIFIED (signature not checked)").label).toBe("Unverified (signature not checked)");
  expect(displayOutcome("UNVERIFIED").label).toBe("Unverified (signature not checked)");
  expect(displayOutcome("TAMPERED")).toEqual({ label: "Tampered", tone: "bad" });
});

test("displayOutcome: null is running, an unknown enum is humanized and never raw", () => {
  expect(displayOutcome(null).label).toBe("Running");
  expect(displayOutcome(undefined).tone).toBe("neutral");
  const o = displayOutcome("FAILED_UNATTESTED_THING");
  expect(o.label).toBe("Failed unattested thing");
  expect(o.label).not.toMatch(/_/);
});

test("stripAnsi: full escapes, ESC-less remnants and OSC are all removed", () => {
  expect(stripAnsi("\u001b[31mFailed\u001b[39m Suites 1")).toBe("Failed Suites 1");
  expect(stripAnsi("vitest [31m...[39m Failed Suites 1 [2m[22m")).toBe("vitest ... Failed Suites 1 ");
  expect(stripAnsi("a\u001b]8;;http://x\u0007link\u001b]8;;\u0007b")).toBe("alinkb");
  expect(stripAnsi("plain [ok] text")).toBe("plain [ok] text");
});
