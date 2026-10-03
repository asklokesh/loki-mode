// CPE-11: runs table filters, sorting, rollup, links and live refresh.
import "./dom";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
const { cleanup, render, screen, fireEvent, waitFor, act } = await import("@testing-library/react");
const { RunsPage, page } = await import("../../ui/src/pages/runs");
const { applyFilters, sortRows, rollupByRepo, NO_FILTERS } = await import("../../ui/src/pages/runs/logic");

const row = (o: Record<string, unknown>) => ({
  source_id: "s1", run_id: "r1", origin_repo: null, issue_ref: null, task_source: "text", provider: "claude", model: "sonnet",
  started_at: "2026-10-03T10:00:00Z", ended_at: null, verdict: null, pr_url: null, pr_draft: null, cost_usd: null, partial_usd: 0,
  measured_sessions: 0, total_sessions: 0, input_tokens: null, output_tokens: null, wall_s: null, last_seq: 1, last_event_at: null,
  tampered: false, conflict: false, ...o,
}) as import("../../ui/src/api").RunRow;

let data = [
  row({ run_id: "a", origin_repo: "o/x", verdict: "VERIFIED", cost_usd: 2, started_at: "2026-10-01T10:00:00Z", task_source: "issue", status: "completed" }),
  row({ run_id: "b", origin_repo: "o/x", verdict: "FAILED", cost_usd: 1, started_at: "2026-10-02T10:00:00Z", task_source: "text", status: "completed" }),
  row({ run_id: "c", origin_repo: "o/y", verdict: null, cost_usd: null, started_at: "2026-10-03T10:00:00Z", task_source: "issue", status: "running" }),
  row({ run_id: "d", origin_repo: null, verdict: "VERIFIED", cost_usd: 5, started_at: "2026-09-30T10:00:00Z", source_id: "s2", task_source: "text", status: "completed" }),
];
let fetches = 0;
beforeAll(() => {
  (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE = "";
  globalThis.fetch = (async () => { fetches++; return new Response(JSON.stringify({ runs: data, total: data.length, next_cursor: null })); }) as unknown as typeof fetch;
});
afterEach(cleanup);
afterAll(() => { globalThis.fetch = realFetch; });

function pick(name: string, value: string) {
  const chip = screen.getByTestId(`filter-${name}`);
  fireEvent.click(chip.querySelector("button")!);
  const items = screen.getAllByRole("menuitem");
  fireEvent.click(items.find((i) => i.textContent === (value || "All"))!);
}
const ids = () => screen.getAllByTestId("run-row").map((r) => r.getAttribute("data-run"));

test("page export and links to #/runs/<source>/<run>", async () => {
  expect(page.id).toBe("runs");
  render(<RunsPage subscribe={null} />);
  await screen.findAllByTestId("run-row");
  const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
  expect(hrefs).toContain("#/runs/s2/d");
  expect(hrefs).toContain("#/runs/s1/a");
});

test("filters: status, verdict, repo, source and search", async () => {
  render(<RunsPage subscribe={null} />);
  await screen.findAllByTestId("run-row");
  await waitFor(() => expect(ids()).toEqual(["c", "b", "a", "d"]));
  pick("status", "running");
  await waitFor(() => expect(ids()).toEqual(["c"]));
  pick("status", "");
  pick("verdict", "VERIFIED");
  await waitFor(() => expect(ids()).toEqual(["a", "d"]));
  pick("repo", "o/x");
  await waitFor(() => expect(ids()).toEqual(["a"]));
  pick("repo", "");
  pick("verdict", "");
  pick("source", "text");
  await waitFor(() => expect(ids()).toEqual(["b", "d"]));
  fireEvent.input(screen.getByLabelText("Search runs"), { target: { value: "o/x" } });
  await waitFor(() => expect(ids()).toEqual(["b"]));
  fireEvent.input(screen.getByLabelText("Search runs"), { target: { value: "zzz" } });
  expect(screen.getByText("No runs match these filters")).toBeTruthy();
});

test("sorting toggles direction and keeps unpriced cost last", async () => {
  render(<RunsPage subscribe={null} />);
  await screen.findAllByTestId("run-row");
  fireEvent.click(screen.getByTestId("sort-cost"));
  await waitFor(() => expect(ids()).toEqual(["d", "a", "b", "c"]));
  fireEvent.click(screen.getByTestId("sort-cost"));
  await waitFor(() => expect(ids()).toEqual(["b", "a", "d", "c"]));
  fireEvent.click(screen.getByTestId("sort-started"));
  await waitFor(() => expect(ids()).toEqual(["c", "b", "a", "d"]));
  fireEvent.click(screen.getByTestId("sort-started"));
  await waitFor(() => expect(ids()).toEqual(["d", "a", "b", "c"]));
});

test("rollup by repo counts runs, verified, running and sums only priced cost", async () => {
  const g = rollupByRepo(data);
  const x = g.find((r) => r.repo === "o/x")!;
  expect([x.runs, x.verified, x.cost, x.unpriced]).toEqual([2, 1, 3, 0]);
  const y = g.find((r) => r.repo === "o/y")!;
  expect([y.runs, y.running, y.cost, y.unpriced]).toEqual([1, 1, null, 1]);
  expect(g.find((r) => r.repo === "no repo")!.runs).toBe(1);
  expect(applyFilters(data, { ...NO_FILTERS, repo: "no repo" }).length).toBe(1);
  expect(sortRows(data, "repo", "asc")[0]!.run_id).toBe("d");

  render(<RunsPage subscribe={null} />);
  await screen.findAllByTestId("run-row");
  expect(screen.queryByTestId("rollup")).toBeNull();
  fireEvent.click(screen.getByTestId("group-toggle"));
  const rows = screen.getAllByTestId("rollup-row");
  expect(rows[0]!.getAttribute("data-repo")).toBe("o/x");
  expect(rows[0]!.textContent).toContain("1 of 2");
  expect(rows[0]!.textContent).toContain("$3.00");
  expect(rows.find((r) => r.getAttribute("data-repo") === "o/y")!.textContent).toContain("unpriced");
});

test("a stream change event refetches the list and unmount unsubscribes", async () => {
  let fire: () => void = () => {};
  let unsubbed = false;
  const subscribe = (cb: () => void) => { fire = cb; return () => { unsubbed = true; }; };
  const { unmount } = render(<RunsPage subscribe={subscribe} />);
  await screen.findAllByTestId("run-row");
  const before = fetches;
  data = [...data, row({ run_id: "e", origin_repo: "o/z", status: "running" })];
  await act(async () => { fire(); });
  await waitFor(() => expect(ids()).toContain("e"));
  expect(fetches).toBeGreaterThan(before);
  unmount();
  expect(unsubbed).toBe(true);
});
