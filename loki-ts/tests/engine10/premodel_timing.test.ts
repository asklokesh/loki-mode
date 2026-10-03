// D61 slice 1: pre-model stage timer (argv to first provider byte), recorded in run.completed, shown only under LOKI_SPEED=1.
import { describe, expect, test } from "bun:test";
import { formatPreModelLine, preModelTiming } from "../../src/engine10/output.ts";
import { renderMainOutput } from "../../src/engine10/supervisor.ts";
import type { EventEnvelope } from "../../src/engine10/types.ts";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
let seq = 0;
const ev = (offMs: number, type: string, stage: string | null, data: Record<string, unknown> = {}): EventEnvelope =>
  ({ seq: seq++, ts: new Date(T0 + offMs).toISOString(), type, stage, data, run_id: "r" } as unknown as EventEnvelope);
const journal = (): EventEnvelope[] => [
  ev(100, "run.started", null),
  ev(100, "stage.started", "intake"), ev(400, "stage.completed", "intake"),
  ev(450, "stage.started", "sizing"), ev(600, "stage.completed", "sizing"),
  ev(600, "stage.started", "implement"), ev(900, "session.started", "implement", { session_id: "s" }),
  ev(5000, "stage.completed", "implement"),
];
const sumOf = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

describe("preModelTiming", () => {
  test("fields exist per stage and sum within 50ms of the span", () => {
    const t = preModelTiming(journal(), T0)!;
    expect(t.span_s).toBeCloseTo(0.9, 3);
    for (const k of ["setup", "intake", "sizing", "implement"]) expect(typeof t.stages[k]).toBe("number");
    expect(t.stages.intake).toBeCloseTo(0.3, 3);
    expect(Math.abs(sumOf(t.stages) - t.span_s)).toBeLessThan(0.05);
  });
  test("null when no provider session started", () => {
    expect(preModelTiming(journal().filter((e) => e.type !== "session.started"), T0)).toBeNull();
  });
});

describe("LOKI_SPEED gate", () => {
  const summary = { pr: null, verdict: "VERIFIED", notProven: [], flaky: [], cost: { usd: 1, provider: "claude", tokens: 1 }, wallS: 5, stages: [] } as never;
  const withPm = [...journal(), ev(5100, "run.completed", null, { pre_model: preModelTiming(journal(), T0) })];
  test("flag off: output identical to a run without the field", () => {
    delete process.env.LOKI_SPEED;
    expect(renderMainOutput(withPm, summary)).toBe(renderMainOutput(journal(), summary));
    expect(formatPreModelLine(preModelTiming(journal(), T0), {})).toBe("");
  });
  test("flag on: pre-model line printed", () => {
    process.env.LOKI_SPEED = "1";
    try { expect(renderMainOutput(withPm, summary)).toMatch(/^pre-model 0\.9s \(.*intake 0\.3s/); } finally { delete process.env.LOKI_SPEED; }
  });
});
