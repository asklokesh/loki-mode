// CPE-18: every run lands in the right Work board column, and cards link to the run thread.
import "./dom";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { RunRow } from "../../ui/src/api";

const realFetch = globalThis.fetch;
const { cleanup, render, screen, within } = await import("@testing-library/react");
const { Board } = await import("../../ui/src/pages/board/Board");
const { columnOf } = await import("../../ui/src/pages/board/columns");
const { page } = await import("../../ui/src/pages/board");

const row = (o: Partial<RunRow>): RunRow => ({
  source_id: "s1", run_id: "r1", origin_repo: "o/r", issue_ref: null, task_source: "text", provider: "claude", model: "sonnet",
  started_at: "2026-10-03T10:00:00Z", ended_at: null, verdict: null, pr_url: null, pr_draft: null, cost_usd: null, partial_usd: 0,
  measured_sessions: 0, total_sessions: 0, input_tokens: null, output_tokens: null, wall_s: null, last_seq: 1, last_event_at: null,
  tampered: false, conflict: false, ...o,
});

const RUNS: RunRow[] = [
  row({ run_id: "queued", issue_ref: "o/r#1", started_at: null }),
  row({ run_id: "live", status: "running", current_stage: "implement" }),
  row({ run_id: "pr", pr_url: "https://github.com/o/r/pull/9", status: "running" }),
  row({ run_id: "ok", verdict: "VERIFIED", status: "completed", pr_url: "https://github.com/o/r/pull/8" }),
  row({ run_id: "part", verdict: "PARTIAL", status: "completed" }),
  row({ run_id: "bad", verdict: "FAILED", status: "completed" }),
];

beforeAll(() => {
  (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE = "";
  globalThis.fetch = (async (url: string) => {
    if (String(url).startsWith("/v1/stream")) return new Response("", { status: 404 });
    return new Response(JSON.stringify({ runs: RUNS, total: RUNS.length, next_cursor: null }));
  }) as unknown as typeof fetch;
});
afterEach(cleanup);
afterAll(() => { globalThis.fetch = realFetch; });

test("columnOf maps each status", () => {
  expect(RUNS.map((r) => [r.run_id, columnOf(r)])).toEqual([["queued", "issue"], ["live", "running"], ["pr", "pr"], ["ok", "verified"], ["part", "notproven"], ["bad", "notproven"]]);
});

test("each status lands in the right column and cards link to the run", async () => {
  render(<Board />);
  await screen.findByTestId("col-issue");
  const ids = (lane: string) => within(screen.getByTestId(lane)).queryAllByTestId("board-card").map((c) => c.getAttribute("data-run"));
  expect(ids("lane-issue")).toEqual(["queued"]);
  expect(ids("lane-running")).toEqual(["live"]);
  expect(ids("lane-pr")).toEqual(["pr"]);
  expect(ids("lane-verified")).toEqual(["ok"]);
  expect(ids("lane-notproven")).toEqual(["part", "bad"]);
  expect(within(screen.getByTestId("col-done")).getAllByTestId("board-card")).toHaveLength(3);
  expect(within(screen.getByTestId("lane-running")).getByTestId("board-card").getAttribute("href")).toBe("#/runs/s1/live");
});

test("page registration shape", () => {
  expect(page.id).toBe("work");
  expect(page.path).toBe("/work");
});
