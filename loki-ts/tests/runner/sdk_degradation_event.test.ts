// loki-ts/tests/runner/sdk_degradation_event.test.ts
//
// The SDK loop is already FAIL-CLOSED: there is no silent downgrade to the
// claude CLI, a thrown query() leaves exitCode 1, and a stream that never
// produced a terminal result is forced to 1 (`sawResult ? res.exitCode : 1`).
// So a degraded run cannot be mistaken for a successful one.
//
// What was missing is OBSERVABILITY. The failure existed only as prose inside
// the captured output, which means an operator running unattended had nothing
// to alert on and no way to tell "the SDK could not load" apart from "the model
// did poor work". This asserts the structured record now lands on the shared
// append-only event stream.
//
// Contract under test:
//   - type "capability_degraded", source "sdk_loop"
//   - payload carries fail_closed: true (the record states the safety property
//     rather than leaving a reader to assume it)
//   - lands in .loki/events.jsonl as one JSON object per line, matching the
//     envelope the SDK hook events already use
//   - honors LOKI_DIR (so a test or a container can redirect it)
//   - is BEST EFFORT: an unwritable target must never throw, because a
//     diagnostic that breaks the run it is describing is worse than no
//     diagnostic

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { emitSdkDegradationEvent } from "../../src/runner/providers.ts";

let work: string;
let prevLokiDir: string | undefined;

beforeEach(() => {
  work = mkdtempSync(resolve(tmpdir(), "loki-degrade-"));
  prevLokiDir = process.env["LOKI_DIR"];
  delete process.env["LOKI_DIR"];
});

afterEach(() => {
  if (prevLokiDir === undefined) delete process.env["LOKI_DIR"];
  else process.env["LOKI_DIR"] = prevLokiDir;
  rmSync(work, { recursive: true, force: true });
});

function readEvents(root: string): Array<Record<string, unknown>> {
  const f = resolve(root, "events.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("sdk capability-degradation event", () => {
  it("writes a structured record to .loki/events.jsonl", () => {
    emitSdkDegradationEvent(work, { reason: "Cannot find module '@anthropic-ai/claude-agent-sdk'" });
    const events = readEvents(resolve(work, ".loki"));
    expect(events.length).toBe(1);
    expect(events[0]!["type"]).toBe("capability_degraded");
    expect(events[0]!["source"]).toBe("sdk_loop");
    expect(typeof events[0]!["timestamp"]).toBe("string");
  });

  it("records the fail-closed property and the reason", () => {
    emitSdkDegradationEvent(work, {
      reason: "stream aborted",
      tier: "development",
      model: "claude-sonnet-5",
      iteration: "3",
    });
    const p = readEvents(resolve(work, ".loki"))[0]!["payload"] as Record<string, unknown>;
    // fail_closed is asserted explicitly: a consumer must be able to tell that
    // this degradation did NOT silently continue as a success.
    expect(p["fail_closed"]).toBe(true);
    expect(p["capability"]).toBe("sdk_query");
    expect(p["reason"]).toBe("stream aborted");
    expect(p["tier"]).toBe("development");
    expect(p["model"]).toBe("claude-sonnet-5");
    expect(p["iteration"]).toBe("3");
  });

  it("honors LOKI_DIR", () => {
    const alt = resolve(work, "custom-loki");
    process.env["LOKI_DIR"] = alt;
    emitSdkDegradationEvent(work, { reason: "x" });
    expect(readEvents(alt).length).toBe(1);
    expect(existsSync(resolve(work, ".loki", "events.jsonl"))).toBe(false);
  });

  it("appends rather than truncating (the stream is append-only)", () => {
    emitSdkDegradationEvent(work, { reason: "first" });
    emitSdkDegradationEvent(work, { reason: "second" });
    const events = readEvents(resolve(work, ".loki"));
    expect(events.length).toBe(2);
    expect((events[0]!["payload"] as Record<string, unknown>)["reason"]).toBe("first");
    expect((events[1]!["payload"] as Record<string, unknown>)["reason"]).toBe("second");
  });

  it("NEVER throws when the target is unwritable", () => {
    // A file where the .loki directory should be: mkdir and append both fail.
    // The run must continue regardless -- this is the load-bearing property.
    const blocked = resolve(work, "blocked");
    writeFileSync(blocked, "not a directory");
    process.env["LOKI_DIR"] = resolve(blocked, "nested");
    expect(() => emitSdkDegradationEvent(work, { reason: "y" })).not.toThrow();
  });
});
