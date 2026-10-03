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
    if (init?.method === "POST" && u.endsWith("/verify")) { posts.push({ url: u, body: String(init.body) }); return new Response(JSON.stringify({ run: "r1", verdict: "VERIFIED", reasons: [], receipt_sha256: "ab", verified_at: "t" })); }
    if (init?.method === "POST") { posts.push({ url: u, body: String(init.body) }); return new Response(JSON.stringify({ path: "p", resume: "r" })); }
    if (u.endsWith("/v1/runs/s1/r1")) return new Response(JSON.stringify(d));
    if (u.includes("/events")) return new Response(JSON.stringify({ events: [{ seq: 1, ts: "2026-10-03T10:00:00Z", type: "stage.started", stage: "plan", data: { n: 1 } }] }));
    if (u.includes("/stream")) return new Response("nope", { status: 404 });
    if (u.endsWith("/artifact/diff.patch")) return new Response("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n+hello");
    if (u.endsWith("/artifact/receipt.md")) return new Response("# Receipt body");
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
}

beforeAll(() => { (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE = ""; });
afterEach(cleanup);
afterAll(() => { globalThis.fetch = realFetch; });

test("fixture run: title header, terminal panel, and every section; missing data reads unmeasured", async () => {
  serve(detail({ title: "Add tenant scoping middleware" }));
  render(<RunThread source="s1" run="r1" slot={<button>Stop</button>} />);
  await screen.findByTestId("run-thread");
  // header shows the issue title, never the run id
  expect(screen.getByTestId("run-title").textContent).toBe("Add tenant scoping middleware");
  expect(screen.getByTestId("run-thread").textContent).not.toContain("r1");
  expect(screen.getAllByTestId("run-stage")).toHaveLength(2);
  expect(screen.getByTestId("run-cost").textContent).toBe("unmeasured");
  expect(screen.getByTestId("run-header-slot").textContent).toBe("Stop");
  expect(screen.getByTestId("run-retry").textContent).toContain("Retry");
  expect(screen.getByTestId("run-progress").textContent).toBe("stage 2 / 2");
  expect(screen.getByTestId("run-pr").textContent).toContain("pull/7");
  // NOT PROVEN is a list with an owner tag per item; this item names none, so the owner is unmeasured
  expect(screen.getByTestId("run-not-proven").textContent).toContain("perf budget not checked");
  expect(screen.getByTestId("not-proven-owner").textContent).toBe("owner: unmeasured");
  // timeline row: time, stage, description, duration, model, cost
  await waitFor(() => expect(screen.getByTestId("run-timeline").textContent).toContain("plan"));
  expect(screen.getByTestId("tl-time").textContent).toBe("10:00:00");
  expect(screen.getByTestId("tl-desc").textContent).toContain("Named the files and tests in scope");
  expect(screen.getByTestId("tl-duration").textContent).toBe("running");
  expect(screen.getByTestId("tl-model").textContent).toBe("unmeasured");
  expect(screen.getByTestId("tl-cost").textContent).toBe("unmeasured");
  // changed files come from the diff
  await waitFor(() => expect(screen.getByTestId("run-diff").textContent).toContain("a.ts"));
  expect(screen.getByTestId("run-diff").textContent).toContain("+1");
  // the raw receipt text sits behind its own Show raw toggle
  expect(screen.queryByTestId("receipt-raw")).toBeNull();
  fireEvent.click(screen.getByTestId("receipt-raw-toggle"));
  await waitFor(() => expect(screen.getByTestId("receipt-raw").textContent).toContain("Receipt body"));
  expect(screen.queryByTestId("run-reply")).toBeNull();
});

test("Show raw toggle hides and reveals the raw JSON and event lines", async () => {
  serve(detail());
  render(<RunThread source="s1" run="r1" />);
  await screen.findByTestId("run-thread");
  expect(screen.queryByTestId("run-log")).toBeNull();
  expect(screen.getByTestId("run-raw-toggle").textContent).toBe("Show raw");
  fireEvent.click(screen.getByTestId("run-raw-toggle"));
  expect(screen.getByTestId("run-raw-json").textContent).toContain('"run_id": "r1"');
  await waitFor(() => expect(screen.getByTestId("run-log").textContent).toContain("stage.started plan"));
  fireEvent.click(screen.getByTestId("run-raw-toggle"));
  expect(screen.queryByTestId("run-log")).toBeNull();
});

test("Verify calls the verify route and shows the verdict; a run with no receipt cannot verify", async () => {
  serve(detail());
  render(<RunThread source="s1" run="r1" />);
  await screen.findByTestId("run-thread");
  fireEvent.click(screen.getByTestId("run-verify"));
  await waitFor(() => expect(posts.some((p) => p.url.endsWith("/v1/runs/s1/r1/verify"))).toBe(true));
  await waitFor(() => expect(screen.getByTestId("run-verify-result").textContent).toContain("VERIFIED"));
  cleanup();
  serve(detail({ receipt: null }));
  render(<RunThread source="s1" run="r1" />);
  await screen.findByTestId("run-thread");
  expect((screen.getByTestId("run-verify") as HTMLButtonElement).disabled).toBe(true);
});

test("running run shows a live indicator; a failed run states why there is no PR; an owner tag is read when the item names one", async () => {
  serve(detail({ verdict: null, status: "running", ended_at: null, pr_url: null, not_proven: ["[security] secret scan not run"] }));
  render(<RunThread source="s1" run="r1" />);
  await screen.findByTestId("run-live");
  expect(screen.getByTestId("run-pr").textContent).toContain("still in progress");
  expect(screen.getByTestId("not-proven-owner").textContent).toBe("owner: security");
  expect((screen.getByTestId("run-retry") as HTMLButtonElement).disabled).toBe(true);
  cleanup();
  serve(detail({ verdict: "FAILED", pr_url: null }));
  render(<RunThread source="s1" run="r1" />);
  await screen.findByTestId("run-thread");
  expect(screen.getByTestId("run-pr").textContent).toContain("ended FAILED");
  expect(screen.queryByTestId("run-live")).toBeNull();
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
  expect(costLabel({ cost_usd: null, partial_usd: 0, measured_sessions: 0, total_sessions: 2 })).toBe("unmeasured");
  expect(costLabel({ cost_usd: null, partial_usd: 0.2, measured_sessions: 1, total_sessions: 3 })).toContain("1 of 3 sessions measured");
  const got: number[] = [];
  const rest = parseFrames(`: hi\n\nid: 4\nevent: event\ndata: {"seq":4,"type":"x","ts":null,"stage":null,"data":null}\n\nid: 5\nev`, (e) => got.push(e.seq));
  expect(got).toEqual([4]);
  expect(rest).toBe("id: 5\nev");
  expect(page.id).toBe("run");
});
