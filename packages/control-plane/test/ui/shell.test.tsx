// Shell: navigation-only sidebar, page registry, Settings area, Ask history and the Cmd+K routing.
import "./dom";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const realFetch = globalThis.fetch;
const { act, cleanup, fireEvent, render, screen, waitFor, within } = await import("@testing-library/react");
const { AppShell } = await import("../../ui/src/shell/AppShell");
const { registerPage, unregisterPage, matchPage, settingsPages } = await import("../../ui/src/pages/registry");
const { setCommandPaletteHandler } = await import("../../ui/src/shell/hooks");
const { resetAskState, refreshAsk } = await import("../../ui/src/pages/ask/api");
const { closeNewRun, getNewRun } = await import("../../ui/src/pages/compose/store");
await import("../../ui/src/App"); // registers the built-in pages

const FIX = join(import.meta.dir, "fixtures");
const load = (f: string) => JSON.parse(readFileSync(join(FIX, f), "utf8"));

function serve(map: Record<string, unknown>) {
  globalThis.fetch = (async (url: string) => {
    const body = map[String(url).split("?")[0]!];
    return body === undefined ? new Response(JSON.stringify({ error: "nope" }), { status: 404 }) : new Response(JSON.stringify(body));
  }) as unknown as typeof fetch;
}

beforeAll(() => { (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE = ""; });
beforeEach(() => { location.hash = ""; resetAskState(); closeNewRun(); });
afterEach(cleanup);
afterAll(() => { globalThis.fetch = realFetch; location.hash = ""; resetAskState(); });

test("sidebar is navigation only: six entries, a New run button, and no run list", async () => {
  serve({ "/v1/runs": load("runs.json") });
  render(<AppShell />);
  const nav = screen.getByTestId("nav");
  const links = within(screen.getByTestId("nav-links")).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")]);
  expect(links).toEqual([["Overview", "#/"], ["Runs", "#/runs"], ["Pull requests", "#/pulls"], ["Repos", "#/repos"], ["Receipts", "#/receipts"]]);
  expect(within(nav).getByText("Settings").closest("a")?.getAttribute("href")).toBe("#/settings");
  expect(within(nav).queryByTestId("session-row")).toBeNull();
  expect(within(nav).queryByTestId("session-list")).toBeNull();
  expect(within(nav).getByTestId("sidebar-new-run")).toBeTruthy();
  expect(screen.getByTestId("mascot")).toBeTruthy();
});

test("the sidebar New run button opens the picker; it never starts a run", async () => {
  let posted = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") posted++;
    const u = String(url);
    if (u.startsWith("/v1/repos")) return new Response(JSON.stringify({ repos: ["alpha"] }));
    if (u.startsWith("/v1/runs")) return new Response(JSON.stringify({ runs: [], total: 0, next_cursor: null }));
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  render(<AppShell />);
  fireEvent.click(within(screen.getByTestId("nav")).getByTestId("sidebar-new-run"));
  expect(getNewRun().open).toBe(true);
  expect((await screen.findByTestId("picker-repo"))).toBeTruthy();
  expect(posted).toBe(0);
});

test("the home route is the Overview, not a composer", async () => {
  serve({ "/v1/runs": load("runs.json") });
  render(<AppShell />);
  expect(await screen.findByTestId("overview")).toBeTruthy();
  expect(screen.queryByText("What should Loki build?")).toBeNull();
  expect(screen.queryByTestId("hero")).toBeNull();
});

test("Ask history lists past threads under an Ask Loki section, and is absent when Ask is off", async () => {
  serve({ "/v1/runs": load("empty.json") });
  const off = render(<AppShell />);
  await waitFor(() => expect(within(screen.getByTestId("nav")).queryByTestId("ask-history")).toBeNull());
  off.unmount();
  resetAskState();
  serve({ "/v1/runs": load("empty.json"), "/v1/ask/threads": { threads: [{ id: "t1", title: "Why did FireLater#17 fail", updated_at: "2026-10-03T10:00:00Z" }] } });
  render(<AppShell />);
  const hist = await screen.findByTestId("ask-history");
  expect(within(hist).getByText("Ask Loki")).toBeTruthy();
  const link = within(hist).getByTestId("ask-thread-link");
  expect(link.textContent).toBe("Why did FireLater#17 fail");
  expect(link.getAttribute("href")).toBe("#/ask/t1");
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
    location.hash = "#/settings";
    const sn = await screen.findByTestId("settings-nav");
    expect(within(sn).getByText("General")).toBeTruthy();
    expect(within(sn).getByText("Keys")).toBeTruthy();
    expect(within(sn).queryByText("Hidden")).toBeNull();
    location.hash = "#/settings/keys";
    expect((await screen.findByTestId("keys-page")).textContent).toBe("keys body");
  } finally { unregisterPage("t-keys"); unregisterPage("t-hidden"); }
});

test("empty state: no runs shows the import state on the Overview", async () => {
  serve({ "/v1/runs": load("empty.json"), "/v1/repos": { repos: [] } });
  render(<AppShell />);
  const empty = await screen.findByTestId("empty-state");
  expect(within(empty).getByText("Import runs from this folder")).toBeTruthy();
  expect(within(empty).getByText("loki start owner/repo#N")).toBeTruthy();
});

test("Cmd+K opens the palette when Ask is off, Ask Loki when it is on; Cmd+/ always opens the palette", async () => {
  serve({ "/v1/runs": load("empty.json") });
  render(<AppShell />);
  const press = (key: string) => { const e = new KeyboardEvent("keydown", { key, metaKey: true, cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };
  expect(press("k")).toBe(false); // no palette handler registered
  let n = 0;
  setCommandPaletteHandler(() => { n++; });
  try {
    await refreshAsk(); // /v1/ask/threads is 404: Ask is off
    expect(press("k")).toBe(true);
    expect(n).toBe(1);
    expect(location.hash).toBe("");
    serve({ "/v1/runs": load("empty.json"), "/v1/ask/threads": { threads: [] } });
    await refreshAsk();
    expect(press("k")).toBe(true);
    expect(n).toBe(1);
    expect(location.hash).toBe("#/ask");
    expect(press("/")).toBe(true);
    expect(n).toBe(2);
  } finally { setCommandPaletteHandler(null); }
});
