// CP-NITS1: run page nits from the 10.10.2 smoke (Wall row text, folder name for a no-remote repo, receipt text from receipt.json).
import "./dom";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
const { cleanup, render, screen, fireEvent, waitFor } = await import("@testing-library/react");
const { RunThread } = await import("../../ui/src/pages/run");
const { describeLine } = await import("../../ui/src/pages/run/model");
const { buildTimeline } = await import("../../ui/src/pages/run/timeline");

const detail = (o: Record<string, unknown> = {}) => ({
  source_id: "my-folder", run_id: "r1", origin_repo: null, issue_ref: null, task_source: "task", provider: "claude", model: "sonnet",
  started_at: "2026-10-03T10:00:00Z", ended_at: "2026-10-03T10:05:00Z", verdict: "PARTIAL", pr_url: null, pr_draft: null,
  cost_usd: null, partial_usd: 0, measured_sessions: 0, total_sessions: 0, input_tokens: null, output_tokens: null, wall_s: 300, last_seq: 3,
  last_event_at: null, tampered: false, conflict: false, status: "completed", files_touched: [],
  stages: [], stages_completed: [], receipt: { sha256: "ab".repeat(32), signed: true, verdict: "PARTIAL", path: null }, not_proven: [], ...o,
});

function serve(d: unknown, artifacts: Record<string, string>) {
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    if (u.endsWith("/v1/runs/my-folder/r1")) return new Response(JSON.stringify(d));
    if (u.includes("/events")) return new Response(JSON.stringify({ events: [] }));
    for (const [name, body] of Object.entries(artifacts)) if (u.endsWith(`/artifact/${name}`)) return new Response(body);
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
}

beforeAll(() => { (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE = ""; });
afterEach(cleanup);
afterAll(() => { globalThis.fetch = realFetch; });

const wallLines = (type: string, data: Record<string, unknown>) => buildTimeline([
  { seq: 1, ts: "2026-10-03T10:00:00Z", type: "stage.started", stage: "wall", data: {} },
  { seq: 2, ts: "2026-10-03T10:00:05Z", type: type as "stage.completed", stage: "wall", data },
]);

test("Wall row describes the Wall: files written, or no checks written", () => {
  expect(describeLine(wallLines("stage.completed", { files: [{ path: "a", sha256: "x" }, { path: "b", sha256: "y" }] })[0]!)).toBe("Wrote acceptance checks (2 files)");
  expect(describeLine(wallLines("stage.completed", { files: [{ path: "a", sha256: "x" }] })[0]!)).toBe("Wrote acceptance checks (1 file)");
  expect(describeLine(wallLines("stage.skipped", { reason: "lean path" })[0]!)).toBe("Wall skipped: no checks written");
});

test("a local repo with no remote shows its folder name, not repo unmeasured", async () => {
  serve(detail(), {});
  render(<RunThread source="my-folder" run="r1" />);
  await screen.findByTestId("run-thread");
  const t = screen.getByTestId("run-thread").textContent ?? "";
  expect(t).toContain("my-folder");
  expect(t).not.toContain("repo unmeasured");
});

test("raw receipt text comes from receipt.json when receipt.md is absent", async () => {
  serve(detail(), { "receipt.json": '{"verdict":"PARTIAL","marker":"from-json"}' });
  render(<RunThread source="my-folder" run="r1" />);
  await screen.findByTestId("run-thread");
  fireEvent.click(await screen.findByTestId("receipt-raw-toggle"));
  await waitFor(() => expect(screen.getByTestId("receipt-raw").textContent).toContain("from-json"));
});
