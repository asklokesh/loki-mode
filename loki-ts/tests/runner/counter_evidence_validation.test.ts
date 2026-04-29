// v7.5.1 regression test for B2 (proofType validation).
//
// Pre-v7.5.1, loadCounterEvidence cast e["proofType"] to OverrideProofType
// without validation. A counter-evidence file with `"proofType": "made-up"`
// flowed unchecked into judges + audit transcripts. v7.5.1 added a
// VALID_PROOF_TYPES set and silently drops entries with unknown values.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCounterEvidence } from "../../src/runner/counter_evidence.ts";

let scratch = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "loki-ce-valid-"));
});

afterEach(() => {
  if (scratch && existsSync(scratch)) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

function writeFile(iter: number, evidence: unknown[]): void {
  const dir = join(scratch, "state");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `counter-evidence-${iter}.json`),
    JSON.stringify({ iteration: iter, evidence }),
  );
}

describe("v7.5.1 B2: proofType enum validation", () => {
  it("accepts every documented proofType", () => {
    const types = [
      "file-exists",
      "test-passes",
      "grep-miss",
      "reviewer-misread",
      "duplicate-code-path",
      "out-of-scope",
    ];
    writeFile(
      1,
      types.map((proofType, i) => ({
        findingId: `f-${i}`,
        claim: "ok",
        proofType,
        artifacts: [],
      })),
    );
    const f = loadCounterEvidence(scratch, 1);
    expect(f).not.toBeNull();
    expect(f!.evidence.length).toBe(types.length);
    for (let i = 0; i < types.length; i++) {
      expect(f!.evidence[i]!.proofType).toBe(types[i] as never);
    }
  });

  it("v7.5.8: drops a single entry with proofType='malicious-string' (validation BEFORE cast)", () => {
    // Pre-v7.5.8 the cast `e["proofType"] as OverrideProofType` happened
    // before the VALID_PROOF_TYPES check. The runtime drop still worked but
    // the narrowed type was already a lie. v7.5.8 reads the value as unknown
    // first, validates, then narrows. Verify behavior end-to-end: a sole
    // malicious entry yields zero surviving evidence records.
    writeFile(7, [
      {
        findingId: "evil-1",
        claim: "trust me bro",
        proofType: "malicious-string",
        artifacts: [],
      },
    ]);
    const f = loadCounterEvidence(scratch, 7);
    expect(f).not.toBeNull();
    expect(f!.evidence.length).toBe(0);
  });

  it("silently drops entries with an unknown proofType", () => {
    writeFile(2, [
      {
        findingId: "valid-1",
        claim: "ok",
        proofType: "duplicate-code-path",
        artifacts: [],
      },
      {
        findingId: "bad-1",
        claim: "I disagree",
        proofType: "made-up-handwave",
        artifacts: [],
      },
      {
        findingId: "bad-2",
        claim: "still no",
        proofType: "FILE-EXISTS", // case-sensitive check; must NOT match
        artifacts: [],
      },
      {
        findingId: "valid-2",
        claim: "ok",
        proofType: "out-of-scope",
        artifacts: [],
      },
    ]);
    const f = loadCounterEvidence(scratch, 2);
    expect(f).not.toBeNull();
    // Only the two valid entries survive.
    expect(f!.evidence.length).toBe(2);
    const ids = f!.evidence.map((e) => e.findingId).sort();
    expect(ids).toEqual(["valid-1", "valid-2"]);
  });
});
