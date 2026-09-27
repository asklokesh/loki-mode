// E-01: event log contract (docs/v10/ENGINE.md "Event log").
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventLog,
  fold,
  makeEvent,
  readEvents,
  tail,
  validateEnvelope,
} from "../../src/engine10/events.ts";
import type { EventEnvelope } from "../../src/engine10/types.ts";
import { pushArgv, STAGE_BUDGETS } from "../../src/engine10/types.ts";

const RUN = "e10-20260927T220103Z-ab12";
let dir = "";
let path = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "e10-events-"));
  path = join(dir, "runs", RUN, "events.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("validateEnvelope", () => {
  const good = { v: 1, seq: 0, ts: "2026-09-27T22:04:11.482Z", run: RUN, type: "stage.completed", stage: "implement", data: {} };

  it("accepts the ENGINE.md example envelope", () => {
    expect(validateEnvelope(good)).toBeNull();
  });

  it("requires every key; stage may be null but not missing", () => {
    for (const k of Object.keys(good)) {
      const bad: Record<string, unknown> = { ...good };
      delete bad[k];
      expect(validateEnvelope(bad)).not.toBeNull();
    }
    expect(validateEnvelope({ ...good, stage: null })).toBeNull();
  });

  it("rejects wrong shapes", () => {
    expect(validateEnvelope(null)).not.toBeNull();
    expect(validateEnvelope([])).not.toBeNull();
    expect(validateEnvelope({ ...good, v: 2 })).not.toBeNull();
    expect(validateEnvelope({ ...good, seq: -1 })).not.toBeNull();
    expect(validateEnvelope({ ...good, seq: 1.5 })).not.toBeNull();
    expect(validateEnvelope({ ...good, ts: "yesterday" })).not.toBeNull();
    expect(validateEnvelope({ ...good, run: "" })).not.toBeNull();
    expect(validateEnvelope({ ...good, type: "" })).not.toBeNull();
    expect(validateEnvelope({ ...good, stage: 3 })).not.toBeNull();
    expect(validateEnvelope({ ...good, data: [] })).not.toBeNull();
    expect(validateEnvelope({ ...good, data: null })).not.toBeNull();
  });

  it("tolerates an unknown event type (forward compatible)", () => {
    expect(validateEnvelope({ ...good, type: "future.thing" })).toBeNull();
  });
});

describe("EventLog.append + readEvents", () => {
  it("assigns monotonic seq from 0, creates the dir, round-trips", () => {
    const log = new EventLog(path, RUN);
    const a = log.append("run.started", null, { repo: "/r" });
    const b = log.append("stage.started", "intake", { target_s: 15, limit_s: 60 });
    expect([a.seq, b.seq]).toEqual([0, 1]);
    const back = readEvents(path);
    expect(back).toEqual([a, b]);
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
  });

  it("resumes seq after an existing log (reopen)", () => {
    new EventLog(path, RUN).append("run.started", null, {});
    const e = new EventLog(path, RUN).append("stage.started", "intake", {});
    expect(e.seq).toBe(1);
  });

  it("appends, never truncates, when another handle wrote in between", () => {
    const log = new EventLog(path, RUN);
    log.append("run.started", null, {});
    appendFileSync(path, JSON.stringify(makeEvent(RUN, 1, "heartbeat", "intake", {})) + "\n");
    log.append("stage.started", "intake", {});
    expect(readEvents(path).map((e) => e.type)).toEqual(["run.started", "heartbeat", "stage.started"]);
  });

  it("refuses to write an invalid envelope", () => {
    const log = new EventLog(path, RUN);
    expect(() => log.append("", null, {})).toThrow();
    expect(() => new EventLog(path, "")).toThrow();
  });

  it("ignores a torn (truncated) last line", () => {
    const log = new EventLog(path, RUN);
    log.append("run.started", null, {});
    log.append("stage.started", "intake", {});
    appendFileSync(path, '{"v":1,"seq":2,"ts":"2026-09-27T22:0');
    expect(readEvents(path).map((e) => e.seq)).toEqual([0, 1]);
  });

  it("reopening after a torn last line does not glue the next event onto it", () => {
    new EventLog(path, RUN).append("run.started", null, {});
    appendFileSync(path, '{"v":1,"seq":1,"ts');
    const e = new EventLog(path, RUN).append("stage.started", "intake", {});
    expect(e.seq).toBe(1);
    expect(readEvents(path).map((x) => x.type)).toEqual(["run.started", "stage.started"]);
  });

  it("a torn line followed by a newline-terminated valid line is skipped too", () => {
    const log = new EventLog(path, RUN);
    log.append("run.started", null, {});
    appendFileSync(path, "{garbage\n");
    appendFileSync(path, JSON.stringify(makeEvent(RUN, 2, "heartbeat", "intake", {})) + "\n");
    expect(readEvents(path).map((e) => e.seq)).toEqual([0, 2]);
  });

  it("missing file reads as empty", () => {
    expect(readEvents(join(dir, "nope.jsonl"))).toEqual([]);
  });
});

describe("fold", () => {
  function ev(seq: number, type: string, stage: EventEnvelope["stage"], data: Record<string, unknown> = {}): EventEnvelope {
    return makeEvent(RUN, seq, type, stage, data);
  }

  it("keeps the last event per stage and a run summary", () => {
    const events = [
      ev(0, "run.started", null, { provider: "claude", model: "sonnet", deep: false, cap_s: 900 }),
      ev(1, "stage.started", "intake"),
      ev(2, "stage.completed", "intake", { tree: "t" }),
      ev(3, "stage.started", "implement"),
      ev(4, "heartbeat", "implement", { elapsed_s: 60 }),
      ev(5, "cost", "implement", { usd: 0.5, input_tokens: 10, output_tokens: 2 }),
      ev(6, "stage.failed", "implement", { reason: "limit", killed: true }),
      ev(7, "some.future.event", "implement"),
    ];
    const f = fold(events);
    expect(f.stages.intake?.type).toBe("stage.completed");
    expect(f.stages.implement?.seq).toBe(7);
    expect(f.completed).toEqual(["intake"]);
    expect(f.run.started?.seq).toBe(0);
    expect(f.run.completed).toBeNull();
    expect(f.run.verdict).toBeNull();
    expect(f.lastSeq).toBe(7);
    expect(f.cost).toEqual({ usd: 0.5, inputTokens: 10, outputTokens: 2 });
  });

  it("cost usd stays null if any cost event is unmeasured (never 0)", () => {
    const f = fold([
      ev(0, "cost", "plan", { usd: 0.1, input_tokens: 1, output_tokens: 1 }),
      ev(1, "cost", "implement", { usd: null, input_tokens: 5, output_tokens: 5 }),
    ]);
    expect(f.cost.usd).toBeNull();
    expect(f.cost.inputTokens).toBe(6);
    expect(fold([]).cost.usd).toBeNull();
  });

  it("reads verdict from run.completed and tracks tamper and escalation", () => {
    const f = fold([
      ev(0, "run.started", null),
      ev(1, "escalated", null, { reason: "loki:deep label" }),
      ev(2, "tamper.detected", null, { expected_sha256: "a", actual_sha256: "b" }),
      ev(3, "run.completed", null, { verdict: "PARTIAL", not_proven: ["x"] }),
    ]);
    expect(f.run.verdict).toBe("PARTIAL");
    expect(f.run.tampered).toBe(true);
    expect(f.run.escalated?.seq).toBe(1);
    expect(f.run.completed?.seq).toBe(3);
  });
});

describe("tail", () => {
  it("replays existing events then streams appended ones; torn lines wait", async () => {
    const log = new EventLog(path, RUN);
    log.append("run.started", null, {});
    const seen: number[] = [];
    const stop = tail(path, (e) => seen.push(e.seq), { intervalMs: 10 });
    try {
      expect(seen).toEqual([0]);
      log.append("stage.started", "intake", {});
      const partial = JSON.stringify(makeEvent(RUN, 2, "heartbeat", "intake", {}));
      appendFileSync(path, partial.slice(0, 10));
      await Bun.sleep(60);
      expect(seen).toEqual([0, 1]);
      appendFileSync(path, partial.slice(10) + "\n");
      await Bun.sleep(60);
      expect(seen).toEqual([0, 1, 2]);
    } finally {
      stop();
    }
  });

  it("works when the file does not exist yet", async () => {
    const seen: number[] = [];
    const stop = tail(path, (e) => seen.push(e.seq), { intervalMs: 10 });
    try {
      new EventLog(path, RUN).append("run.started", null, {});
      await Bun.sleep(60);
      expect(seen).toEqual([0]);
    } finally {
      stop();
    }
  });
});

describe("types contract", () => {
  it("stage budgets match ENGINE.md", () => {
    expect(STAGE_BUDGETS.intake).toEqual({ targetS: 15, limitS: 60 });
    expect(STAGE_BUDGETS.implement).toEqual({ targetS: 180, limitS: 480 });
    expect(STAGE_BUDGETS.fix).toEqual({ targetS: 90, limitS: 180 });
    expect(STAGE_BUDGETS.deep.limitS).toBe(1800);
  });

  it("push argv matches the engine10-push.sh contract", () => {
    expect(pushArgv({ cmd: "pr", repoDir: "/r", branch: "loki/x", title: "t", bodyFile: "/b", draft: true }))
      .toEqual(["pr", "/r", "loki/x", "t", "/b", "1"]);
    expect(pushArgv({ cmd: "status", sha: "abc", state: "pending", description: "d" }))
      .toEqual(["status", "abc", "pending", "d"]);
    expect(pushArgv({ cmd: "comment", runId: RUN, prUrl: "u", file: "f" })).toEqual(["comment", RUN, "u", "f"]);
  });
});
