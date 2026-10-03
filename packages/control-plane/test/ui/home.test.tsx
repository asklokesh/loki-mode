// CPE-12: Home renders the tiles, recent runs and BLOCKED inbox from the stats, runs and notifications APIs; unmeasured values read "not measured".
import "./dom";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
const { cleanup, render, screen } = await import("@testing-library/react");
const { Home, HomeView, costTile } = await import("../../ui/src/pages/home/Home");
const { page } = await import("../../ui/src/pages/home/index");

const NOW = Date.parse("2026-10-03T12:00:00Z");
const stats = (o: Record<string, unknown>) => ({
  since: null, runs_total: 0, runs_finished: 0, runs_running: 0, by_verdict: {}, blocked_waiting: 0, verified_rate: null,
  cost: { measured_usd: null, measured_runs: 0, partial_usd: null, partial_runs: 0, label: "not measured" }, receipts: { total: 0, signed: 0 }, ...o,
});
const run = (o: Record<string, unknown>) => ({
  source_id: "s1", run_id: "r1", origin_repo: null, issue_ref: null, model: "sonnet", verdict: null, cost_usd: null, partial_usd: 0, ...o,
});

function serve(opts: { today: unknown; week: unknown; runs: unknown[]; blocked: unknown[] }) {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    const u = new URL(String(url), "http://x");
    if (u.pathname === "/v1/stats") return new Response(JSON.stringify(Date.parse(u.searchParams.get("since")!) > NOW - 2 * 86_400_000 ? opts.today : opts.week));
    if (u.pathname === "/v1/runs") return new Response(JSON.stringify({ runs: opts.runs, total: opts.runs.length, next_cursor: null }));
    if (u.pathname === "/v1/notifications") return new Response(JSON.stringify({ notifications: opts.blocked, total: opts.blocked.length, next_cursor: null }));
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
  return urls;
}

beforeAll(() => { (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE = ""; });
afterEach(cleanup);
afterAll(() => { globalThis.fetch = realFetch; });

test("page export carries the registry fields", () => {
  expect(page.id).toBe("home");
  expect(typeof page.component).toBe("function");
});

test("tiles show the stats numbers, blocked inbox and recent runs link to their run", async () => {
  const urls = serve({
    today: stats({ runs_total: 3, runs_running: 1 }),
    week: stats({ runs_total: 8, runs_finished: 8, by_verdict: { VERIFIED: 4 }, verified_rate: 0.5, breakdown: { verified: 4, failed: 4, already_satisfied: 0, other: 0 }, cost: { measured_usd: 1.5, measured_runs: 7, partial_usd: 0.25, partial_runs: 1, label: "partial" } }),
    runs: [run({ run_id: "a", verdict: "VERIFIED", cost_usd: 0.1234, origin_repo: "o/r" }), run({ run_id: "b", verdict: null }), run({ run_id: "c", verdict: "FAILED", partial_usd: 0.5 })],
    blocked: [{ id: "blocked:s1:z", kind: "blocked", ts: "t", source_id: "s1", run_id: "z", title: "Blocked, waiting for your answer: o/r", link: "/runs/s1/z" }],
  });
  render(<Home now={NOW} />);
  await screen.findByTestId("home");
  expect(urls.some((u) => u.startsWith("/v1/notifications?kind=blocked"))).toBe(true);
  expect(screen.getByTestId("kpi-today").textContent).toContain("3");
  expect(screen.getByTestId("kpi-today").textContent).toContain("1 running");
  expect(screen.getByTestId("kpi-verified").textContent).toContain("50%");
  expect(screen.getByTestId("kpi-verified").textContent).toContain("4 verified, 4 failed, 0 already satisfied, 0 other");
  expect(screen.getByTestId("kpi-cost").textContent).toContain("$1.75+");
  expect(screen.getByTestId("kpi-cost").textContent).toContain("partial, 1 run unpriced");
  expect(screen.getByTestId("kpi-blocked").textContent).toContain("1");
  expect(screen.getByTestId("blocked-item").getAttribute("href")).toBe("/r/s1/z");
  const links = screen.getAllByTestId("recent-run");
  expect(links.map((l) => l.getAttribute("href"))).toEqual(["/r/s1/a", "/r/s1/b", "/r/s1/c"]);
  const text = screen.getByTestId("recent-runs").textContent!;
  expect(text).toContain("$0.12");
  expect(text).toContain("at least $0.50");
  expect(text).toContain("not measured");
});

test("nothing measured reads not measured, never a zero", () => {
  expect(costTile(stats({}).cost as never)).toEqual({ value: "not measured", trend: "no priced runs" });
  render(<HomeView data={{ today: stats({ runs_total: 1 }) as never, week: stats({ runs_total: 1, runs_running: 1 }) as never, runs: [run({}) as never], blocked: [], blockedTotal: 0 }} />);
  expect(screen.getByTestId("kpi-verified").textContent).toContain("--");
  expect(screen.getByTestId("kpi-cost").textContent).toContain("not measured");
  expect(screen.getByTestId("blocked-empty").textContent).toContain("Nothing is waiting");
});

test("fully measured cost has no plus sign; an empty store shows the empty state", async () => {
  expect(costTile({ measured_usd: 2, measured_runs: 3, partial_usd: null, partial_runs: 0, label: "measured" })).toEqual({ value: "$2.00", trend: "measured" });
  serve({ today: stats({}), week: stats({}), runs: [], blocked: [] });
  render(<Home now={NOW} />);
  expect((await screen.findByText("No runs yet")).textContent).toBe("No runs yet");
});

test("no verification key: a zero rate reads not measured with the unchecked count, never a warning 0%", () => {
  const week = stats({ runs_total: 3, runs_finished: 3, by_verdict: { "VERIFIED (signature not checked)": 3 }, verified_rate: 0, verified_unchecked: 3, keys_configured: false });
  render(<HomeView data={{ today: stats({}) as never, week: week as never, runs: [], blocked: [], blockedTotal: 0 }} />);
  const t = screen.getByTestId("kpi-verified").textContent!;
  expect(t).toContain("not measured: no verification key");
  expect(t).toContain("3 signature not checked");
  expect(t).not.toContain("0%");
});

test("with a key configured the rate shows as a percentage", () => {
  const week = stats({ runs_total: 2, runs_finished: 2, by_verdict: { VERIFIED: 1 }, verified_rate: 0.5, verified_unchecked: 0, keys_configured: true });
  render(<HomeView data={{ today: stats({}) as never, week: week as never, runs: [], blocked: [], blockedTotal: 0 }} />);
  expect(screen.getByTestId("kpi-verified").textContent).toContain("50%");
});

test("ALREADY_SATISFIED is not counted as not verified: the rate is over verifiable outcomes and the breakdown is shown", () => {
  const week = stats({ runs_total: 4, runs_finished: 4, verified_rate: 0.5, breakdown: { verified: 1, failed: 1, already_satisfied: 2, other: 0 }, keys_configured: true });
  render(<HomeView data={{ today: stats({}) as never, week: week as never, runs: [], blocked: [], blockedTotal: 0 }} />);
  const t = screen.getByTestId("kpi-verified").textContent!;
  expect(t).toContain("50%");
  expect(t).toContain("1 verified, 1 failed, 2 already satisfied, 0 other");
});

test("zero verifiable outcomes shows -- not 0%, with the breakdown", () => {
  const week = stats({ runs_total: 4, runs_finished: 4, verified_rate: null, breakdown: { verified: 0, failed: 0, already_satisfied: 4, other: 0 } });
  render(<HomeView data={{ today: stats({}) as never, week: week as never, runs: [], blocked: [], blockedTotal: 0 }} />);
  const t = screen.getByTestId("kpi-verified").textContent!;
  expect(t).toContain("--");
  expect(t).not.toContain("0%");
  expect(t).toContain("4 already satisfied");
});
