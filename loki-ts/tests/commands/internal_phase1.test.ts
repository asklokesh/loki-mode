// v7.5.3 tests for `loki internal phase1-hooks` -- the hidden Bun
// subcommand bash autonomy/run.sh calls between iterations.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __testAppendHook, runInternalPhase1Hooks } from "../../src/commands/internal_phase1.ts";

let scratch = "";
let originalLokiDir: string | undefined;
let originalRealJudge: string | undefined;
let captured = { stdout: "", stderr: "" };
let originalStdout: typeof process.stdout.write;
let originalStderr: typeof process.stderr.write;

function capture(): () => { stdout: string; stderr: string } {
  captured = { stdout: "", stderr: "" };
  originalStdout = process.stdout.write.bind(process.stdout);
  originalStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: unknown): boolean => {
    captured.stdout += String(c);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown): boolean => {
    captured.stderr += String(c);
    return true;
  }) as typeof process.stderr.write;
  return () => {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    return captured;
  };
}

function seedReview(iter: number, findings: string[]): void {
  const dir = join(scratch, "quality", "reviews", `review-test-${iter}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "aggregate.json"),
    JSON.stringify({
      review_id: `review-test-${iter}`,
      iteration: iter,
      pass_count: 2,
      fail_count: 1,
      has_blocking: true,
      verdicts: "x",
    }),
  );
  writeFileSync(
    join(dir, "eng-qa.txt"),
    `VERDICT: FAIL\nFINDINGS:\n${findings.map((f) => `- ${f}`).join("\n")}\n`,
  );
}

beforeEach(() => {
  originalLokiDir = process.env["LOKI_DIR"];
  originalRealJudge = process.env["LOKI_OVERRIDE_REAL_JUDGE"];
  scratch = mkdtempSync(join(tmpdir(), "loki-phase1-hook-"));
  process.env["LOKI_DIR"] = scratch;
  // Force the stub-judge path so override() does not try to spawn a CLI.
  process.env["LOKI_OVERRIDE_REAL_JUDGE"] = "0";
});

afterEach(() => {
  // Reset the test-only append seam (the H2 tests install a throwing stub).
  // This is a plain module-local property, not Bun's global mock.module
  // registry, so it restores deterministically here regardless of whether a
  // test threw -- closing the cross-file leak that mock.module produced.
  __testAppendHook.fn = null;
  if (originalLokiDir === undefined) delete process.env["LOKI_DIR"];
  else process.env["LOKI_DIR"] = originalLokiDir;
  if (originalRealJudge === undefined) delete process.env["LOKI_OVERRIDE_REAL_JUDGE"];
  else process.env["LOKI_OVERRIDE_REAL_JUDGE"] = originalRealJudge;
  if (scratch && existsSync(scratch)) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

describe("v7.5.3 loki internal phase1-hooks", () => {
  it("help prints usage and exits 0", async () => {
    const stop = capture();
    const code = await runInternalPhase1Hooks(["help"]);
    const out = stop();
    expect(code).toBe(0);
    expect(out.stdout).toContain("loki internal phase1-hooks");
  });

  it("reflect <iter> persists findings-<iter>.json + learnings", async () => {
    seedReview(7, ["[Critical] dead code at sdk/python/x.py:55"]);
    const stop = capture();
    const code = await runInternalPhase1Hooks(["reflect", "7"]);
    const out = stop();
    expect(code).toBe(0);
    expect(out.stdout).toContain("persisted 1 findings");
    expect(existsSync(join(scratch, "state", "findings-7.json"))).toBe(true);
    expect(existsSync(join(scratch, "state", "relevant-learnings.json"))).toBe(true);
    const persisted = JSON.parse(
      readFileSync(join(scratch, "state", "findings-7.json"), "utf-8"),
    ) as { findings: Array<{ severity: string }> };
    expect(persisted.findings.length).toBe(1);
    expect(persisted.findings[0]!.severity).toBe("Critical");
  });

  it("reflect on missing iter: exit 0 with 'no findings' message", async () => {
    const stop = capture();
    const code = await runInternalPhase1Hooks(["reflect", "99"]);
    const out = stop();
    expect(code).toBe(0);
    expect(out.stdout).toContain("no findings");
  });

  it("override <iter> with no counter-evidence: skip", async () => {
    seedReview(8, ["[High] something at src/x.ts:1"]);
    const stop = capture();
    const code = await runInternalPhase1Hooks(["override", "8"]);
    const out = stop();
    expect(code).toBe(0);
    expect(out.stdout).toContain("no counter-evidence");
  });

  it("override <iter> with trusted proofType + artifact lifts BLOCK", async () => {
    seedReview(9, ["[Critical] dup code at sdk/python/x.py:1"]);
    // Compute the expected findingId via the canonical algorithm.
    const ce = await import("../../src/runner/counter_evidence.ts");
    const fInjector = await import("../../src/runner/findings_injector.ts");
    const findings = fInjector.loadPreviousFindings(scratch, 9).findings;
    expect(findings.length).toBe(1);
    const fid = ce.canonicalFindingId(findings[0]!);

    mkdirSync(join(scratch, "state"), { recursive: true });
    writeFileSync(
      join(scratch, "state", "counter-evidence-9.json"),
      JSON.stringify({
        iteration: 9,
        evidence: [
          {
            findingId: fid,
            claim: "dead duplicate",
            proofType: "duplicate-code-path",
            // A non-empty artifact is what makes a trusted proofType
            // mechanically falsifiable (grep target / dead-path proof).
            artifacts: ["sdk/python/x.py is never imported (grep miss)"],
          },
        ],
      }),
    );

    const stop = capture();
    const code = await runInternalPhase1Hooks(["override", "9"]);
    const out = stop();
    expect(code).toBe(0);
    expect(out.stdout).toContain("LIFTED");
    expect(existsSync(join(scratch, "state", "relevant-learnings.json"))).toBe(true);
  });

  it("override <iter> with trusted proofType but EMPTY artifacts does NOT lift (cross-route trust guard)", async () => {
    // Cross-route trust bug: the live Bun bash-hook override path
    // (loki internal phase1-hooks override) decided APPROVE_OVERRIDE purely on
    // TRUSTED.has(proofType), ignoring evidence.artifacts. A counter-evidence
    // file with a trusted proofType but empty/whitespace-only artifacts (an
    // unverifiable or forged claim) therefore lifted a BLOCK with zero real
    // verification. Mirrors the sibling guard in quality_gates.ts: a trusted
    // proofType yields APPROVE_OVERRIDE only when it carries >=1 non-empty
    // artifact. Empty -> REJECT_OVERRIDE, BLOCK stays (the safe direction).
    seedReview(11, ["[Critical] dup code at sdk/python/y.py:1"]);
    const ce = await import("../../src/runner/counter_evidence.ts");
    const fInjector = await import("../../src/runner/findings_injector.ts");
    const findings = fInjector.loadPreviousFindings(scratch, 11).findings;
    expect(findings.length).toBe(1);
    const fid = ce.canonicalFindingId(findings[0]!);

    mkdirSync(join(scratch, "state"), { recursive: true });
    writeFileSync(
      join(scratch, "state", "counter-evidence-11.json"),
      JSON.stringify({
        iteration: 11,
        evidence: [
          {
            findingId: fid,
            claim: "dead duplicate (no proof supplied)",
            proofType: "duplicate-code-path",
            // Whitespace-only artifacts are not real proof; must not lift.
            artifacts: ["", "   "],
          },
        ],
      }),
    );

    const stop = capture();
    const code = await runInternalPhase1Hooks(["override", "11"]);
    const out = stop();
    expect(code).toBe(0);
    // Pre-fix this printed LIFTED; post-fix the BLOCK is kept.
    expect(out.stdout).toContain("BLOCKED");
    expect(out.stdout).not.toContain("LIFTED");

    // Audit transcript records a REJECT for the (otherwise trusted) finding,
    // proving the rejection came from the artifact guard, not a missing match.
    const reviewsRoot = join(scratch, "quality", "reviews", "review-test-11");
    const override = JSON.parse(
      readFileSync(join(reviewsRoot, "override-11.json"), "utf-8"),
    ) as {
      approved_finding_ids: string[];
      rejected_finding_ids: string[];
      votes: Record<string, Array<{ verdict: string; reasoning: string }>>;
    };
    expect(override.approved_finding_ids).toEqual([]);
    expect(override.rejected_finding_ids).toContain(fid);
    expect(override.votes[fid]!.every((v) => v.verdict === "REJECT_OVERRIDE")).toBe(true);
    expect(override.votes[fid]![0]!.reasoning).toContain("no artifact supplied");
  });

  it("handoff <gate> <count> <iter> writes a handoff doc", async () => {
    const stop = capture();
    const code = await runInternalPhase1Hooks(["handoff", "code_review", "10", "5"]);
    const out = stop();
    expect(code).toBe(0);
    expect(out.stdout).toContain("wrote ");
    // Find the file under .loki/escalations/
    const escDir = join(scratch, "escalations");
    expect(existsSync(escDir)).toBe(true);
  });

  it("H2: one throwing appendFromGateFailure does not drop the other findings", async () => {
    // Bug-hunt H2 (batch-abort). Pre-fix, runReflect looped
    // `await appendFromGateFailure(...)` inside the single outer try, so the
    // first throw aborted the loop: earlier appends persisted but every
    // remaining finding was silently dropped AND the command exited 1.
    //
    // We seed 3 blocking findings and mock the learnings_writer so the SECOND
    // append throws. Post-fix: the 1st and 3rd still persist, the command
    // surfaces the failure count, and exit code stays 0 (not all failed).
    seedReview(20, [
      "[Critical] bug one at src/a.ts:1",
      "[High] bug two at src/b.ts:2",
      "[Critical] bug three at src/c.ts:3",
    ]);

    // Drive appendFromGateFailure into a throw on the 2nd finding (src/b.ts)
    // via the module-local test seam, and delegate to the REAL writer for the
    // others so we can assert they actually persisted. The seam is a plain
    // property (reset in afterEach), so it never leaks across files the way
    // Bun's global mock.module did.
    const realWriter = await import("../../src/runner/learnings_writer.ts");
    const persisted: string[] = [];
    __testAppendHook.fn = async (base, iter, finding, opts) => {
      if (finding.file === "src/b.ts") {
        throw new Error("synthetic append failure for b.ts");
      }
      persisted.push(finding.file ?? "");
      return realWriter.appendFromGateFailure(base, iter, finding, opts);
    };

    const stop = capture();
    const code = await runInternalPhase1Hooks(["reflect", "20"]);
    const out = stop();
    // The one throwing finding must NOT abort the loop or fail the command.
    expect(code).toBe(0);
    // The two good findings still persisted (the bug dropped #3).
    expect(persisted).toContain("src/a.ts");
    expect(persisted).toContain("src/c.ts");
    expect(persisted.length).toBe(2);
    // Failure is surfaced honestly, not swallowed silently.
    expect(out.stderr).toContain("learning append failed");
    expect(out.stdout).toContain("(1 failed)");
    // findings-20.json was still written for all 3 findings.
    expect(existsSync(join(scratch, "state", "findings-20.json"))).toBe(true);
  });

  it("H2: command exits 1 only when EVERY append fails", async () => {
    seedReview(21, ["[Critical] only bug at src/only.ts:1"]);
    __testAppendHook.fn = async () => {
      throw new Error("synthetic total failure");
    };
    const stop = capture();
    const code = await runInternalPhase1Hooks(["reflect", "21"]);
    const out = stop();
    expect(code).toBe(1);
    expect(out.stderr).toContain("all 1 learning appends failed");
    // findings file still persisted before the learnings step.
    expect(existsSync(join(scratch, "state", "findings-21.json"))).toBe(true);
  });

  it("unknown subcommand exits 2", async () => {
    const stop = capture();
    const code = await runInternalPhase1Hooks(["frobnicate"]);
    stop();
    expect(code).toBe(2);
  });

  it("missing iter on reflect exits 2", async () => {
    const stop = capture();
    const code = await runInternalPhase1Hooks(["reflect"]);
    stop();
    expect(code).toBe(2);
  });
});
