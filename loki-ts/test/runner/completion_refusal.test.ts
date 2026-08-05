// Trust-critical: the fail-closed completion-refusal decision. The runner must
// REFUSE to declare a build complete this iteration when the gate signal is
// untrustworthy (a crashed gate battery) or a real BLOCK is present -- BEFORE the
// council vote. A regression here is a fake-PASS (a broken/ungated build shipped
// green), the exact failure Loki's moat exists to prevent. These test the pure
// decision extracted from runAutonomous; no loop, no I/O.
import { describe, expect, test } from "bun:test";
import {
  completionRefusalReason,
  completionEvidenceRefusal,
  envBlockFlagOn,
} from "../../src/runner/autonomous.ts";

const clean = { blocked: false, failed: [] as string[] };

describe("completionRefusalReason: fail-closed on a crashed gate battery", () => {
  test("gatesThrew=true refuses completion even with a clean outcome", () => {
    // The load-bearing new guard: a thrown battery leaves gateOutcome at its
    // default {blocked:false,failed:[]}, which used to fall through to the council
    // and pass ungated. It must now refuse.
    const r = completionRefusalReason(true, clean, {});
    expect(r).not.toBeNull();
    expect(r).toContain("fail-closed");
  });

  test("gatesThrew wins even if the outcome looks passable", () => {
    expect(completionRefusalReason(true, { blocked: false, failed: [] }, {})).not.toBeNull();
  });
});

describe("completionRefusalReason: clean run is NEVER over-blocked", () => {
  test("gates ran clean, nothing blocked -> proceed to council (null)", () => {
    expect(completionRefusalReason(false, clean, {})).toBeNull();
  });

  test("a finding in failed[] but blocked=false does NOT refuse (advisory/soft-gates)", () => {
    expect(
      completionRefusalReason(false, { blocked: false, failed: ["code_review"] }, {}),
    ).toBeNull();
  });

  test("semantic_tests in failed[] + blocked but toggle OFF does NOT refuse", () => {
    expect(
      completionRefusalReason(false, { blocked: true, failed: ["semantic_tests"] }, {}),
    ).toBeNull();
  });
});

describe("completionRefusalReason: code_review BLOCK always refuses", () => {
  test("blocked + code_review in failed -> refuse", () => {
    const r = completionRefusalReason(false, { blocked: true, failed: ["code_review"] }, {});
    expect(r).toContain("code_review");
  });

  // Wave B #2: a code_review cleared by CLEAR_LIMIT (in `cleared`, not `failed`)
  // is still an unresolved BLOCK and must STILL refuse completion.
  test("cleared-but-still-failing code_review still refuses (CLEAR_LIMIT loophole closed)", () => {
    const r = completionRefusalReason(false, { blocked: true, failed: [], cleared: ["code_review"] }, {});
    expect(r).toContain("code_review");
  });

  test("a cleared NON-refusing gate (e.g. static_analysis) does NOT refuse", () => {
    const r = completionRefusalReason(
      false,
      { blocked: true, failed: [], cleared: ["static_analysis"] },
      {},
    );
    expect(r).toBeNull();
  });
});

describe("completionRefusalReason: opt-in _BLOCK gates", () => {
  test("semantic_tests refuses only with its toggle on", () => {
    const outcome = { blocked: true, failed: ["semantic_tests"] };
    expect(completionRefusalReason(false, outcome, {})).toBeNull();
    expect(
      completionRefusalReason(false, outcome, { LOKI_GATE_SEMANTIC_TESTS_BLOCK: "1" }),
    ).toContain("semantic_tests");
    expect(
      completionRefusalReason(false, outcome, { LOKI_GATE_SEMANTIC_TESTS_BLOCK: "true" }),
    ).toContain("semantic_tests");
  });

  test("invariants refuses only with its toggle on", () => {
    const outcome = { blocked: true, failed: ["invariants"] };
    expect(completionRefusalReason(false, outcome, {})).toBeNull();
    expect(
      completionRefusalReason(false, outcome, { LOKI_GATE_INVARIANTS_BLOCK: "true" }),
    ).toContain("invariants");
  });

  test("test_coverage (failing suite) is ADVISORY by default, refuses only with opt-in", () => {
    // The default-off ceiling: a failing test suite does NOT refuse completion at
    // this layer by default (the council evidence gate is the backstop); the opt-in
    // makes it fail-closed here too.
    const outcome = { blocked: true, failed: ["test_coverage"] };
    expect(completionRefusalReason(false, outcome, {})).toBeNull();
    expect(
      completionRefusalReason(false, outcome, { LOKI_GATE_TEST_COVERAGE_BLOCK: "1" }),
    ).toContain("test_coverage");
  });
});

describe("envBlockFlagOn: bash truthiness parity", () => {
  test("'true' and '1' are on; everything else off", () => {
    expect(envBlockFlagOn("true")).toBe(true);
    expect(envBlockFlagOn("1")).toBe(true);
    expect(envBlockFlagOn("yes")).toBe(false); // NOT truthy for _BLOCK (bash uses = "true"/"1")
    expect(envBlockFlagOn("0")).toBe(false);
    expect(envBlockFlagOn("")).toBe(false);
    expect(envBlockFlagOn(undefined)).toBe(false);
  });
});

// RUN-25 iter 6 (Wave B #1): the completion-EVIDENCE backstop. On the Bun route
// defaultCouncil.shouldStop is a no-op, so a self-attested completion could ship
// "done" with unresolved failures. completionEvidenceRefusal refuses completion
// while the failure ledger (queue/failed.json) is red or corrupt -- pure over
// injected readFile/fileExists so no real FS is needed.
describe("completionEvidenceRefusal: failure-ledger backstop", () => {
  const LOKI = "/x/.loki";
  const at = (rel: string) => `${LOKI}/${rel}`;

  test("no ledger file -> allow (nothing has failed)", () => {
    const r = completionEvidenceRefusal(
      LOKI,
      () => null,
      (p) => p !== at("queue/failed.json"),
    );
    expect(r).toBeNull();
  });

  test("empty ledger ([] / {} / blank) -> allow", () => {
    for (const body of ["[]", "{}", "  ", ""]) {
      const r = completionEvidenceRefusal(LOKI, () => body, () => true);
      expect(r).toBeNull();
    }
  });

  test("non-empty array ledger -> REFUSE (unresolved failures)", () => {
    const r = completionEvidenceRefusal(LOKI, () => JSON.stringify([{ task: "a" }, { task: "b" }]), () => true);
    expect(r).not.toBeNull();
    expect(r).toContain("2 unresolved");
  });

  test("non-empty object ledger -> REFUSE", () => {
    const r = completionEvidenceRefusal(LOKI, () => JSON.stringify({ t1: "failed" }), () => true);
    expect(r).not.toBeNull();
  });

  test("present-but-unreadable ledger -> REFUSE (fail closed)", () => {
    const r = completionEvidenceRefusal(LOKI, () => null, () => true);
    expect(r).not.toBeNull();
    expect(r).toContain("unreadable");
  });

  test("present-but-corrupt (unparseable) ledger -> REFUSE (fail closed)", () => {
    const r = completionEvidenceRefusal(LOKI, () => "not json {{{", () => true);
    expect(r).not.toBeNull();
    expect(r).toContain("corrupt");
  });
});
