// v7.5.3 tests for `loki internal phase1-hooks` -- the hidden Bun
// subcommand bash autonomy/run.sh calls between iterations.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInternalPhase1Hooks } from "../../src/commands/internal_phase1.ts";

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

  it("override <iter> with trusted proofType lifts BLOCK", async () => {
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
            artifacts: [],
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
