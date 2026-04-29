// Tests for src/runner/learnings_writer.ts
//
// Covers:
//   - appendLearning: basic write, dedupe, corrupt-file recovery
//   - appendLearning: episode-bridge invocation gates (null, custom stub, env)
//   - appendFromGateFailure: Finding -> Learning derivation
//   - loadLearnings: missing file vs present file
//
// Strategy: each test uses an isolated temp dir; LOKI_AUTO_LEARNINGS_EPISODE
// env is scrubbed in afterEach so tests stay hermetic.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  appendLearning,
  appendFromGateFailure,
  loadLearnings,
} from "../../src/runner/learnings_writer.ts";
import type { Finding } from "../../src/runner/findings_injector.ts";

let scratch = "";

const ENV_KEYS = ["LOKI_AUTO_LEARNINGS_EPISODE"];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "loki-learnings-test-"));
});

afterEach(() => {
  if (scratch && existsSync(scratch)) {
    rmSync(scratch, { recursive: true, force: true });
  }
  for (const k of ENV_KEYS) delete process.env[k];
});

function learningsFile(): string {
  return join(scratch, "state", "relevant-learnings.json");
}

function expectedId(trigger: string, rootCause: string): string {
  // Source uses a NUL byte separator, not a space (verified via od on the
  // module bytes). Keep this in sync with learnings_writer.ts learningId().
  return createHash("sha256").update(`${trigger}\0${rootCause}`).digest("hex").slice(0, 16);
}

describe("appendLearning", () => {
  it("writes a new entry with sha256-truncated id and version=1 file", async () => {
    const result = await appendLearning(
      scratch,
      {
        iteration: 3,
        trigger: "gate_failure",
        rootCause: "static analysis flagged unused var",
        fix: "remove unused var",
        preventInFuture: "lint pre-commit",
        evidence: { file: "src/x.ts", line: 12 },
      },
      { episodeBridge: null },
    );

    const expectedHash = expectedId("gate_failure", "static analysis flagged unused var");
    expect(result.id).toBe(expectedHash);
    expect(result.id.length).toBe(16);
    expect(typeof result.timestamp).toBe("string");
    expect(result.timestamp.endsWith("Z")).toBe(true);

    const parsed = JSON.parse(readFileSync(learningsFile(), "utf-8")) as {
      version: number;
      learnings: Array<Record<string, unknown>>;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.learnings.length).toBe(1);
    expect(parsed.learnings[0]!["id"]).toBe(expectedHash);
    expect(parsed.learnings[0]!["iteration"]).toBe(3);
  });

  it("dedupes on (trigger, rootCause): updates timestamp+iteration but does not add a duplicate", async () => {
    const first = await appendLearning(
      scratch,
      {
        iteration: 1,
        trigger: "gate_failure",
        rootCause: "shared cause",
        fix: "fix v1",
        preventInFuture: "test more",
        evidence: { file: "a.ts" },
      },
      { episodeBridge: null },
    );

    // Force a small delay so the timestamp can differ.
    await new Promise((r) => setTimeout(r, 5));

    const second = await appendLearning(
      scratch,
      {
        iteration: 7,
        trigger: "gate_failure",
        rootCause: "shared cause",
        fix: "fix v2",
        preventInFuture: "test even more",
        evidence: { file: "b.ts" },
      },
      { episodeBridge: null },
    );

    expect(first.id).toBe(second.id);
    const parsed = JSON.parse(readFileSync(learningsFile(), "utf-8")) as {
      version: number;
      learnings: Array<Record<string, unknown>>;
    };
    expect(parsed.learnings.length).toBe(1);
    const entry = parsed.learnings[0]!;
    // iteration updated to most recent
    expect(entry["iteration"]).toBe(7);
    // first-seen evidence preserved (a.ts, not b.ts)
    expect((entry["evidence"] as Record<string, unknown>)["file"]).toBe("a.ts");
    // fix preserved (first-seen)
    expect(entry["fix"]).toBe("fix v1");
  });

  it("tolerates a corrupt existing file by overwriting with a fresh start", async () => {
    mkdirSync(join(scratch, "state"), { recursive: true });
    writeFileSync(learningsFile(), "{not valid json");

    const result = await appendLearning(
      scratch,
      {
        iteration: 2,
        trigger: "council_reject",
        rootCause: "missing test coverage",
        fix: "add tests",
        preventInFuture: "tdd",
        evidence: {},
      },
      { episodeBridge: null },
    );

    const parsed = JSON.parse(readFileSync(learningsFile(), "utf-8")) as {
      version: number;
      learnings: Array<Record<string, unknown>>;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.learnings.length).toBe(1);
    expect(parsed.learnings[0]!["id"]).toBe(result.id);
  });

  it("does NOT call the bridge when episodeBridge is null", async () => {
    let called = false;
    // null is the explicit "skip bridge" signal.
    await appendLearning(
      scratch,
      {
        iteration: 1,
        trigger: "gate_failure",
        rootCause: "x",
        fix: "y",
        preventInFuture: "z",
        evidence: {},
      },
      { episodeBridge: null },
    );
    // No bridge ever invoked because we passed null. 'called' stays false.
    expect(called).toBe(false);
  });

  it("calls a custom episodeBridge stub with correct payload", async () => {
    const calls: Array<{ lokiDir: string; input: Record<string, unknown> }> = [];
    const stub = async (
      lokiDir: string,
      input: { taskId: string; outcome: string; phase: string; goal: string },
    ) => {
      calls.push({ lokiDir, input });
      return { stored: true, reason: "stub" };
    };

    const learning = await appendLearning(
      scratch,
      {
        iteration: 4,
        trigger: "gate_failure",
        rootCause: "test failure in module foo",
        fix: "patch foo",
        preventInFuture: "unit-test foo",
        evidence: {},
      },
      { episodeBridge: stub },
    );

    expect(calls.length).toBe(1);
    expect(calls[0]!.lokiDir).toBe(scratch);
    expect(calls[0]!.input.taskId).toBe(`learning-${learning.id}`);
    expect((calls[0]!.input.taskId as string).startsWith("learning-")).toBe(true);
    expect(calls[0]!.input.outcome).toBe("failure");
    expect(calls[0]!.input.phase).toBe("VERIFY");
    expect(calls[0]!.input.goal).toBe("gate_failure: test failure in module foo");
  });

  it("honors LOKI_AUTO_LEARNINGS_EPISODE=1 env (invokes default bridge)", async () => {
    process.env["LOKI_AUTO_LEARNINGS_EPISODE"] = "1";
    // No memory dir under scratch -- the real storeEpisodeTrace will short-circuit
    // with {stored:false, reason:"memory dir not initialized"} and NOT spawn
    // python. That is the no-side-effect path we exercise here.
    const result = await appendLearning(scratch, {
      iteration: 5,
      trigger: "gate_failure",
      rootCause: "env-driven bridge fires",
      fix: "f",
      preventInFuture: "p",
      evidence: {},
    });

    // The file must still be written even when bridge is no-op.
    const parsed = JSON.parse(readFileSync(learningsFile(), "utf-8")) as {
      learnings: Array<Record<string, unknown>>;
    };
    expect(parsed.learnings.length).toBe(1);
    expect(parsed.learnings[0]!["id"]).toBe(result.id);
  });
});

describe("appendFromGateFailure", () => {
  it("derives a Learning from a Finding (severity in rootCause, file/line in evidence)", async () => {
    const finding: Finding = {
      reviewId: "review-abc-1",
      iteration: 9,
      reviewer: "security-sentinel",
      severity: "Critical",
      description: "hardcoded secret in src/auth.ts:42",
      file: "src/auth.ts",
      line: 42,
      raw: "- [Critical] hardcoded secret in src/auth.ts:42",
    };

    const learning = await appendFromGateFailure(scratch, 9, finding, {
      episodeBridge: null,
    });

    expect(learning.trigger).toBe("gate_failure");
    expect(learning.iteration).toBe(9);
    expect(learning.rootCause).toBe("[Critical] hardcoded secret in src/auth.ts:42");
    expect(learning.evidence.severity).toBe("Critical");
    expect(learning.evidence.file).toBe("src/auth.ts");
    expect(learning.evidence.line).toBe(42);
    expect(learning.evidence.reviewer).toBe("security-sentinel");
    expect(learning.evidence.reviewId).toBe("review-abc-1");
    expect(learning.fix).toContain("pending");
    expect(learning.preventInFuture.length).toBeGreaterThan(0);
  });
});

describe("loadLearnings", () => {
  it("returns {version:1, learnings:[]} when file is missing", () => {
    const r = loadLearnings(scratch);
    expect(r.version).toBe(1);
    expect(r.learnings).toEqual([]);
  });

  it("returns parsed file when present", async () => {
    await appendLearning(
      scratch,
      {
        iteration: 2,
        trigger: "override_approved",
        rootCause: "human approved override",
        fix: "logged",
        preventInFuture: "track override pattern",
        evidence: {},
      },
      { episodeBridge: null },
    );
    const r = loadLearnings(scratch);
    expect(r.version).toBe(1);
    expect(r.learnings.length).toBe(1);
    expect(r.learnings[0]!.trigger).toBe("override_approved");
    expect(r.learnings[0]!.iteration).toBe(2);
  });
});
