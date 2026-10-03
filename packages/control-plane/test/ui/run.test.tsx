// CPE-06: the run thread renders every section from fixtures, and a missing cost reads "not measured".
import "./dom";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
const { cleanup, render, screen, fireEvent, waitFor } = await import("@testing-library/react");
const { RunThread, costLabel, page } = await import("../../ui/src/pages/run");
const { parseFrames } = await import("../../ui/src/pages/run/stream");

const detail = (o: Record<string, unknown> = {}) => ({
  source_id: "s1", run_id: "r1", origin_repo: "o/r", issue_ref: "o/r#7", task_source: "issue", provider: "claude", model: "sonnet",
  started_at: "2026-10-03T10:00:00Z", ended_at: "2026-10-03T10:05:00Z", verdict: "PARTIAL", pr_url: "https://github.com/o/r/pull/7", pr_draft: false,
  cost_usd: null, partial_usd: 0, measured_sessions: 0, total_sessions: 2, input_tokens: null, output_tokens: null, wall_s: 300, last_seq: 3,
  last_event_at: null, tampered: false, conflict: false, status: "completed", files_touched: ["a.ts"],
  stages: [{ stage: "plan", started_at: "2026-10-03T10:00:00Z", ended_at: "2026-10-03T10:01:00Z", status: "completed" }, { stage: "implement", started_at: "2026-10-03T10:01:00Z", ended_at: null, status: "started" }],
  stages_completed: ["plan"], receipt: { sha256: "ab".repeat(32), signed: true, verdict: "PARTIAL", path: null }, not_proven: ["perf budget not checked"], ...o,
});

const posts: Array<{ url: string; body: string }> = [];
function serve(d: unknown) {
  posts.length = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === "POST") { posts.push({ url: u, body: String(init.body) }); return new Response(JSON.stringify({ path: "p", resume: "r" })); }
    if (u.endsWith("/v1/runs/s1/r1")) return new Response(JSON.stringify(d));
    if (u.includes("/events")) return new Response(JSON.stringify({ events: [{ seq: 1, ts: "t", type: "stage.started", stage: "plan", data: { n: 1 } }] }));
    if (u.includes("/stream")) return new Response("nope", { status: 404 });
    if (u.endsWith("/artifact/diff.patch")) return new Response("--- a/a.ts\n+++ b/a.ts\n+hello");
    if (u.endsWith("/artifact/receipt.md")) return new Response("# Receipt body");
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
}

beforeAll(() => { (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE = ""; });
afterEach(cleanup);
afterAll(() => { globalThis.fetch = realFetch; });

test("fixture run renders every section; missing cost reads not measured", async () => {
  serve(detail());
  render(<RunThread source="s1" run="r1" slot={<button>Stop</button>} />);
  await screen.findByTestId("run-thread");
  expect(screen.getAllByTestId("run-stage")).toHaveLength(2);
  expect(screen.getByTestId("run-cost").textContent).toBe("not measured");
  expect(screen.getByTestId("run-header-slot").textContent).toBe("Stop");
  expect(screen.getByTestId("run-not-proven").textContent).toContain("perf budget not checked");
  expect(screen.getByTestId("run-pr").textContent).toContain("pull/7");
  await waitFor(() => expect(screen.getByTestId("run-log").textContent).toContain("stage.started plan"));
  expect(screen.getAllByText("Show details")).toHaveLength(2);
  fireEvent.click(screen.getAllByText("Show details")[0]!);
  await waitFor(() => expect(screen.getByTestId("run-diff").textContent).toContain("+hello"));
  fireEvent.click(screen.getByText("Show details"));
  await waitFor(() => expect(screen.getByTestId("run-receipt").textContent).toContain("Receipt body"));
  expect(screen.queryByTestId("run-reply")).toBeNull();
  fireEvent.click(screen.getByText("Details"));
  expect(screen.getByTestId("run-details").textContent).toContain("0 of 2");
});

test("BLOCKED run shows a reply prompt that posts the answer", async () => {
  serve(detail({ verdict: null, status: "running", blocked_question: "Which branch?" }));
  render(<RunThread source="s1" run="r1" />);
  await screen.findByTestId("run-reply");
  fireEvent.input(screen.getByLabelText("Your reply"), { target: { value: "main" } });
  fireEvent.click(screen.getByText("Send reply"));
  await waitFor(() => expect(posts[0]?.url).toContain("/v1/runs/s1/r1/answer"));
  expect(JSON.parse(posts[0]!.body)).toEqual({ answer: "main" });
});

test("cost labels and SSE frame parsing are honest", () => {
  expect(costLabel({ cost_usd: 0.5, partial_usd: 0, measured_sessions: 1, total_sessions: 1 })).toBe("$0.50");
  expect(costLabel({ cost_usd: null, partial_usd: 0.2, measured_sessions: 1, total_sessions: 3 })).toContain("1 of 3 sessions measured");
  const got: number[] = [];
  const rest = parseFrames(`: hi\n\nid: 4\nevent: event\ndata: {"seq":4,"type":"x","ts":null,"stage":null,"data":null}\n\nid: 5\nev`, (e) => got.push(e.seq));
  expect(got).toEqual([4]);
  expect(rest).toBe("id: 5\nev");
  expect(page.id).toBe("run");
});
