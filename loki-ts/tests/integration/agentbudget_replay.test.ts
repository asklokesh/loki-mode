// Integration replay of the agentbudget v7.4.20 -> v7.5.0 dead-duplicate
// scenario.
//
// Background:
//   In agentbudget, the eng-qa reviewer flagged "[Critical] dead code path
//   bug at sdk/python/gauge/client.py:55". That file is a dead duplicate --
//   the live module lives at sdk/src/gauge/client.py. The reviewer was
//   correctly reading the file, but the file itself should not have been
//   read. Pre-v7.4.20 the legacy-healing-auditor compounded this by also
//   BLOCKing on missing characterization tests, and the gate would fail 10x
//   in a row -> forced PAUSE.
//
//   v7.4.20 fixed the trigger: legacy-healing-auditor is excluded from the
//   default reviewer pool unless healing mode is signaled. That covers the
//   auditor false positive specifically.
//
//   v7.5.0 (this work) goes further: it adds an override council so OTHER
//   reviewers' false positives -- like eng-qa misreading dead code -- can be
//   lifted via 2-of-3 judge vote when the dev agent supplies counter-evidence.
//
// What this test proves end-to-end:
//   1. loadPreviousFindings parses real-shaped reviewer output -- the
//      [Critical] tag, the file:line trailer, the per-reviewer .txt file --
//      into structured Finding records.
//   2. loadCounterEvidence reads the dev agent's pushback file.
//   3. runOverrideCouncil consumes (Finding, CounterEvidence) and a 3-judge
//      stub, and partitions findings into approved vs rejected on a 2-of-3
//      vote. With all 3 stubs returning APPROVE_OVERRIDE the dead-code
//      finding is lifted.
//   4. recordOverrideOutcome persists the lift into
//      .loki/state/relevant-learnings.json so the next iteration's prompt
//      can surface it.
//   5. Nothing in this flow writes .loki/PAUSE -- the override is the
//      replacement for the "fail 10x -> PAUSE" trap.

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPreviousFindings } from "../../src/runner/findings_injector.ts";
import {
  canonicalFindingId,
  loadCounterEvidence,
  recordOverrideOutcome,
  runOverrideCouncil,
  type CounterEvidenceFile,
  type OverrideJudgeFn,
} from "../../src/runner/counter_evidence.ts";
import type { LearningsFile } from "../../src/runner/learnings_writer.ts";

describe("agentbudget dead-duplicate replay (v7.5.0 override council)", () => {
  it("structured findings extraction + 3-judge override + learning persistence", async () => {
    // 1. Scratch .loki dir -- isolated so the test never touches real state.
    const scratch = mkdtempSync(join(tmpdir(), "loki-agentbudget-replay-"));
    try {
      // 2. Build a fake review directory mirroring the agentbudget run.
      //    Naming convention is review-<ts>-<iteration> per quality_gates.ts.
      const reviewId = "review-20260427T120000Z-3";
      const reviewDir = join(scratch, "quality", "reviews", reviewId);
      mkdirSync(reviewDir, { recursive: true });

      const aggregate = {
        review_id: reviewId,
        iteration: 3,
        pass_count: 2,
        fail_count: 1,
        has_blocking: true,
        verdicts:
          "architecture-strategist:PASS,security-sentinel:PASS,eng-qa:FAIL",
      };
      writeFileSync(
        join(reviewDir, "aggregate.json"),
        JSON.stringify(aggregate, null, 2),
      );

      // The dead-duplicate finding lives in eng-qa's prose output. The
      // FILE_LINE_RE regex in findings_injector pulls (file, line) from the
      // trailing "<file>:<line>" token, so this format must match exactly.
      writeFileSync(
        join(reviewDir, "eng-qa.txt"),
        "VERDICT: FAIL\nFINDINGS:\n- [Critical] dead code path bug at sdk/python/gauge/client.py:55\n",
      );
      writeFileSync(
        join(reviewDir, "architecture-strategist.txt"),
        "VERDICT: PASS\nFINDINGS:\n- None\n",
      );
      writeFileSync(
        join(reviewDir, "security-sentinel.txt"),
        "VERDICT: PASS\nFINDINGS:\n- None\n",
      );

      // 3. loadPreviousFindings should return exactly one finding -- the
      //    Critical dead-code report from eng-qa. The two PASS reviewers have
      //    no [Severity] markers in their bodies and must be ignored.
      const loaded = loadPreviousFindings(scratch, 3);
      expect(loaded.reviewDir).toBe(reviewDir);
      expect(loaded.reviewId).toBe(reviewId);
      expect(loaded.iteration).toBe(3);
      expect(loaded.findings.length).toBe(1);

      const finding = loaded.findings[0]!;
      expect(finding.severity).toBe("Critical");
      expect(finding.file).toBe("sdk/python/gauge/client.py");
      expect(finding.line).toBe(55);
      expect(finding.reviewer).toBe("eng-qa");
      expect(finding.reviewId).toBe(reviewId);
      expect(finding.iteration).toBe(3);

      // 4. The dev agent emits counter-evidence. The findingId MUST match the
      //    canonical id derived from (reviewer + first 80 chars of raw line) --
      //    that is the contract documented in counter_evidence.ts.
      const fid = canonicalFindingId(finding);
      const evidenceFile: CounterEvidenceFile = {
        iteration: 3,
        evidence: [
          {
            findingId: fid,
            claim:
              "sdk/python/gauge/client.py is a dead duplicate; live code is at sdk/src/gauge/client.py",
            proofType: "duplicate-code-path",
            artifacts: [
              "git log --diff-filter=D shows sdk/python/ removed in commit abc123",
              "grep -r 'from sdk.python.gauge' . returns no matches",
            ],
          },
        ],
      };
      const evidencePath = join(scratch, "state", `counter-evidence-3.json`);
      mkdirSync(join(scratch, "state"), { recursive: true });
      writeFileSync(evidencePath, JSON.stringify(evidenceFile, null, 2));

      // 5. loadCounterEvidence parses the file and returns it untouched.
      const reloaded = loadCounterEvidence(scratch, 3);
      expect(reloaded).not.toBeNull();
      expect(reloaded!.iteration).toBe(3);
      expect(reloaded!.evidence.length).toBe(1);
      expect(reloaded!.evidence[0]!.findingId).toBe(fid);
      expect(reloaded!.evidence[0]!.proofType).toBe("duplicate-code-path");

      // 6. Stub OverrideJudgeFn -- the dead-code case is clean-cut, so all 3
      //    judges return APPROVE_OVERRIDE. Production wires this to 3 distinct
      //    providers; here we model unanimous approval.
      const judgeCalls: Array<{ judge: string; findingId: string }> = [];
      const stubJudge: OverrideJudgeFn = async ({ finding: f, judge }) => {
        judgeCalls.push({ judge, findingId: canonicalFindingId(f) });
        return {
          judge,
          verdict: "APPROVE_OVERRIDE",
          reasoning:
            "file is a dead duplicate -- live code at sdk/src/gauge/client.py; finding was a misread",
        };
      };

      // 7. runOverrideCouncil partitions findings; with 3-of-3 approve the
      //    finding lands in approvedFindingIds.
      const outcome = await runOverrideCouncil(
        loaded.findings,
        reloaded!,
        stubJudge,
      );
      expect(outcome.approvedFindingIds.has(fid)).toBe(true);
      expect(outcome.rejectedFindingIds.has(fid)).toBe(false);
      expect(outcome.votes[fid]?.length).toBe(3);
      expect(outcome.votes[fid]?.every((v) => v.verdict === "APPROVE_OVERRIDE"))
        .toBe(true);
      // Sanity: the council fanned out to all 3 default judges for this single
      // finding (3 calls total).
      expect(judgeCalls.length).toBe(3);

      // 8. recordOverrideOutcome appends an "override_approved" learning to
      //    .loki/state/relevant-learnings.json. build_prompt.ts will surface
      //    this on the next iteration so the LLM does not re-flag dead code.
      await recordOverrideOutcome(scratch, 3, outcome, loaded.findings);

      const learningsPath = join(scratch, "state", "relevant-learnings.json");
      expect(existsSync(learningsPath)).toBe(true);
      const learnings = JSON.parse(
        readFileSync(learningsPath, "utf-8"),
      ) as LearningsFile;
      expect(learnings.version).toBe(1);
      expect(learnings.learnings.length).toBe(1);

      const learning = learnings.learnings[0]!;
      expect(learning.trigger).toBe("override_approved");
      expect(learning.iteration).toBe(3);
      expect(learning.rootCause).toContain("[Critical]");
      expect(learning.rootCause).toContain("dead code path bug");
      expect(learning.evidence.findingId).toBe(fid);
      expect(learning.evidence.reviewId).toBe(reviewId);
      expect(learning.evidence.file).toBe("sdk/python/gauge/client.py");
      expect(learning.evidence.line).toBe(55);
      expect(learning.evidence.severity).toBe("Critical");
      expect(learning.evidence.reviewer).toBe("eng-qa");

      // 9. The whole point of the override council is to AVOID the PAUSE
      //    trap. Nothing in this flow calls writePauseSignal, so the marker
      //    must not exist.
      expect(existsSync(join(scratch, "PAUSE"))).toBe(false);
    } finally {
      if (scratch && existsSync(scratch)) {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  });
});
