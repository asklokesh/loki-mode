// Phase 1 (v7.5.0) integration: end-to-end override-on-BLOCK flow.
//
// Council R1 + R3 finding: pre-fix, runOverrideCouncil was exported but
// never called, and council.ts returned APPROVE on file presence alone
// (rubber-stamping any counter-evidence). This test proves the wired
// behavior: when LOKI_INJECT_FINDINGS=1 and LOKI_OVERRIDE_COUNCIL=1 and
// counter-evidence exists with a trusted proofType, runCodeReview lifts
// the BLOCK; otherwise it stays blocked.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runCodeReview,
} from "../../src/runner/quality_gates.ts";
import type { ReviewerFn } from "../../src/runner/quality_gates.ts";
import type { RunnerContext } from "../../src/runner/types.ts";
import { canonicalFindingId } from "../../src/runner/counter_evidence.ts";

let scratch = "";
const ENV_KEYS = [
  "LOKI_INJECT_FINDINGS",
  "LOKI_OVERRIDE_COUNCIL",
  "LOKI_AUTO_LEARNINGS",
  "LOKI_OVERRIDE_REAL_JUDGE",
];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "loki-override-block-"));
  // v7.5.4: force the stub-judge path so this test is hermetic. With
  // real-judges default-on, the test would otherwise spawn a provider
  // CLI and either hang (no provider configured) or cost real tokens.
  process.env["LOKI_OVERRIDE_REAL_JUDGE"] = "0";
});

afterEach(() => {
  if (scratch && existsSync(scratch)) {
    rmSync(scratch, { recursive: true, force: true });
  }
  for (const k of ENV_KEYS) delete process.env[k];
});

function ctxAt(iter: number): RunnerContext {
  return {
    cwd: scratch,
    lokiDir: scratch,
    prdPath: undefined,
    provider: "claude",
    maxRetries: 5,
    maxIterations: 10,
    baseWaitSeconds: 1,
    maxWaitSeconds: 60,
    autonomyMode: "single-pass",
    sessionModel: "development",
    budgetLimit: undefined,
    completionPromise: undefined,
    iterationCount: iter,
    retryCount: 0,
    currentTier: "development",
    log: () => {},
  };
}

// Reviewer stub that returns FAIL with a [Critical] finding.
const failReviewer: ReviewerFn = async ({ reviewer }) => {
  if (reviewer.name === "architecture-strategist") {
    return "VERDICT: FAIL\nFINDINGS:\n- [Critical] dead code path bug at sdk/python/gauge/client.py:55";
  }
  return "VERDICT: PASS\nFINDINGS:\n- (none)";
};

describe("Phase 1 v7.5.0 override council on BLOCK", () => {
  it("blocks when override council is OFF (default behavior)", async () => {
    const r = await runCodeReview(ctxAt(7), {
      reviewer: failReviewer,
      diffOverride: { diff: "+ const x = 1;\n", files: "src/x.ts\n" },
    });
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("blocking severity present");
  });

  it("blocks when override council is ON but no counter-evidence file exists", async () => {
    process.env["LOKI_INJECT_FINDINGS"] = "1";
    process.env["LOKI_OVERRIDE_COUNCIL"] = "1";
    const r = await runCodeReview(ctxAt(7), {
      reviewer: failReviewer,
      diffOverride: { diff: "+ const x = 1;\n", files: "src/x.ts\n" },
    });
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("blocking severity present");
  });

  it("lifts BLOCK when override council is ON, counter-evidence exists, and proofType is trusted", async () => {
    process.env["LOKI_INJECT_FINDINGS"] = "1";
    process.env["LOKI_OVERRIDE_COUNCIL"] = "1";

    // Run #1 to populate the review directory + findings-<iter>.json
    const ctx1 = ctxAt(7);
    const r1 = await runCodeReview(ctx1, {
      reviewer: failReviewer,
      diffOverride: { diff: "+ const x = 1;\n", files: "src/x.ts\n" },
    });
    expect(r1.passed).toBe(false);
    expect(existsSync(join(scratch, "state", "findings-7.json"))).toBe(true);
    const persisted = JSON.parse(
      readFileSync(join(scratch, "state", "findings-7.json"), "utf-8"),
    ) as { findings: Array<{ raw: string; reviewer: string }> };
    expect(persisted.findings.length).toBeGreaterThanOrEqual(1);

    // Build counter-evidence for the persisted finding(s) with a trusted proofType
    const fid = canonicalFindingId({
      raw: persisted.findings[0]!.raw,
      reviewer: persisted.findings[0]!.reviewer,
    } as any);
    const stateDir = join(scratch, "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "counter-evidence-7.json"),
      JSON.stringify({
        iteration: 7,
        evidence: [
          {
            findingId: fid,
            claim: "this code path is dead duplicate; live code is at sdk/src/gauge/",
            proofType: "duplicate-code-path",
            artifacts: ["sdk/python/ is excluded by pyproject.toml"],
          },
        ],
      }),
    );

    // Run #2: same diff; override should lift the BLOCK.
    const ctx2 = ctxAt(7);
    const r2 = await runCodeReview(ctx2, {
      reviewer: failReviewer,
      diffOverride: { diff: "+ const x = 1;\n", files: "src/x.ts\n" },
    });
    expect(r2.passed).toBe(true);
    expect(r2.detail).toContain("blockers lifted by override council");

    // Verify learnings written for the override
    const learnPath = join(scratch, "state", "relevant-learnings.json");
    expect(existsSync(learnPath)).toBe(true);
    const learnings = JSON.parse(readFileSync(learnPath, "utf-8")) as {
      learnings: Array<{ trigger: string }>;
    };
    expect(learnings.learnings.some((l) => l.trigger === "override_approved")).toBe(true);
  });

  it("rejects override when proofType is NOT trusted (e.g. 'reviewer-misread' is trusted, 'free-form' is not)", async () => {
    process.env["LOKI_INJECT_FINDINGS"] = "1";
    process.env["LOKI_OVERRIDE_COUNCIL"] = "1";

    const ctx1 = ctxAt(8);
    await runCodeReview(ctx1, {
      reviewer: failReviewer,
      diffOverride: { diff: "+ const y = 2;\n", files: "src/y.ts\n" },
    });
    const persisted = JSON.parse(
      readFileSync(join(scratch, "state", "findings-8.json"), "utf-8"),
    ) as { findings: Array<{ raw: string; reviewer: string }> };

    const fid = canonicalFindingId({
      raw: persisted.findings[0]!.raw,
      reviewer: persisted.findings[0]!.reviewer,
    } as any);
    writeFileSync(
      join(scratch, "state", "counter-evidence-8.json"),
      JSON.stringify({
        iteration: 8,
        evidence: [
          {
            findingId: fid,
            claim: "I disagree",
            proofType: "free-form-handwave",
            artifacts: [],
          },
        ],
      }),
    );

    const r2 = await runCodeReview(ctxAt(8), {
      reviewer: failReviewer,
      diffOverride: { diff: "+ const y = 2;\n", files: "src/y.ts\n" },
    });
    expect(r2.passed).toBe(false);
    expect(r2.detail).toContain("blocking severity present");
  });
});
