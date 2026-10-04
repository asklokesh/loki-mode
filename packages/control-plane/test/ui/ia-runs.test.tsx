// A4a: issue grouping, KPIs, NEEDS YOU, the grouped Runs table and the Overview.
import "./dom";
import { afterEach, expect, test } from "bun:test";

const { cleanup, fireEvent, render, screen, within } = await import("@testing-library/react");
const { groupByIssue, inboxOf, kpisOf, costOf, durationOf } = await import("../../ui/src/pages/runs/issues");
const { RunsView } = await import("../../ui/src/pages/runs");
const { HomeView, kpiTiles } = await import("../../ui/src/pages/home/Home");

const NOW = Date.parse("2026-10-03T12:00:00Z");
const row = (o: Record<string, unknown>) => ({
  source_id: "s1", run_id: "r", origin_repo: "o/x", issue_ref: null, title: null, task_source: "issue", provider: "claude", model: "sonnet",
  started_at: "2026-10-03T10:00:00Z", ended_at: "2026-10-03T10:05:00Z", verdict: "VERIFIED", pr_url: null, pr_draft: null, cost_usd: 1, partial_usd: 0,
  measured_sessions: 1, total_sessions: 1, input_tokens: null, output_tokens: null, wall_s: 300, last_seq: 3, last_event_at: null,
  tampered: false, conflict: false, status: "completed", ...o,
}) as import("../../ui/src/api").RunRow;

const a1 = row({ run_id: "a1", issue_ref: "o/x#1", title: "Fix login", verdict: "FAILED", started_at: "2026-10-02T10:00:00Z", ended_at: "2026-10-02T10:05:00Z" });
const a2 = row({ run_id: "a2", issue_ref: "o/x#1", title: "Fix login", verdict: "VERIFIED", pr_url: "https://github.com/o/x/pull/5" });
const part = row({ run_id: "p1", issue_ref: "o/x#2", title: "Add cache", verdict: "PARTIAL" });
const blocked = row({ run_id: "b1", issue_ref: "o/x#3", title: "Spec clash", verdict: "SPEC_CONFLICT" });
const free = row({ run_id: "f1", issue_ref: null, title: null, verdict: "VERIFIED", cost_usd: null, measured_sessions: 0 });
const all = [a1, a2, part, blocked, free];

afterEach(cleanup);

test("grouping: attempts of one issue collapse, the latest attempt decides the state, titles are never run ids", () => {
  const g = groupByIssue(all);
  expect(g.length).toBe(4);
  const one = g.find((x) => x.ref === "o/x#1")!;
  expect(one.attempts.map((r) => r.run_id)).toEqual(["a2", "a1"]);
  expect(one.latest.run_id).toBe("a2");
  expect(g.find((x) => x.latest.run_id === "f1")!.title).toBe("Untitled task");
  expect(g.some((x) => /^(a1|a2|p1|b1|f1)$/.test(x.title))).toBe(false);
});

test("NEEDS YOU lists blocked, partial and recent PRs from the latest attempt only", () => {
  const inbox = inboxOf(groupByIssue(all), NOW);
  expect(inbox.blocked.map((x) => x.ref)).toEqual(["o/x#3"]);
  expect(inbox.partial.map((x) => x.ref)).toEqual(["o/x#2"]);
  expect(inbox.prs.map((x) => x.ref)).toEqual(["o/x#1"]);
  const stale = inboxOf(groupByIssue([row({ run_id: "old", issue_ref: "o/x#9", pr_url: "https://github.com/o/x/pull/9", started_at: "2026-08-01T10:00:00Z", ended_at: "2026-08-01T10:05:00Z" })]), NOW);
  expect(stale.prs).toEqual([]);
});

test("formatters return null when there is no data", () => {
  expect(costOf(free)).toBeNull();
  expect(costOf(a2)).not.toBeNull();
  expect(durationOf(row({ ended_at: null, wall_s: null }))).toBeNull();
});

test("Overview: exactly 4 KPI tiles, NEEDS YOU inbox, no composer", () => {
  render(<HomeView runs={all} now={NOW} />);
  expect(within(screen.getByTestId("kpis")).getAllByTestId(/^kpi-/).length).toBe(4);
  const needs = screen.getByTestId("needs-you");
  expect(within(needs).getAllByTestId("inbox-row").length).toBe(3);
  expect(screen.getByTestId("latest-by-issue")).toBeTruthy();
  expect(screen.queryByTestId("hero")).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(document.body.textContent ?? "").not.toMatch(/unmeasured/i);
});

test("Overview with nothing waiting says so, and an empty KPI states why instead of a zero", () => {
  render(<HomeView runs={[]} now={NOW} />);
  expect(screen.getByTestId("needs-you-empty")).toBeTruthy();
  const t = kpiTiles(kpisOf([], [], NOW));
  expect(t.length).toBe(4);
  expect(t.find((x) => x.id === "kpi-verified")!.value).toBe("No finished runs");
  expect(t.find((x) => x.id === "kpi-cost")!.value).toBe("No priced runs");
});

test("Runs table is grouped by issue, attempts expand, filters narrow, no unmeasured and no raw enums", () => {
  render(<RunsView runs={all} now={NOW} />);
  const rows = screen.getAllByTestId("issue-row");
  expect(rows.length).toBe(4);
  expect(screen.queryAllByTestId("attempt-row").length).toBe(0);
  const first = rows.find((r) => r.textContent!.includes("Fix login"))!;
  expect(first.getAttribute("data-attempts")).toBe("2");
  fireEvent.click(within(first).getByTestId("expand"));
  expect(screen.getAllByTestId("attempt-row").length).toBe(2);
  const text = document.body.textContent ?? "";
  expect(text).not.toMatch(/unmeasured/i);
  expect(text).not.toMatch(/SPEC_CONFLICT|NOT_VERIFIED|ALREADY_SATISFIED/);
  expect(screen.getByTestId("filter-outcome")).toBeTruthy();
  expect(screen.getByTestId("filter-repo")).toBeTruthy();
  expect(screen.queryByText("a1")).toBeNull();
});
