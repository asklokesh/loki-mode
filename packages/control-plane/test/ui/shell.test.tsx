// CPE-02: lean shell. Session grouping, page registry, Settings area and the empty state.
import "./dom";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const realFetch = globalThis.fetch;
const { act, cleanup, fireEvent, render, screen, waitFor, within } = await import("@testing-library/react");
const { groupRuns } = await import("../../ui/src/shell/grouping");
const { AppShell } = await import("../../ui/src/shell/AppShell");
const { registerPage, unregisterPage, matchPage, settingsPages } = await import("../../ui/src/pages/registry");
const { setCommandPaletteHandler } = await import("../../ui/src/shell/hooks");
await import("../../ui/src/App"); // registers the built-in pages

const FIX = join(import.meta.dir, "fixtures");
const load = (f: string) => JSON.parse(readFileSync(join(FIX, f), "utf8"));
const base = load("runs.json").runs[0] as Record<string, unknown>;

function serve(map: Record<string, unknown>) {
  globalThis.fetch = (async (url: string) => {
    const body = map[String(url).split("?")[0]!];
    return body === undefined ? new Response("nope", { status: 404 }) : new Response(JSON.stringify(body));
  }) as unknown as typeof fetch;
}

// Local-time anchors so the grouping is independent of the machine timezone.
const NOW = new Date(2026, 9, 3, 14, 30).getTime();
const at = (daysBack: number, h = 10) => new Date(2026, 9, 3 - daysBack, h, 0).toISOString();
const run = (id: string, started: string | null, extra: Record<string, unknown> = {}) =>
  ({ ...base, run_id: id, started_at: started, last_event_at: started, ...extra }) as never;

beforeAll(() => { (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE = ""; });
beforeEach(() => { location.hash = ""; });
afterEach(cleanup);
afterAll(() => { globalThis.fetch = realFetch; location.hash = ""; });

test("grouping: Today, Yesterday, Earlier from local days, newest first, empty groups omitted", () => {
  const runs = [
    run("old", at(5)),
    run("today-early", at(0, 1)),
    run("yesterday-late", at(1, 23)),
    run("today-late", at(0, 14)),
    run("two-days", at(2)),
    run("undated", null),
  ];
  const g = groupRuns(runs, NOW);
  expect(g.map((x) => x.name)).toEqual(["Today", "Yesterday", "Earlier"]);
  expect(g[0]!.runs.map((r) => r.run_id)).toEqual(["today-late", "today-early"]);
  expect(g[1]!.runs.map((r) => r.run_id)).toEqual(["yesterday-late"]);
  expect(g[2]!.runs.map((r) => r.run_id)).toEqual(["two-days", "old", "undated"]);
  expect(groupRuns([run("only", at(0))], NOW).map((x) => x.name)).toEqual(["Today"]);
  expect(groupRuns([], NOW)).toEqual([]);
});

test("sidebar renders the grouped sessions from GET /v1/runs", async () => {
  const now = Date.now();
  const today = new Date(now).toISOString();
  serve({ "/v1/runs": { runs: [run("run-today", today, { issue_ref: "o/r#7" }), run("run-earlier", "2020-01-01T00:00:00Z")], total: 2, next_cursor: null } });
  render(<AppShell />);
  const list = await screen.findByTestId("session-list");
  expect(within(list).getByText("Today")).toBeTruthy();
  expect(within(list).getByText("Earlier")).toBeTruthy();
  expect(within(list).queryByText("Yesterday")).toBeNull();
  const rows = within(list).getAllByTestId("session-row");
  expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("o/r#7"), expect.stringContaining("run-earlier")]);
  expect(rows[0]!.getAttribute("href")).toContain("#/runs/");
  expect(screen.getByTestId("mascot")).toBeTruthy();
});

test("sidebar row without an issue ref shows the task title and repo, and the badge truncates instead of wrapping", async () => {
  const today = new Date().toISOString();
  serve({ "/v1/runs": { runs: [run("run-title", today, { issue_ref: null, title: "add a multiply function", origin_repo: "acme/calc", verdict: "VERIFIED", attested: true, sig_checked: false, tampered: false })], total: 1, next_cursor: null } });
  render(<AppShell />);
  const row = await screen.findByTestId("session-row");
  expect(row.textContent).toContain("add a multiply function");
  expect(row.textContent).toContain("acme/calc");
  expect(row.textContent).not.toContain("run-title");
  const badge = row.querySelector("[data-cp='badge']") as HTMLElement;
  expect([badge.style.whiteSpace, badge.style.textOverflow, badge.style.overflow]).toEqual(["nowrap", "ellipsis", "hidden"]);
  expect(badge.getAttribute("title")).toBe(badge.textContent!);
});

test("registry: a registered page renders in the outlet with its params", async () => {
  serve({ "/v1/runs": load("empty.json") });
  const Probe = ({ params }: { params: Record<string, string> }) => <p data-testid="probe">probe {params.id}</p>;
  registerPage({ id: "t-probe", path: "/probe/:id", title: "Probe", component: Probe });
  try {
    location.hash = "#/probe/a%20b";
    render(<AppShell />);
    expect((await screen.findByTestId("probe")).textContent).toBe("probe a b");
    expect(matchPage("#/nope")).toBeNull();
    expect(matchPage("#/probe/x")?.page.id).toBe("t-probe");
  } finally { unregisterPage("t-probe"); }
});

test("registry: a page registered after mount appears without a reload", async () => {
  serve({ "/v1/runs": load("empty.json") });
  location.hash = "#/late";
  render(<AppShell />);
  expect(await screen.findByText("Page not found")).toBeTruthy();
  act(() => registerPage({ id: "t-late", path: "/late", title: "Late", component: () => <p data-testid="late">late page</p> }));
  try { expect((await screen.findByTestId("late")).textContent).toBe("late page"); } finally { unregisterPage("t-late"); }
});

test("Settings entry lists inSettings pages and opens the chosen one", async () => {
  serve({ "/v1/runs": load("empty.json"), "/v1/repos": { repos: [] } });
  registerPage({ id: "t-keys", path: "/settings/keys", title: "Keys", inSettings: true, component: () => <p data-testid="keys-page">keys body</p> });
  registerPage({ id: "t-hidden", path: "/other/hidden", title: "Hidden", component: () => <p>hidden</p> });
  try {
    expect(settingsPages().map((p) => p.id)).toContain("t-keys");
    expect(settingsPages().map((p) => p.id)).not.toContain("t-hidden");
    render(<AppShell />);
    const entry = within(screen.getByTestId("nav")).getByText("Settings");
    expect(entry.closest("a")?.getAttribute("href")).toBe("#/settings");
    location.hash = "#/settings";
    const sn = await screen.findByTestId("settings-nav");
    expect(within(sn).getByText("General")).toBeTruthy();
    expect(within(sn).getByText("Keys")).toBeTruthy();
    expect(within(sn).queryByText("Hidden")).toBeNull();
    expect(screen.getByText(/Switch to (light|dark) theme/)).toBeTruthy(); // first settings page (General) shows by default
    location.hash = "#/settings/keys";
    expect((await screen.findByTestId("keys-page")).textContent).toBe("keys body");
  } finally { unregisterPage("t-keys"); unregisterPage("t-hidden"); }
});

test("empty state: no runs shows the import-repo state and an empty session list", async () => {
  const zero = { since: null, runs_total: 0, runs_finished: 0, runs_running: 0, by_verdict: {}, verified_rate: null, cost: { measured_usd: null, measured_runs: 0, partial_usd: null, partial_runs: 0, label: "not measured" } };
  serve({ "/v1/runs": load("empty.json"), "/v1/repos": { repos: [] }, "/v1/stats": zero, "/v1/notifications": { notifications: [], total: 0 } });
  render(<AppShell />);
  const empty = await screen.findByTestId("empty-state");
  expect(within(empty).getByText("Import runs from this folder")).toBeTruthy();
  expect(within(empty).getByText("loki start owner/repo#N")).toBeTruthy();
  expect((await screen.findByTestId("sessions-empty")).textContent).toContain("No sessions yet");
});

test("New run navigates to the start form; Cmd+K calls the reserved hook only when set", async () => {
  serve({ "/v1/runs": load("empty.json"), "/v1/repos": { repos: [] } });
  render(<AppShell />);
  fireEvent.click(screen.getByTestId("new-run"));
  await waitFor(() => expect(location.hash).toBe("#/new"));
  expect(await screen.findByTestId("composer")).toBeTruthy(); // CPE-08 composer replaces the built-in start form
  expect(screen.getByTestId("composer-input")).toBeTruthy();
  const press = () => { const e = new KeyboardEvent("keydown", { key: "k", metaKey: true, cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };
  expect(press()).toBe(false);
  let n = 0;
  setCommandPaletteHandler(() => { n++; });
  try { expect(press()).toBe(true); expect(n).toBe(1); } finally { setCommandPaletteHandler(null); }
});
