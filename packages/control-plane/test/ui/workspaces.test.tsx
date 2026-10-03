// CPE-19: Workspaces page. Group status is measured only when every repo has a run; shell workspaces are read-only.
import "./dom";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { Workspaces } = await import("../../ui/src/pages/workspaces/Workspaces");
const { page } = await import("../../ui/src/pages/workspaces/index");
const { buildViews } = await import("../../ui/src/pages/workspaces/logic");

const CONFIG = { workspaces: {
  web: { repos: [{ repo: "acme/api", path: "../api" }, { repo: "acme/web", path: "../web", after: ["acme/api"] }] },
  ops: { repos: [{ repo: "acme/infra", setup: "make init" }], integration: { command: "make it" } },
  lone: { repos: [{ repo: "acme/solo" }] },
} };
const RUNS = [
  { source_id: "s", run_id: "1", origin_repo: "acme/api", verdict: "VERIFIED", started_at: "2026-10-01T10:00:00Z" },
  { source_id: "s", run_id: "2", origin_repo: "acme/web", verdict: "FAILED", started_at: "2026-10-01T11:00:00Z" },
];
let posted: { url: string; body: unknown }[] = [];

function serve(opts: { cfg?: unknown; refuse?: boolean } = {}) {
  posted = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === "POST") {
      posted.push({ url: u, body: JSON.parse(String(init.body)) });
      return opts.refuse ? new Response(JSON.stringify({ error: "workspace runs do not take provider or budget" }), { status: 400 }) : new Response(JSON.stringify({ ok: true, pid: 42, command: "workspace run web x/y#1" }));
    }
    if (u.startsWith("/v1/config")) return new Response(JSON.stringify({ config: opts.cfg ?? CONFIG, errors: [] }));
    if (u.startsWith("/v1/runs")) return new Response(JSON.stringify({ runs: RUNS, total: 2, next_cursor: null }));
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
}

beforeAll(() => { (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE = ""; });
afterEach(cleanup);
afterAll(() => { globalThis.fetch = realFetch; });

test("page export shape", () => {
  expect(page.id).toBe("workspaces");
  expect(page.path).toBe("/workspaces");
  expect(page.title).toBe("Workspaces");
});

test("group status is measured only when every repo has a run", () => {
  const v = buildViews(CONFIG, RUNS as never);
  expect(v.find((w) => w.name === "web")!.status).toEqual({ total: 2, verified: 1, failed: 1, running: 0 });
  expect(v.find((w) => w.name === "lone")!.status).toBeNull();
  expect(v.find((w) => w.name === "ops")!.shell).toBe(true);
});

test("renders workspaces, repos and not measured for missing data", async () => {
  serve();
  render(<Workspaces />);
  await screen.findByText("web");
  expect(screen.getByText("Group: 1 of 2 verified, 1 not verified")).toBeTruthy();
  expect(screen.getAllByText("Group status: not measured").length).toBe(2);
  expect(screen.getAllByText("read-only: runs shell commands").length).toBe(1);
});

test("run posts body.workspace and reports the started command", async () => {
  serve();
  render(<Workspaces />);
  await screen.findByText("web");
  fireEvent.input(screen.getByLabelText("Target for web"), { target: { value: "acme/api#1" } });
  fireEvent.click(screen.getAllByText("Run workspace")[0]!);
  await screen.findByText(/Started: workspace run web/);
  expect(posted[0]!.url).toBe("/v1/runs");
  expect(posted[0]!.body).toEqual({ workspace: "web", target: "acme/api#1" });
});

test("a refused run shows the server error", async () => {
  serve({ refuse: true });
  render(<Workspaces />);
  await screen.findByText("web");
  fireEvent.input(screen.getByLabelText("Target for web"), { target: { value: "x" } });
  fireEvent.click(screen.getAllByText("Run workspace")[0]!);
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("do not take provider"));
});

test("empty config shows an empty state", async () => {
  serve({ cfg: {} });
  render(<Workspaces />);
  await screen.findByText("No workspaces");
});
