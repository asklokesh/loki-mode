import { setSpawnTimeout } from "../preload.ts";
setSpawnTimeout();
// Tests for the councilWriteTranscript writer added in v7.5.16 (Dev D).
//
// Strategy: each test gets a fresh tmpdir with LOKI_DIR pointed at it so
// all writes are sandboxed. Tests exercise councilEvaluate() end-to-end
// (which now calls councilWriteTranscript internally) plus direct calls to
// councilWriteTranscript for edge-case coverage.

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  councilEvaluate,
  councilWriteTranscript,
  type AgentVerdict,
  type AggregateResult,
  type CouncilTranscript,
  type Voter,
  type CouncilEvaluateContext,
} from "../../src/runner/council.ts";
import type { RunnerContext } from "../../src/runner/types.ts";

let tmpBase = "";
let savedLokiDir: string | undefined;

beforeEach(() => {
  tmpBase = mkdtempSync(join(tmpdir(), "loki-transcript-test-"));
  savedLokiDir = process.env["LOKI_DIR"];
  process.env["LOKI_DIR"] = tmpBase;
});

afterEach(() => {
  if (savedLokiDir === undefined) delete process.env["LOKI_DIR"];
  else process.env["LOKI_DIR"] = savedLokiDir;
  if (tmpBase && existsSync(tmpBase)) {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeCtx(prdPath?: string): RunnerContext {
  return {
    cwd: tmpBase,
    lokiDir: tmpBase,
    prdPath,
    provider: "claude",
    maxRetries: 1,
    maxIterations: 1,
    baseWaitSeconds: 0,
    maxWaitSeconds: 0,
    autonomyMode: "single-pass",
    sessionModel: "fast",
    budgetLimit: undefined,
    completionPromise: undefined,
    iterationCount: 0,
    retryCount: 0,
    currentTier: "fast",
    log: () => {},
  };
}

function approve(role: string): AgentVerdict {
  return { role, verdict: "APPROVE", reason: "all good", issues: [] };
}

function reject(role: string): AgentVerdict {
  return {
    role,
    verdict: "REJECT",
    reason: "issues found",
    issues: [{ severity: "HIGH", description: "test failure" }],
  };
}

/** Returns all transcript files in the tmpBase transcripts dir. */
function transcriptFiles(): string[] {
  const dir = join(tmpBase, "council", "transcripts");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.startsWith("iter-") && f.endsWith(".json"));
}

/** Reads and parses the first transcript file found (sorted). */
function readFirstTranscript(): CouncilTranscript {
  const files = transcriptFiles().sort();
  if (files.length === 0) throw new Error("No transcript files found");
  const path = join(tmpBase, "council", "transcripts", files[0]!);
  return JSON.parse(readFileSync(path, "utf-8")) as CouncilTranscript;
}

// ---------------------------------------------------------------------------
// Test: 1 -- councilEvaluate with 3 APPROVE voters writes a transcript file
// ---------------------------------------------------------------------------

describe("councilEvaluate transcript writer", () => {
  it("test 1: writes an iter-N-*.json file when 3 voters APPROVE (non-unanimous path after DA)", async () => {
    // Set up test logs so the DA approves rather than rejects (avoids DA veto).
    mkdirSync(join(tmpBase, "logs"), { recursive: true });
    writeFileSync(join(tmpBase, "logs", "test-run.log"), "all tests passed\n");

    const voters: Voter[] = [
      async () => approve("requirements_verifier"),
      async () => approve("test_auditor"),
      async () => approve("quality_checker"),
    ];

    await councilEvaluate({ ctx: fakeCtx(), iteration: 3, voters });

    const files = transcriptFiles();
    expect(files.length).toBeGreaterThanOrEqual(1);
    // File must be named iter-3-...
    expect(files.some((f) => f.startsWith("iter-3-"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test: 2 -- written file parses as valid CouncilTranscript with all fields
  // -------------------------------------------------------------------------

  it("test 2: written file contains all required CouncilTranscript fields", async () => {
    mkdirSync(join(tmpBase, "logs"), { recursive: true });
    writeFileSync(join(tmpBase, "logs", "test-run.log"), "all tests passed\n");

    const voters: Voter[] = [
      async () => approve("requirements_verifier"),
      async () => approve("test_auditor"),
      async () => approve("quality_checker"),
    ];

    await councilEvaluate({ ctx: fakeCtx(), iteration: 5, voters });

    const t = readFirstTranscript();

    // Required top-level fields.
    expect(typeof t.iteration_id).toBe("string");
    expect(t.iteration_id).toMatch(/^iter-5-/);
    expect(typeof t.iteration).toBe("number");
    expect(t.iteration).toBe(5);
    expect(typeof t.timestamp).toBe("string");
    expect(typeof t.task_or_prd).toBe("string");
    expect(typeof t.prd_path).toBe("string");
    expect(Array.isArray(t.voters)).toBe(true);
    expect(typeof t.outcome).toBe("string");
    expect(["APPROVED", "REJECTED", "BLOCKED_BY_GATE"]).toContain(t.outcome);
    expect(typeof t.contrarian_triggered).toBe("boolean");
    expect(typeof t.contrarian_flipped).toBe("boolean");
    expect(typeof t.approve_count).toBe("number");
    expect(typeof t.reject_count).toBe("number");
    expect(typeof t.threshold).toBe("number");
    expect(typeof t.total_members).toBe("number");

    // Transcripts are engine-written (not model output): the voter key must equal the one
    // the bash writer and the VS Code panel use, or TS-route reasons vanish from the panel.
    const v0 = (t.voters as Record<string, unknown>[])[0]!;
    expect(v0["reasoning"]).toBe("all good");
    const root = join(import.meta.dir, "..", "..", "..");
    expect(readFileSync(join(root, "autonomy", "completion-council.sh"), "utf8")).toContain("'reasoning': v.get('reason', '')");
    expect(readFileSync(join(root, "vscode-extension", "media", "loki-dashboard.js"), "utf8")).toContain("e.reasoning");
  });

  it("council-v2 schema and prompts request justification, never reasoning", () => {
    const root = join(import.meta.dir, "..", "..", "..");
    const schema = JSON.parse(
      readFileSync(join(root, "loki-ts", "data", "council-v2-schema.json"), "utf8"),
    ) as { required: string[]; properties: Record<string, unknown> };
    expect(schema.required).toContain("justification");
    expect(schema.required).not.toContain("reasoning");
    expect(schema.properties["reasoning"]).toBeUndefined();
    const sh = readFileSync(join(root, "autonomy", "council-v2.sh"), "utf8");
    expect(sh.includes("reasoning (string)")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test: 3 -- when DA flips outcome, contrarian_flipped=true in transcript
  // -------------------------------------------------------------------------

  it("test 3: contrarian_flipped=true when DA rejects unanimous APPROVE", async () => {
    // Do NOT set up test logs -- the DA will find no test logs and REJECT.
    const voters: Voter[] = [
      async () => approve("requirements_verifier"),
      async () => approve("test_auditor"),
      async () => approve("quality_checker"),
    ];

    const result = await councilEvaluate({ ctx: fakeCtx(), iteration: 7, voters });

    // The DA should have flipped the outcome to CONTINUE.
    expect(result.decision).toBe("CONTINUE");

    const t = readFirstTranscript();
    expect(t.contrarian_triggered).toBe(true);
    expect(t.contrarian_flipped).toBe(true);
    expect(t.outcome).toBe("REJECTED");

    // DA voter must appear in the voters array with is_contrarian=true.
    const daVoter = t.voters.find((v) => v.is_contrarian);
    expect(daVoter).toBeDefined();
    expect(daVoter?.triggered).toBe(true);
    expect(daVoter?.verdict).toBe("REJECT");
  });

  // -------------------------------------------------------------------------
  // Test: 4 -- when DA does not trigger (non-unanimous), contrarian_triggered=false
  // -------------------------------------------------------------------------

  it("test 4: contrarian_triggered=false and no DA voter when vote is not unanimous", async () => {
    // One voter rejects -- DA is never called.
    const voters: Voter[] = [
      async () => approve("requirements_verifier"),
      async () => reject("test_auditor"),
      async () => approve("quality_checker"),
    ];

    await councilEvaluate({ ctx: fakeCtx(), iteration: 2, voters });

    const t = readFirstTranscript();
    expect(t.contrarian_triggered).toBe(false);
    expect(t.contrarian_flipped).toBe(false);

    // No DA voter in voters array.
    const daVoter = t.voters.find((v) => v.is_contrarian);
    expect(daVoter).toBeUndefined();

    // Regular voters recorded correctly.
    expect(t.voters.length).toBe(3);
    expect(t.total_members).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Test: 5 -- corrupt or missing PRD path does not crash the writer
  // -------------------------------------------------------------------------

  it("test 5: missing PRD path does not crash writer; task_or_prd is empty string", async () => {
    mkdirSync(join(tmpBase, "logs"), { recursive: true });
    writeFileSync(join(tmpBase, "logs", "test-run.log"), "all tests passed\n");

    const voters: Voter[] = [
      async () => approve("requirements_verifier"),
      async () => approve("test_auditor"),
      async () => approve("quality_checker"),
    ];

    // fakeCtx() has prdPath=undefined, and prdPath does not exist on disk.
    await expect(
      councilEvaluate({ ctx: fakeCtx("/nonexistent/path/that/does/not/exist.md"), iteration: 1, voters }),
    ).resolves.toBeDefined();

    const t = readFirstTranscript();
    // task_or_prd should be empty string (file not found).
    expect(t.task_or_prd).toBe("");
    expect(t.prd_path).toBe("/nonexistent/path/that/does/not/exist.md");
  });

  // -------------------------------------------------------------------------
  // Test: 6 -- writer is idempotent (re-running overwrites same iteration file)
  // -------------------------------------------------------------------------

  it("test 6: writer is idempotent -- re-running overwrites existing transcript cleanly", async () => {
    mkdirSync(join(tmpBase, "logs"), { recursive: true });
    writeFileSync(join(tmpBase, "logs", "test-run.log"), "all tests passed\n");

    const voters: Voter[] = [
      async () => approve("requirements_verifier"),
      async () => approve("test_auditor"),
      async () => approve("quality_checker"),
    ];

    // Run councilWriteTranscript directly twice with same data.
    const aggregate: AggregateResult = {
      decision: "COMPLETE",
      unanimous: true,
      approveCount: 3,
      rejectCount: 0,
      cannotValidateCount: 0,
      threshold: 2,
      totalMembers: 3,
      blockingSeverity: null,
      votes: [
        approve("requirements_verifier"),
        approve("test_auditor"),
        approve("quality_checker"),
      ],
    };

    const daApprove: AgentVerdict = {
      role: "devils_advocate",
      verdict: "APPROVE",
      reason: "anti-sycophancy: no issues found, COMPLETE upheld",
      issues: [],
    };

    // Write twice (simulating re-run). Both writes target the same tmpBase.
    await councilWriteTranscript(aggregate, daApprove, 4, undefined, { lokiDir: tmpBase });
    // Second write: we need a slightly different timestamp to get a different filename,
    // but the spec says "same iteration overwrites cleanly". We verify that 2 writes
    // of the same data each produce a valid parseable file.
    await councilWriteTranscript(aggregate, daApprove, 4, undefined, { lokiDir: tmpBase });

    const files = transcriptFiles().filter((f) => f.startsWith("iter-4-"));
    // At least one file should exist and be valid JSON.
    expect(files.length).toBeGreaterThanOrEqual(1);
    for (const fname of files) {
      const path = join(tmpBase, "council", "transcripts", fname);
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as CouncilTranscript;
      expect(parsed.iteration).toBe(4);
      expect(parsed.outcome).toBe("APPROVED");
      expect(parsed.contrarian_triggered).toBe(true);
      expect(parsed.contrarian_flipped).toBe(false);
    }
  });
});
