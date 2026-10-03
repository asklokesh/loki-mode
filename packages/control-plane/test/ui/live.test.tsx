// CP-UI-LIVE: the live run view and the Overview render only what the ingested events carry; the rest reads "unmeasured".
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
GlobalRegistrator.register();
const { cleanup, render, screen } = await import("@testing-library/react");
const { LiveRun, Overview, Landing, buildStages } = await import("../../ui/src/Live");

const NOW = Date.parse("2026-10-03T12:00:00Z");
const row = (o: Record<string, unknown>) => ({
  source_id: "s1", run_id: "r1", origin_repo: null, issue_ref: null, task_source: "text", provider: "claude", model: "sonnet",
  started_at: "2026-10-03T10:00:00Z", ended_at: null, verdict: null, pr_url: null, pr_draft: null, cost_usd: null, partial_usd: 0,
  measured_sessions: 0, total_sessions: 0, input_tokens: null, output_tokens: null, wall_s: null, last_seq: 1, last_event_at: null,
  tampered: false, conflict: false, ...o,
});
const detail = (o: Record<string, unknown>) => ({ ...row(o), stages: [], stages_completed: [], receipt: null, not_proven: [], ...o });

function serve(map: Record<string, unknown>) {
  globalThis.fetch = (async (url: string) => {
    const body = map[String(url).split("?")[0]!];
    return body === undefined ? new Response("nope", { status: 404 }) : new Response(JSON.stringify(body));
  }) as unknown as typeof fetch;
}

beforeAll(() => { (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE = ""; });
afterEach(cleanup);
afterAll(async () => { await GlobalRegistrator.unregister(); globalThis.fetch = realFetch; });

test("live run: running stage timeline, diff, unpriced cost shown as unmeasured, no outcome yet", async () => {
  serve({ "/v1/runs/s1/r1": detail({
    status: "running", files_touched: ["a.ts", "b.ts"], current_stage: "implement",
    stages: [
      { stage: "intake", started_at: "2026-10-03T10:00:00Z", ended_at: "2026-10-03T10:00:05Z", status: "completed" },
      { stage: "plan", started_at: "2026-10-03T10:00:05Z", ended_at: "2026-10-03T10:01:05Z", status: "completed" },
      { stage: "implement", started_at: "2026-10-03T10:01:05Z", ended_at: null, status: "started" },
    ],
  }) });
  render(<LiveRun source="s1" run="r1" />);
  const stages = await screen.findAllByTestId("live-stage");
  expect(stages.map((s) => s.getAttribute("data-status"))).toEqual(["done", "done", "pending", "running", "pending", "pending", "pending"]);
  expect(stages[0]!.textContent).toContain("limit unmeasured");
  expect(screen.getByTestId("live-diff").textContent).toBe("2 files, +/- unmeasured");
  expect(screen.getByTestId("live-cost").textContent).toBe("unmeasured");
  expect(screen.getByTestId("live-model").textContent).toBe("sonnet");
  expect(screen.queryByTestId("live-outcome")).toBeNull();
});

test("live run: finished run shows outcome with PR and receipt links", async () => {
  serve({ "/v1/runs/s1/r1": detail({
    status: "completed", verdict: "VERIFIED", cost_usd: 0.1234, pr_url: "https://github.com/o/r/pull/7",
    receipt: { sha256: "ab", signed: true, verdict: "VERIFIED", path: "x" },
  }) });
  render(<LiveRun source="s1" run="r1" />);
  const out = await screen.findByTestId("live-outcome");
  expect(out.textContent).toContain("VERIFIED");
  expect(screen.getByTestId("live-pr").getAttribute("href")).toBe("https://github.com/o/r/pull/7");
  expect(screen.getByTestId("live-receipt").textContent).toContain("signed");
  expect(screen.getByTestId("live-cost").textContent).toBe("$0.1234");
});

test("buildStages: unknown stage names are appended, never dropped", () => {
  const v = buildStages([{ stage: "custom-step", started_at: null, ended_at: null, status: "completed" }], NOW);
  expect(v.length).toBe(8);
  expect(v[7]!.name).toBe("custom-step");
  expect(v[7]!.elapsed_s).toBeNull();
});

test("overview: counts, honest cost, unmeasured merged PRs, last 10", () => {
  const runs = [
    row({ run_id: "a", verdict: "VERIFIED", cost_usd: 1.5, pr_url: "https://x/pull/1", started_at: "2026-10-03T09:00:00Z" }),
    row({ run_id: "b", verdict: "PARTIAL", cost_usd: null, partial_usd: 0.5, started_at: "2026-10-01T09:00:00Z" }),
    row({ run_id: "c", verdict: "FAILED", cost_usd: 0.25, started_at: "2026-09-01T09:00:00Z" }),
    ...Array.from({ length: 12 }, (_, i) => row({ run_id: `n${i}`, verdict: "VERIFIED", cost_usd: 0, started_at: "2026-09-02T09:00:00Z" })),
  ] as never;
  render(<Overview runs={runs} now={NOW} />);
  const t = (id: string) => screen.getByTestId(id).textContent;
  expect(t("ov-today")).toBe("1");
  expect(t("ov-week")).toBe("2");
  expect(t("ov-verified")).toBe("13");
  expect(t("ov-partial")).toBe("1");
  expect(t("ov-failed")).toBe("1");
  expect(t("ov-cost")).toBe("$2.2500 measured, 1 run unmeasured");
  expect(t("ov-pr-opened")).toBe("1");
  expect(t("ov-pr-merged")).toBe("unmeasured");
  expect(screen.getAllByTestId("ov-run").length).toBe(10);
});

test("landing: live view when a run is active, overview otherwise", async () => {
  serve({
    "/v1/runs": { runs: [row({ status: "running" })], total: 1, next_cursor: null },
    "/v1/runs/s1/r1": detail({ status: "running" }),
  });
  render(<Landing fallback={<p>empty</p>} />);
  expect(await screen.findByTestId("live-run")).toBeTruthy();
  cleanup();
  serve({ "/v1/runs": { runs: [row({ verdict: "VERIFIED", status: "completed" })], total: 1, next_cursor: null } });
  render(<Landing fallback={<p>empty</p>} />);
  expect(await screen.findByTestId("overview")).toBeTruthy();
});
