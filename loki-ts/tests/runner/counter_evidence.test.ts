// Tests for src/runner/counter_evidence.ts.
//
// Covers:
//   - loadCounterEvidence: missing file, malformed JSON, missing iteration,
//     valid file parsing, rejection of malformed entries.
//   - canonicalFindingId: stability + sensitivity to reviewer / raw changes.
//   - runOverrideCouncil: 2-of-3 vote semantics across all majority cases,
//     no-evidence path, votes keyed by canonical id, judge fan-out args.
//   - recordOverrideOutcome: writes a learning per approved/rejected finding.
//
// Strategy: each test uses an isolated scratch dir under tmpdir so writes
// from recordOverrideOutcome touch hermetic state. The OverrideJudgeFn is
// stubbed deterministically per case; no provider subprocess is spawned.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_OVERRIDE_JUDGES,
  canonicalFindingId,
  loadCounterEvidence,
  recordOverrideOutcome,
  runOverrideCouncil,
} from "../../src/runner/counter_evidence.ts";
import type {
  CounterEvidence,
  CounterEvidenceFile,
  OverrideJudgeFn,
  OverrideOutcome,
  OverrideVote,
} from "../../src/runner/counter_evidence.ts";
import type { Finding } from "../../src/runner/findings_injector.ts";

let scratch = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "loki-counter-ev-test-"));
});

afterEach(() => {
  if (scratch && existsSync(scratch)) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

function writeCounterEvidenceFile(lokiDir: string, iter: number, body: unknown): string {
  const dir = join(lokiDir, "state");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `counter-evidence-${iter}.json`);
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    reviewId: "review-test",
    iteration: 1,
    reviewer: "architecture-strategist",
    severity: "Critical",
    description: "hardcoded secret in src/api.ts:42",
    file: "src/api.ts",
    line: 42,
    raw: "[Critical] hardcoded secret in src/api.ts:42",
    ...overrides,
  };
}

function makeEvidence(overrides: Partial<CounterEvidence> = {}): CounterEvidence {
  return {
    findingId: "stub::id",
    claim: "the file is fixture-only test data, not a runtime secret",
    proofType: "duplicate-code-path",
    artifacts: ["tests/fixtures/api.ts"],
    ...overrides,
  };
}

// --- loadCounterEvidence --------------------------------------------------

describe("loadCounterEvidence", () => {
  it("returns null when the file is missing", () => {
    expect(loadCounterEvidence(scratch, 7)).toBeNull();
  });

  it("returns null when the iteration field is missing", () => {
    writeCounterEvidenceFile(scratch, 3, { evidence: [] });
    expect(loadCounterEvidence(scratch, 3)).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    writeCounterEvidenceFile(scratch, 4, "{not json");
    expect(loadCounterEvidence(scratch, 4)).toBeNull();
  });

  it("parses a valid file with one evidence entry and rejects malformed entries", () => {
    const valid: CounterEvidence = {
      findingId: "architecture-strategist::[Critical] hardcoded secret in src/api.ts:42",
      claim: "the value is a placeholder used in fixture data",
      proofType: "reviewer-misread",
      artifacts: ["tests/fixtures/api.ts:42", "grep -n 'hardcoded' src/"],
    };
    writeCounterEvidenceFile(scratch, 5, {
      iteration: 5,
      evidence: [
        valid,
        // Missing claim -- must be rejected by the validator.
        { findingId: "x", proofType: "file-exists", artifacts: [] },
        // Wrong type for findingId -- rejected.
        { findingId: 42, claim: "c", proofType: "file-exists", artifacts: [] },
        // Not an object -- rejected.
        "string-entry",
        null,
        // Missing proofType -- rejected.
        { findingId: "y", claim: "c", artifacts: [] },
        // Non-string artifact -- entry kept, but artifact filtered out.
        { findingId: "z", claim: "c", proofType: "file-exists", artifacts: ["ok", 7, false] },
      ],
    });

    const out = loadCounterEvidence(scratch, 5);
    expect(out).not.toBeNull();
    const file = out as CounterEvidenceFile;
    expect(file.iteration).toBe(5);
    expect(file.evidence.length).toBe(2);
    expect(file.evidence[0]).toEqual(valid);
    expect(file.evidence[1]).toEqual({
      findingId: "z",
      claim: "c",
      proofType: "file-exists",
      artifacts: ["ok"],
    });
  });

  it("accepts an empty evidence array and missing evidence field", () => {
    writeCounterEvidenceFile(scratch, 6, { iteration: 6 });
    const out = loadCounterEvidence(scratch, 6);
    expect(out).not.toBeNull();
    expect((out as CounterEvidenceFile).evidence).toEqual([]);
  });
});

// --- canonicalFindingId ---------------------------------------------------

describe("canonicalFindingId", () => {
  it("is stable for the same finding input", () => {
    const f = makeFinding();
    expect(canonicalFindingId(f)).toBe(canonicalFindingId(f));
    // And specifically:
    expect(canonicalFindingId(f)).toBe(
      "architecture-strategist::[Critical] hardcoded secret in src/api.ts:42",
    );
  });

  it("differs when the reviewer differs", () => {
    const a = makeFinding({ reviewer: "architecture-strategist" });
    const b = makeFinding({ reviewer: "security-sentinel" });
    expect(canonicalFindingId(a)).not.toBe(canonicalFindingId(b));
  });

  it("differs when the raw text differs", () => {
    const a = makeFinding({ raw: "[Critical] hardcoded secret in src/api.ts:42" });
    const b = makeFinding({ raw: "[High] sql injection in src/db.ts:7" });
    expect(canonicalFindingId(a)).not.toBe(canonicalFindingId(b));
  });

  it("truncates raw to first 80 chars and collapses whitespace", () => {
    // 90-char raw -- first 80 chars define the id.
    const longRaw = "[Critical] " + "x".repeat(80);
    const f = makeFinding({ raw: longRaw });
    const id = canonicalFindingId(f);
    // The substring after "::" is exactly the first 80 chars (whitespace collapsed).
    const tail = id.split("::")[1] ?? "";
    expect(tail.length).toBeLessThanOrEqual(80);
    expect(tail.startsWith("[Critical]")).toBe(true);
  });
});

// --- runOverrideCouncil ---------------------------------------------------

function approveJudge(reasoning = "ok"): OverrideJudgeFn {
  return async ({ judge }) => ({ judge, verdict: "APPROVE_OVERRIDE", reasoning });
}

function rejectJudge(reasoning = "no"): OverrideJudgeFn {
  return async ({ judge }) => ({ judge, verdict: "REJECT_OVERRIDE", reasoning });
}

// Map judge name -> verdict so we can simulate split votes deterministically.
function scriptedJudge(script: Record<string, OverrideVote["verdict"]>): OverrideJudgeFn {
  return async ({ judge }) => ({
    judge,
    verdict: script[judge] ?? "REJECT_OVERRIDE",
    reasoning: `scripted ${judge}`,
  });
}

describe("runOverrideCouncil", () => {
  it("rejects a finding when no counter-evidence is supplied", async () => {
    const f = makeFinding();
    const evidenceFile: CounterEvidenceFile = { iteration: 1, evidence: [] };
    const outcome = await runOverrideCouncil([f], evidenceFile, approveJudge());
    const fid = canonicalFindingId(f);
    expect(outcome.approvedFindingIds.has(fid)).toBe(false);
    expect(outcome.rejectedFindingIds.has(fid)).toBe(true);
    // No judge fan-out happened -> no votes recorded for this finding.
    expect(outcome.votes[fid]).toBeUndefined();
  });

  it("approves when all 3 judges approve (3-0)", async () => {
    const f = makeFinding();
    const fid = canonicalFindingId(f);
    const evidenceFile: CounterEvidenceFile = {
      iteration: 1,
      evidence: [makeEvidence({ findingId: fid })],
    };
    const outcome = await runOverrideCouncil([f], evidenceFile, approveJudge());
    expect(outcome.approvedFindingIds.has(fid)).toBe(true);
    expect(outcome.rejectedFindingIds.has(fid)).toBe(false);
    expect(outcome.votes[fid]?.length).toBe(3);
    expect(outcome.votes[fid]?.every((v) => v.verdict === "APPROVE_OVERRIDE")).toBe(true);
  });

  it("approves on a 2-1 split (majority approve)", async () => {
    const f = makeFinding();
    const fid = canonicalFindingId(f);
    const evidenceFile: CounterEvidenceFile = {
      iteration: 1,
      evidence: [makeEvidence({ findingId: fid })],
    };
    const judge = scriptedJudge({
      "judge-primary": "APPROVE_OVERRIDE",
      "judge-secondary": "APPROVE_OVERRIDE",
      "judge-tertiary": "REJECT_OVERRIDE",
    });
    const outcome = await runOverrideCouncil([f], evidenceFile, judge);
    expect(outcome.approvedFindingIds.has(fid)).toBe(true);
    expect(outcome.rejectedFindingIds.has(fid)).toBe(false);
  });

  it("rejects on a 1-2 split (majority reject)", async () => {
    const f = makeFinding();
    const fid = canonicalFindingId(f);
    const evidenceFile: CounterEvidenceFile = {
      iteration: 1,
      evidence: [makeEvidence({ findingId: fid })],
    };
    const judge = scriptedJudge({
      "judge-primary": "APPROVE_OVERRIDE",
      "judge-secondary": "REJECT_OVERRIDE",
      "judge-tertiary": "REJECT_OVERRIDE",
    });
    const outcome = await runOverrideCouncil([f], evidenceFile, judge);
    expect(outcome.approvedFindingIds.has(fid)).toBe(false);
    expect(outcome.rejectedFindingIds.has(fid)).toBe(true);
  });

  it("rejects when all 3 judges reject (0-3)", async () => {
    const f = makeFinding();
    const fid = canonicalFindingId(f);
    const evidenceFile: CounterEvidenceFile = {
      iteration: 1,
      evidence: [makeEvidence({ findingId: fid })],
    };
    const outcome = await runOverrideCouncil([f], evidenceFile, rejectJudge());
    expect(outcome.approvedFindingIds.has(fid)).toBe(false);
    expect(outcome.rejectedFindingIds.has(fid)).toBe(true);
  });

  it("passes (finding, evidence, judge) to each judge invocation", async () => {
    const f = makeFinding({ reviewer: "security-sentinel" });
    const fid = canonicalFindingId(f);
    const ev = makeEvidence({ findingId: fid, claim: "specific claim text" });
    const evidenceFile: CounterEvidenceFile = { iteration: 1, evidence: [ev] };

    const seen: Array<{ finding: Finding; evidence: CounterEvidence; judge: string }> = [];
    const judge: OverrideJudgeFn = async (input) => {
      seen.push(input);
      return { judge: input.judge, verdict: "APPROVE_OVERRIDE", reasoning: "ok" };
    };

    const outcome = await runOverrideCouncil([f], evidenceFile, judge);
    expect(outcome.votes[fid]?.length).toBe(3);
    expect(seen.length).toBe(3);
    // Every call received the same finding + evidence reference and a unique judge name.
    const judgeNames = seen.map((s) => s.judge).sort();
    expect(judgeNames).toEqual([...DEFAULT_OVERRIDE_JUDGES].sort());
    for (const s of seen) {
      expect(s.finding).toBe(f);
      expect(s.evidence).toBe(ev);
    }
  });

  it("keys the votes map by canonicalFindingId", async () => {
    const f1 = makeFinding({ reviewer: "architecture-strategist" });
    const f2 = makeFinding({ reviewer: "security-sentinel", raw: "[High] sql in src/db.ts:7" });
    const fid1 = canonicalFindingId(f1);
    const fid2 = canonicalFindingId(f2);
    const evidenceFile: CounterEvidenceFile = {
      iteration: 1,
      evidence: [
        makeEvidence({ findingId: fid1 }),
        makeEvidence({ findingId: fid2 }),
      ],
    };
    const outcome = await runOverrideCouncil([f1, f2], evidenceFile, approveJudge());
    expect(Object.keys(outcome.votes).sort()).toEqual([fid1, fid2].sort());
    expect(outcome.votes[fid1]?.length).toBe(3);
    expect(outcome.votes[fid2]?.length).toBe(3);
  });

  it("honors a custom opts.judges list", async () => {
    const f = makeFinding();
    const fid = canonicalFindingId(f);
    const evidenceFile: CounterEvidenceFile = {
      iteration: 1,
      evidence: [makeEvidence({ findingId: fid })],
    };
    const seenJudges: string[] = [];
    const judge: OverrideJudgeFn = async ({ judge: j }) => {
      seenJudges.push(j);
      return { judge: j, verdict: "APPROVE_OVERRIDE", reasoning: "ok" };
    };
    await runOverrideCouncil([f], evidenceFile, judge, {
      judges: ["alpha", "beta", "gamma", "delta"],
    });
    expect(seenJudges.sort()).toEqual(["alpha", "beta", "delta", "gamma"]);
  });
});

// --- recordOverrideOutcome ------------------------------------------------

function readLearnings(lokiDir: string): Array<Record<string, unknown>> {
  const path = join(lokiDir, "state", "relevant-learnings.json");
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  return (parsed["learnings"] as Array<Record<string, unknown>>) ?? [];
}

describe("recordOverrideOutcome", () => {
  it("appends a override_approved learning per approved finding", async () => {
    const f = makeFinding();
    const fid = canonicalFindingId(f);
    const outcome: OverrideOutcome = {
      approvedFindingIds: new Set([fid]),
      rejectedFindingIds: new Set(),
      votes: {},
    };
    await recordOverrideOutcome(scratch, 9, outcome, [f]);

    const learnings = readLearnings(scratch);
    expect(learnings.length).toBe(1);
    const entry = learnings[0]!;
    expect(entry["trigger"]).toBe("override_approved");
    expect(entry["iteration"]).toBe(9);
    expect(entry["rootCause"]).toContain("[Critical]");
    expect(entry["rootCause"]).toContain("hardcoded secret");
    const evidence = entry["evidence"] as Record<string, unknown>;
    expect(evidence["findingId"]).toBe(fid);
    expect(evidence["reviewer"]).toBe("architecture-strategist");
    expect(evidence["severity"]).toBe("Critical");
    expect(evidence["file"]).toBe("src/api.ts");
    expect(evidence["line"]).toBe(42);
  });

  it("appends a override_rejected learning per rejected finding", async () => {
    const f = makeFinding({
      reviewer: "security-sentinel",
      raw: "[High] sql injection in src/db.ts:7",
      description: "sql injection in src/db.ts:7",
      severity: "High",
      file: "src/db.ts",
      line: 7,
    });
    const fid = canonicalFindingId(f);
    const outcome: OverrideOutcome = {
      approvedFindingIds: new Set(),
      rejectedFindingIds: new Set([fid]),
      votes: {},
    };
    await recordOverrideOutcome(scratch, 11, outcome, [f]);

    const learnings = readLearnings(scratch);
    expect(learnings.length).toBe(1);
    const entry = learnings[0]!;
    expect(entry["trigger"]).toBe("override_rejected");
    expect(entry["iteration"]).toBe(11);
    expect(entry["rootCause"]).toContain("[High]");
    const evidence = entry["evidence"] as Record<string, unknown>;
    expect(evidence["findingId"]).toBe(fid);
    expect(evidence["reviewer"]).toBe("security-sentinel");
    expect(evidence["severity"]).toBe("High");
    expect(evidence["file"]).toBe("src/db.ts");
    expect(evidence["line"]).toBe(7);
  });

  it("writes one learning per finding when both approved and rejected are present", async () => {
    const fa = makeFinding({ reviewer: "architecture-strategist" });
    const fr = makeFinding({
      reviewer: "test-coverage-auditor",
      raw: "[Medium] missing test for handler",
      description: "missing test for handler",
      severity: "Medium",
      file: null,
      line: null,
    });
    const fida = canonicalFindingId(fa);
    const fidr = canonicalFindingId(fr);
    const outcome: OverrideOutcome = {
      approvedFindingIds: new Set([fida]),
      rejectedFindingIds: new Set([fidr]),
      votes: {},
    };
    await recordOverrideOutcome(scratch, 2, outcome, [fa, fr]);

    const learnings = readLearnings(scratch);
    expect(learnings.length).toBe(2);
    const triggers = learnings.map((l) => l["trigger"]).sort();
    expect(triggers).toEqual(["override_approved", "override_rejected"]);
  });

  it("is a no-op for findings absent from both sets", async () => {
    const f = makeFinding();
    const outcome: OverrideOutcome = {
      approvedFindingIds: new Set(),
      rejectedFindingIds: new Set(),
      votes: {},
    };
    await recordOverrideOutcome(scratch, 1, outcome, [f]);
    expect(readLearnings(scratch)).toEqual([]);
  });
});

// --- canonicalFindingId collision safety (W10 bug-hunt) -------------------
//
// Two distinct blocking findings from the SAME reviewer whose `raw` text
// differs only after the first 80 chars collapse to ONE canonicalFindingId
// (`${reviewer}::${raw.slice(0,80)}`). Before the fix, runOverrideCouncil
// looked up a SINGLE evidence entry by that shared id and judged BOTH
// findings against it, so a blocker that had NO evidence of its own could be
// lifted using a sibling's evidence -- the unsafe (toward-approve) direction
// for a BLOCK gate. The fix detects the collision and forces ALL colliding
// findings to rejected (BLOCK stays) WITHOUT calling judges, preserving the
// safe default and the documented id-emit contract (formula unchanged).

describe("runOverrideCouncil -- canonicalFindingId collision safety", () => {
  // 80-char shared prefix; the two findings diverge only afterward. The id
  // formula is `${reviewer}::${raw.slice(0,80)}` so identical first-80 chars
  // collide regardless of what follows.
  const sharedPrefix = "[Critical] insecure deserialization in src/handler/very/deeply/nested/xyzABCabcd";

  function collidingPair(): { f1: Finding; f2: Finding } {
    expect(sharedPrefix.length).toBe(80); // guard: prefix must be exactly 80 chars
    const f1 = makeFinding({
      reviewer: "security-sentinel",
      raw: sharedPrefix + "AAAA.ts:10",
      description: "insecure deserialization (variant 1)",
    });
    const f2 = makeFinding({
      reviewer: "security-sentinel",
      raw: sharedPrefix + "BBBB.ts:99",
      description: "insecure deserialization (variant 2)",
    });
    return { f1, f2 };
  }

  it("two findings sharing a canonical id collapse to one (collision precondition)", () => {
    const { f1, f2 } = collidingPair();
    expect(canonicalFindingId(f1)).toBe(canonicalFindingId(f2));
  });

  it("does NOT lift a colliding blocker that has no evidence of its own", async () => {
    const { f1, f2 } = collidingPair();
    const fid = canonicalFindingId(f1); // shared id
    // Only ONE evidence entry, semantically for f1. f2 supplied no evidence.
    const evidenceFile: CounterEvidenceFile = {
      iteration: 1,
      evidence: [makeEvidence({ findingId: fid })],
    };
    // A judge that would APPROVE every override it is asked to vote on.
    const outcome = await runOverrideCouncil([f1, f2], evidenceFile, approveJudge());
    // SAFE DEFAULT: an id shared by >1 distinct finding must NOT lift the BLOCK.
    // Pre-fix this asserted-true (fid landed in approvedFindingIds via the
    // sibling's evidence); post-fix the BLOCK is preserved.
    expect(outcome.approvedFindingIds.has(fid)).toBe(false);
    expect(outcome.rejectedFindingIds.has(fid)).toBe(true);
  });

  it("does NOT call judges on a collided id (no evidence is trusted across siblings)", async () => {
    const { f1, f2 } = collidingPair();
    const fid = canonicalFindingId(f1);
    const evidenceFile: CounterEvidenceFile = {
      iteration: 1,
      evidence: [makeEvidence({ findingId: fid })],
    };
    let judgeCalls = 0;
    const countingJudge: OverrideJudgeFn = async ({ judge }) => {
      judgeCalls++;
      return { judge, verdict: "APPROVE_OVERRIDE", reasoning: "ok" };
    };
    await runOverrideCouncil([f1, f2], evidenceFile, countingJudge);
    // No judge fan-out for the ambiguous collided id.
    expect(judgeCalls).toBe(0);
  });

  it("still lifts a non-colliding finding with its own evidence (no regression)", async () => {
    const f = makeFinding({ reviewer: "architecture-strategist" });
    const fid = canonicalFindingId(f);
    const evidenceFile: CounterEvidenceFile = {
      iteration: 1,
      evidence: [makeEvidence({ findingId: fid })],
    };
    const outcome = await runOverrideCouncil([f], evidenceFile, approveJudge());
    expect(outcome.approvedFindingIds.has(fid)).toBe(true);
    expect(outcome.rejectedFindingIds.has(fid)).toBe(false);
  });
});

// --- DEFAULT_OVERRIDE_JUDGES ----------------------------------------------

describe("DEFAULT_OVERRIDE_JUDGES", () => {
  it("exposes the documented 3 judge names", () => {
    expect([...DEFAULT_OVERRIDE_JUDGES]).toEqual([
      "judge-primary",
      "judge-secondary",
      "judge-tertiary",
    ]);
  });
});
