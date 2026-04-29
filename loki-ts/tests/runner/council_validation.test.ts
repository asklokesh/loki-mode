// Tests for v7.5.7 hardening of src/runner/council.ts:
//   A) heuristic voter: validates failed.json items, logs+ignores parse errors
//   B) devil's advocate: events.jsonl read wrapped in try/catch
//
// These tests intentionally write malformed inputs and assert no crash.

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_VOTERS,
  councilDevilsAdvocate,
  type CouncilEvaluateContext,
  type AgentVerdict,
} from "../../src/runner/council.ts";
import type { RunnerContext } from "../../src/runner/types.ts";

let tmpBase = "";
let savedLokiDir: string | undefined;

beforeEach(() => {
  tmpBase = mkdtempSync(join(tmpdir(), "loki-council-validation-"));
  savedLokiDir = process.env["LOKI_DIR"];
  process.env["LOKI_DIR"] = tmpBase;
});

afterEach(() => {
  if (savedLokiDir === undefined) delete process.env["LOKI_DIR"];
  else process.env["LOKI_DIR"] = savedLokiDir;
  if (tmpBase && existsSync(tmpBase)) {
    try {
      rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function makeCtx(logSink?: string[]): RunnerContext {
  return {
    cwd: tmpBase,
    lokiDir: tmpBase,
    prdPath: undefined,
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
    log: (line) => {
      if (logSink) logSink.push(line);
    },
  };
}

function makeCec(ctx: RunnerContext): CouncilEvaluateContext {
  return { ctx, iteration: 0 };
}

describe("heuristic voter -- failed.json validation (v7.5.7 fix A)", () => {
  it("ignores garbage non-object entries in failed.json", async () => {
    const queueDir = join(tmpBase, "queue");
    mkdirSync(queueDir, { recursive: true });
    // Mix garbage entries with no valid task/id objects
    const garbage = ["string-entry", 42, null, true, [], {}, { foo: "bar" }];
    writeFileSync(join(queueDir, "failed.json"), JSON.stringify(garbage));

    const ctx = makeCtx();
    const voter = DEFAULT_VOTERS[0];
    if (!voter) throw new Error("default voter missing");
    const verdict = await voter(makeCec(ctx));
    // Garbage-only file -> no valid count -> APPROVE
    expect(verdict.verdict).toBe("APPROVE");
    expect(verdict.issues.length).toBe(0);
  });

  it("counts only entries with task or id field", async () => {
    const queueDir = join(tmpBase, "queue");
    mkdirSync(queueDir, { recursive: true });
    const mixed = [
      "garbage",
      { task: "do-thing" }, // valid
      { id: "abc-123" }, // valid
      { foo: "bar" }, // invalid
      null,
      { task: "another" }, // valid
    ];
    writeFileSync(join(queueDir, "failed.json"), JSON.stringify(mixed));

    const ctx = makeCtx();
    const voter = DEFAULT_VOTERS[0];
    if (!voter) throw new Error("default voter missing");
    const verdict = await voter(makeCec(ctx));
    expect(verdict.verdict).toBe("REJECT");
    expect(verdict.issues.length).toBe(1);
    expect(verdict.issues[0]?.description).toBe("3 tasks in failed queue");
  });

  it("still rejects on a single valid task entry", async () => {
    const queueDir = join(tmpBase, "queue");
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(join(queueDir, "failed.json"), JSON.stringify([{ task: "x" }]));

    const ctx = makeCtx();
    const voter = DEFAULT_VOTERS[0];
    if (!voter) throw new Error("default voter missing");
    const verdict = await voter(makeCec(ctx));
    expect(verdict.verdict).toBe("REJECT");
    expect(verdict.issues[0]?.description).toBe("1 tasks in failed queue");
  });

  it("logs a warning via ctx.log on malformed JSON and does not crash", async () => {
    const queueDir = join(tmpBase, "queue");
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(join(queueDir, "failed.json"), "{not valid json");

    const sink: string[] = [];
    const ctx = makeCtx(sink);
    const voter = DEFAULT_VOTERS[0];
    if (!voter) throw new Error("default voter missing");
    const verdict = await voter(makeCec(ctx));
    expect(verdict.verdict).toBe("APPROVE");
    expect(sink.some((l) => l.includes("failed to parse"))).toBe(true);
  });

  it("approves when failed.json is missing", async () => {
    const ctx = makeCtx();
    const voter = DEFAULT_VOTERS[0];
    if (!voter) throw new Error("default voter missing");
    const verdict = await voter(makeCec(ctx));
    expect(verdict.verdict).toBe("APPROVE");
  });
});

describe("councilDevilsAdvocate -- events.jsonl resilience (v7.5.7 fix B)", () => {
  function unanimousApprove(): AgentVerdict[] {
    return [
      { role: "r1", verdict: "APPROVE", reason: "ok", issues: [] },
      { role: "r2", verdict: "APPROVE", reason: "ok", issues: [] },
      { role: "r3", verdict: "APPROVE", reason: "ok", issues: [] },
    ];
  }

  it("does not crash when events.jsonl is unreadable; treats as zero error events", async () => {
    // Make events.jsonl exist but fail on read by chmod 0 (POSIX permissions).
    const eventsFile = join(tmpBase, "events.jsonl");
    writeFileSync(eventsFile, "{\"level\":\"error\"}\n");
    chmodSync(eventsFile, 0o000);

    let result: AgentVerdict;
    try {
      result = await councilDevilsAdvocate(unanimousApprove(), { lokiDir: tmpBase });
    } finally {
      // restore so afterEach cleanup can rm the file
      try {
        chmodSync(eventsFile, 0o644);
      } catch {
        // ignore
      }
    }
    // No crash. Other checks (test logs missing) still run, so verdict should
    // be REJECT due to "no test result logs found" -- but importantly NOT
    // because of the events.jsonl read failure.
    expect(result.role).toBe("devils_advocate");
    // Verify no MEDIUM "recent error events" issue was produced.
    const hasErrorEvents = result.issues.some((i) =>
      i.description.includes("recent error events"),
    );
    expect(hasErrorEvents).toBe(false);
  });

  it("counts error events normally when events.jsonl is readable", async () => {
    const eventsFile = join(tmpBase, "events.jsonl");
    const lines = [
      '{"level":"info","msg":"x"}',
      '{"level":"error","msg":"oops"}',
      '{"level":"error","msg":"oops2"}',
    ].join("\n");
    writeFileSync(eventsFile, lines);

    const result = await councilDevilsAdvocate(unanimousApprove(), { lokiDir: tmpBase });
    const errIssue = result.issues.find((i) => i.description.includes("recent error events"));
    expect(errIssue).toBeDefined();
    expect(errIssue?.description).toBe("2 recent error events");
  });
});

describe("v7.5.8 hardening", () => {
  it("hasOwnProperty: prototype-pollution payload with __proto__.id is NOT counted (fix A)", async () => {
    const queueDir = join(tmpBase, "queue");
    mkdirSync(queueDir, { recursive: true });
    // Crafted JSON: an object whose own keys are only "__proto__" (treated as
    // a regular property by JSON.parse, not an actual prototype mutator).
    // Under the old `"id" in entry` check this would still NOT match because
    // JSON.parse creates a plain own property "__proto__", but objects with
    // *inherited* id via Object.prototype could leak. We assert that an
    // entry without own task/id is ignored regardless of prototype chain.
    const polluted: unknown[] = [
      JSON.parse('{"__proto__":{"id":"injected"}}'),
      JSON.parse('{"__proto__":{"task":"injected"}}'),
      { other: "field" },
    ];
    writeFileSync(join(queueDir, "failed.json"), JSON.stringify(polluted));

    // Defense-in-depth: also pollute the actual Object.prototype to prove
    // hasOwnProperty.call rejects inherited keys. Restore in finally.
    const proto = Object.prototype as unknown as Record<string, unknown>;
    const hadId = Object.prototype.hasOwnProperty.call(proto, "id");
    proto["id"] = "polluted-id";
    try {
      const ctx = makeCtx();
      const voter = DEFAULT_VOTERS[0];
      if (!voter) throw new Error("default voter missing");
      const verdict = await voter(makeCec(ctx));
      // None of the entries have own "task" or "id" -> APPROVE, no issues.
      expect(verdict.verdict).toBe("APPROVE");
      expect(verdict.issues.length).toBe(0);
    } finally {
      if (!hadId) delete proto["id"];
    }
  });

  it("test log >5MB is skipped, not read (fix B)", async () => {
    const logsDir = join(tmpBase, "logs");
    mkdirSync(logsDir, { recursive: true });
    // Synthesize a 6MB log file. Fill with non-pass content so that, if the
    // size guard regresses and the file IS read, hasPassMarker stays false
    // anyway -- but the trailing 30 lines DO contain "passed" to make the
    // assertion sharp: with the guard, file is skipped -> hasPassMarker
    // stays false -> HIGH issue "test logs lack a pass marker" is absent
    // (because hasTestLog is true but the file was skipped before tail
    // inspection, so we get the "no test result logs found" path? No --
    // hasTestLog is set BEFORE the size check. So we expect HIGH
    // "test logs lack a pass marker").
    //
    // Cleaner assertion: write a 6MB file whose tail says "all tests passed".
    // Without guard -> hasPassMarker=true -> no test-log issue.
    // With guard -> file skipped -> hasPassMarker=false -> HIGH issue
    // "test logs lack a pass marker" present.
    const bigFile = join(logsDir, "big-test.log");
    const sixMB = 6 * 1024 * 1024;
    const filler = "x".repeat(1024); // 1KB of filler
    const lines: string[] = [];
    let written = 0;
    while (written < sixMB - 2048) {
      lines.push(filler);
      written += filler.length + 1;
    }
    lines.push("all tests passed");
    writeFileSync(bigFile, lines.join("\n"));

    // Capture console.warn to assert the skip warning fires.
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };

    let result: AgentVerdict;
    try {
      result = await councilDevilsAdvocate(
        [
          { role: "r1", verdict: "APPROVE", reason: "ok", issues: [] },
          { role: "r2", verdict: "APPROVE", reason: "ok", issues: [] },
          { role: "r3", verdict: "APPROVE", reason: "ok", issues: [] },
        ],
        { lokiDir: tmpBase },
      );
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings.some((w) => w.includes("[council] skipping large log"))).toBe(true);
    // File was skipped, so pass marker was never observed -> HIGH issue.
    const lacksPass = result.issues.some((i) => i.description === "test logs lack a pass marker");
    expect(lacksPass).toBe(true);
  });
});
