// CPE-POLISH item 4: the run timeline is folded from events; unknown values stay null, never invented.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildScrubber, buildTimeline } from "../../ui/src/pages/run/timeline";

const evs = readFileSync(join(import.meta.dir, "../fixtures/runs/verified-pr/events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("verified-pr fixture: one line per stage with duration, model, cost and outcome, plus pr, receipt and verdict", () => {
  const tl = buildTimeline(evs);
  expect(tl.map((l) => l.label)).toEqual(["Run started", "intake", "wall", "plan", "implement", "verify", "commit", "seal", "Receipt sealed", "Pull request opened", "Run completed"]);
  const impl = tl.find((l) => l.label === "implement")!;
  expect(impl).toMatchObject({ outcome: "completed", duration_s: 0.089, model: "claude-sonnet-5", cost_usd: 0 });
  expect(tl.find((l) => l.label === "plan")!.model).toBe("sonnet");
  expect(tl.find((l) => l.label === "intake")!.cost_usd).toBe("no-session"); // f26deef50: intake ran no model session
  expect(tl.find((l) => l.label === "Run completed")!.outcome).toBe("VERIFIED");
  expect(tl.find((l) => l.label === "Receipt sealed")!.outcome).toBe("signed");
});

test("skipped stages show the recorded reason inline; no recorded reason says so", () => {
  const tl = buildTimeline([
    { seq: 0, ts: "2026-10-01T00:00:00Z", type: "stage.started", stage: "plan", data: {} },
    { seq: 1, ts: "2026-10-01T00:00:00Z", type: "stage.skipped", stage: "plan", data: { reason: "small task: implementer plans" } },
    { seq: 2, ts: "2026-10-01T00:00:00Z", type: "stage.started", stage: "wall", data: {} },
    { seq: 3, ts: "2026-10-01T00:00:00Z", type: "stage.skipped", stage: "wall", data: {} },
  ]);
  expect(tl[0]).toMatchObject({ outcome: "skipped", detail: "small task: implementer plans" });
  expect(tl[1]).toMatchObject({ outcome: "skipped", detail: "no reason recorded" });
});

test("a started stage with no completion reads running; a null-usd cost stays unmeasured", () => {
  const tl = buildTimeline([
    { seq: 0, ts: "2026-10-01T00:00:00Z", type: "stage.started", stage: "implement", data: {} },
    { seq: 1, ts: "2026-10-01T00:00:01Z", type: "cost", stage: "implement", data: { usd: null, model: "m" } },
  ]);
  expect(tl).toHaveLength(1);
  expect(tl[0]).toMatchObject({ outcome: "running", cost_usd: null, model: "m" });
});

// R100-082 (#422): the run replay scrubber has one position per stage; each shows what the journal recorded for that stage, never an invented value.
test("scrubber: the 7-stage fixture has 7 positions, each diff and test result equal to the journal for that stage", () => {
  const steps = buildScrubber(evs);
  expect(steps.map((s) => s.stage)).toEqual(["intake", "wall", "plan", "implement", "verify", "commit", "seal"]);
  const journal = evs.find((e: { type: string; stage: string }) => e.type === "stage.completed" && e.stage === "verify");
  const verify = steps.find((s) => s.stage === "verify")!;
  expect(verify.changed_files).toEqual(journal.data.changed_files);
  expect(verify.tests).toEqual({ pass: 1, fail: 0 });
  expect(steps.find((s) => s.stage === "implement")!.changed_files).toBeNull(); // the journal records no file list for implement
  expect(steps.find((s) => s.stage === "plan")!.tests).toBeNull();
  expect(steps.find((s) => s.stage === "intake")!.cost_usd).toBe("no-session");
  expect(steps.find((s) => s.stage === "implement")!.cost_usd).toBe(0);
});

test("scrubber: a 500-event run folds in at most 1 s", () => {
  const big: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 500; i++) big.push({ seq: i, ts: "2026-10-01T00:00:00Z", type: i % 2 ? "stage.completed" : "stage.started", stage: `s${Math.floor(i / 2) % 7}`, data: { changed_files: ["a.ts"], checks: [{ result: "pass" }] } });
  const t0 = performance.now();
  const steps = buildScrubber(big as never);
  expect(performance.now() - t0).toBeLessThan(1000);
  expect(steps.length).toBeGreaterThan(0);
});
