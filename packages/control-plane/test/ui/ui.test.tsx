// CP-03 Wall check: the Runs list and detail views render the section 4 JSON captured from the CP-00 corpus.
import "./dom";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const realFetch = globalThis.fetch;
const { cleanup, render, screen, waitFor, within } = await import("@testing-library/react");
const { RunDetail, RunsList } = await import("../../ui/src/App");

const FIX = join(import.meta.dir, "fixtures");
const load = (f: string) => JSON.parse(readFileSync(join(FIX, f), "utf8"));
const expected = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/EXPECTED.json"), "utf8")) as {
  run_count: number;
  runs: Record<string, { verdict: string; tampered: boolean; cost_usd: number | null; not_proven: string[]; pr_url: string | null }>;
};

function serve(map: Record<string, unknown>) {
  globalThis.fetch = (async (url: string) => {
    const body = map[String(url).split("?")[0]!];
    return body === undefined ? new Response("nope", { status: 404 }) : new Response(JSON.stringify(body));
  }) as unknown as typeof fetch;
}

beforeAll(() => { (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE = ""; });
afterEach(cleanup);
// happy-dom replaces global fetch; restore the real one so other files in the same bun process still work
afterAll(() => { globalThis.fetch = realFetch; location.hash = ""; });

test("runs list: row count and verdict badges equal EXPECTED.json", async () => {
  serve({ "/v1/runs": load("runs.json") });
  render(<RunsList />);
  const rows = await screen.findAllByTestId("run-row");
  expect(rows.length).toBe(expected.run_count);
  const shown = rows.map((r) => within(r).getByTestId("verdict").textContent).sort();
  expect(shown).toEqual(Object.values(expected.runs).map((r) => (r as { tampered?: boolean }).tampered ? "TAMPERED" : r.verdict).sort());
});

test("runs list: a tampered run shows a red TAMPERED badge, never its recorded verdict", async () => {
  const runs = load("runs.json");
  serve({ "/v1/runs": runs });
  render(<RunsList />);
  const rows = await screen.findAllByTestId("run-row");
  const t = runs.runs.find((r: { tampered: boolean }) => r.tampered);
  const badge = within(rows.find((r) => r.textContent!.includes(t.run_id))!).getByTestId("verdict");
  expect(badge.textContent).toBe("TAMPERED");
  expect(badge.className).toContain("text-red-");
  expect(rows.map((r) => r.textContent).join(" ")).not.toMatch(/tampered/);
});

test("run detail: a tampered run shows TAMPERED as the verdict, including the receipt badge", async () => {
  const d = load("detail-tampered.json");
  serve({ [`/v1/runs/${d.source_id}/${d.run_id}`]: d });
  render(<RunDetail source={d.source_id} run={d.run_id} />);
  await screen.findByText(/event log tampered/);
  const badges = screen.getAllByTestId("verdict").map((b) => b.textContent);
  expect(badges.length).toBeGreaterThan(0);
  for (const b of badges) expect(b).toBe("TAMPERED");
});

test("runs list: unpriced run shows 'unpriced', never $0", async () => {
  serve({ "/v1/runs": load("runs.json") });
  render(<RunsList />);
  const rows = await screen.findAllByTestId("run-row");
  const unpriced = load("detail-unpriced.json").run_id;
  const row = rows.find((r) => r.textContent!.includes(unpriced))!;
  expect(within(row).getByTestId("cost").textContent).toContain("unpriced");
  expect(expected.runs["unpriced"]!.cost_usd).toBeNull();
});

test("runs list: PR link shown for the run that opened one", async () => {
  serve({ "/v1/runs": load("runs.json") });
  render(<RunsList />);
  const rows = await screen.findAllByTestId("run-row");
  const d = load("detail-verified-pr.json");
  expect(within(rows.find((r) => r.textContent!.includes(d.run_id))!).getByText(d.pr_url)).toBeTruthy();
});

test("run detail: NOT PROVEN items equal EXPECTED.json", async () => {
  const d = load("detail-partial.json");
  serve({ [`/v1/runs/${d.source_id}/${d.run_id}`]: d });
  render(<RunDetail source={d.source_id} run={d.run_id} />);
  const items = await screen.findAllByTestId("not-proven");
  expect(items.map((i) => i.textContent)).toEqual(expected.runs["partial"]!.not_proven);
  expect((await screen.findAllByTestId("stage")).length).toBe(d.stages.length);
});

test("run detail: unpriced cost reads 'unpriced'", async () => {
  const d = load("detail-unpriced.json");
  serve({ [`/v1/runs/${d.source_id}/${d.run_id}`]: d });
  render(<RunDetail source={d.source_id} run={d.run_id} />);
  await waitFor(() => expect(screen.getByTestId("cost").textContent).toContain("unpriced"));
});

test("empty DB: import button and CLI line, no env-var text", async () => {
  serve({ "/v1/runs": load("empty.json") });
  render(<RunsList />);
  const empty = await screen.findByTestId("empty-state");
  expect(screen.getByText("Import runs from this folder")).toBeTruthy();
  expect(screen.getByText("loki start owner/repo#N")).toBeTruthy();
  expect(empty.textContent ?? "").not.toMatch(/LOKI_[A-Z_]+/);
  expect(document.body.textContent ?? "").not.toContain("LOKI_CONTROL_URL");
});

test("brand is Loki Mode with New run and one Settings entry", async () => {
  serve({ "/v1/runs": load("empty.json"), "/v1/repos": { repos: [] } });
  const { App } = await import("../../ui/src/App");
  render(<App />);
  const nav = screen.getByTestId("nav");
  expect(nav.textContent).toContain("Loki Mode");
  expect(nav.textContent).not.toContain("Loki Control");
  for (const l of ["New run", "Settings"]) expect(within(nav).getByText(l)).toBeTruthy();
  expect(readFileSync(join(import.meta.dir, "../../ui/index.html"), "utf8")).toContain("<title>Loki Mode</title>");
});

test("live run: list shows stage, elapsed and files; detail polls until completed", async () => {
  const live = { ...load("detail-verified.json"), status: "running", verdict: null, ended_at: null, elapsed_s: 12, current_stage: "verify", files_touched: ["calc.ts"] };
  serve({ "/v1/runs": { runs: [live], total: 1, next_cursor: null } });
  const { unmount } = render(<RunsList />);
  const p = await screen.findByTestId("progress");
  expect(p.textContent).toContain("verify");
  expect(p.textContent).toContain("1 files");
  expect(within(p).getByTestId("elapsed").textContent).toMatch(/^\d+s$/);
  unmount();

  let n = 0;
  const path = `/v1/runs/${live.source_id}/${live.run_id}`;
  globalThis.fetch = (async (url: string) => {
    if (String(url) !== path) return new Response("nope", { status: 404 });
    n++;
    return new Response(JSON.stringify(n === 1 ? live : { ...live, status: "completed", verdict: "VERIFIED", ended_at: "2026-10-01T00:00:00Z" }));
  }) as unknown as typeof fetch;
  render(<RunDetail source={live.source_id} run={live.run_id} />);
  expect((await screen.findByTestId("current-stage")).textContent).toBe("verify");
  await waitFor(() => expect(screen.getAllByTestId("verdict")[0]!.textContent).toBe("VERIFIED"), { timeout: 6000 });
  expect(n).toBeGreaterThanOrEqual(2);
}, 12000);

test("mobile layout: sidebar is desktop-only with a drawer button, wide columns collapse", async () => {
  serve({ "/v1/runs": load("runs.json") });
  const { App } = await import("../../ui/src/App");
  location.hash = "#/runs"; // the Runs page; the bare route is the landing view
  const { container } = render(<App />);
  await screen.findAllByTestId("run-row");
  const nav = within(container as HTMLElement).getByTestId("nav");
  expect(nav.className).toContain("hidden");
  expect(nav.className).toContain("md:flex");
  expect(within(container as HTMLElement).getByTestId("open-drawer")).toBeTruthy();
  // CPE-11 runs table keeps every column and scrolls inside its own container instead of hiding columns
  const table = within(container as HTMLElement).getByTestId("runs-table");
  expect(table.parentElement?.style.overflow).toBe("auto");
  const heads = Array.from(container.querySelectorAll("th")).filter((h) => /^(Started|Repo)/.test(h.textContent ?? ""));
  expect(heads.length).toBe(2);
});

test("remove run: confirm step, DELETE call, then back to the runs list", async () => {
  const d = load("detail-verified.json");
  const path = `/v1/runs/${d.source_id}/${d.run_id}`;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url) !== path) return new Response("nope", { status: 404 });
    calls.push(init?.method ?? "GET");
    return init?.method === "DELETE" ? new Response(JSON.stringify({ ok: true, removed: { runs: 1, events: 3, sources: 0 }, remaining_runs: 0 })) : new Response(JSON.stringify(d));
  }) as unknown as typeof fetch;
  const { fireEvent } = await import("@testing-library/react");
  render(<RunDetail source={d.source_id} run={d.run_id} />);
  fireEvent.click(await screen.findByTestId("remove-run"));
  expect(calls).not.toContain("DELETE"); // the first click only asks
  expect(screen.getByTestId("remove-confirm-text").textContent).toContain("cannot be undone");
  fireEvent.click(screen.getByTestId("remove-confirm"));
  await waitFor(() => expect(calls).toContain("DELETE"));
  await waitFor(() => expect(location.hash).toBe("#/runs"));
});

test("remove run: a failure is shown, not swallowed, and the run stays", async () => {
  const d = load("detail-verified.json");
  const path = `/v1/runs/${d.source_id}/${d.run_id}`;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url) !== path) return new Response("nope", { status: 404 });
    return init?.method === "DELETE" ? new Response(JSON.stringify({ error: "origin not allowed" }), { status: 403 }) : new Response(JSON.stringify(d));
  }) as unknown as typeof fetch;
  const { fireEvent } = await import("@testing-library/react");
  location.hash = "";
  render(<RunDetail source={d.source_id} run={d.run_id} />);
  fireEvent.click(await screen.findByTestId("remove-run"));
  fireEvent.click(screen.getByTestId("remove-confirm"));
  const e = await screen.findByTestId("remove-error");
  expect(e.textContent).toContain("origin not allowed");
  expect(location.hash).toBe("");
  fireEvent.click(screen.getByTestId("remove-cancel"));
  expect(screen.queryByTestId("remove-error")).toBeNull();
});
