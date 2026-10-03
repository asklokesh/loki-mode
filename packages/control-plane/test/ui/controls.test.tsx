// CPE-10: run controls show the right buttons per status, confirm Stop, and surface server refusals honestly.
import "./dom";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
const { cleanup, render, screen, fireEvent, waitFor } = await import("@testing-library/react");
const { RunControls } = await import("../../ui/src/pages/run-controls");

const posts: string[] = [];
function reply(status: number, body: unknown) {
  posts.length = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    posts.push(`${init?.method} ${String(url)}`);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

beforeAll(() => { (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE = ""; });
afterEach(cleanup);
afterAll(() => { globalThis.fetch = realFetch; });

test("buttons depend on status", () => {
  const a = render(<RunControls source="s1" run="r1" status="running" />);
  expect(screen.queryByText("Stop")).not.toBeNull();
  expect(screen.queryByText("Resume")).toBeNull();
  expect(screen.queryByText("Retry")).toBeNull();
  a.unmount();
  const b = render(<RunControls source="s1" run="r1" status="BLOCKED" />);
  expect(screen.queryByText("Resume")).not.toBeNull();
  expect(screen.queryByText("Stop")).toBeNull();
  b.unmount();
  render(<RunControls source="s1" run="r1" status="FAILED" />);
  expect(screen.queryByText("Retry")).not.toBeNull();
  expect(screen.queryByText("Resume")).toBeNull();
  expect(screen.queryByText("Stop")).toBeNull();
});

test("stop needs confirmation, then posts and reads as stopping", async () => {
  reply(200, { ok: true, pid: 1 });
  render(<RunControls source="s1" run="r1" status="running" />);
  fireEvent.click(screen.getByText("Stop"));
  expect(posts.length).toBe(0);
  fireEvent.click(screen.getByText("Confirm stop"));
  await waitFor(() => expect(screen.queryByText("Stop signal sent.")).not.toBeNull());
  expect(posts).toEqual(["POST /v1/runs/s1/r1/stop"]);
  expect(screen.queryByText("Stop")).toBeNull();
});

test("cancel aborts the stop", () => {
  reply(200, {});
  render(<RunControls source="s1" run="r1" status="running" />);
  fireEvent.click(screen.getByText("Stop"));
  fireEvent.click(screen.getByText("Cancel"));
  expect(posts.length).toBe(0);
  expect(screen.queryByText("Stop")).not.toBeNull();
});

test("a refused stop rolls back and shows the server message", async () => {
  reply(409, { error: "pid 42 is not this run" });
  render(<RunControls source="s1" run="r1" status="running" />);
  fireEvent.click(screen.getByText("Stop"));
  fireEvent.click(screen.getByText("Confirm stop"));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("pid 42 is not this run"));
  expect(screen.queryByText("Stop")).not.toBeNull();
});

test("retry 501 shows the refusal and the button returns", async () => {
  reply(501, { error: "retry is not supported for this run: no issue ref or task text was recorded" });
  render(<RunControls source="s1" run="r1" status="FAILED" />);
  fireEvent.click(screen.getByText("Retry"));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("retry is not supported"));
  expect(screen.queryByText("Retry")).not.toBeNull();
});

test("resume 409 busy is shown and Resume stays available", async () => {
  reply(409, { error: "a run is already starting or running in this repo" });
  render(<RunControls source="s1" run="r1" status="BLOCKED" />);
  fireEvent.click(screen.getByText("Resume"));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("already starting"));
  expect(screen.queryByText("Resume")).not.toBeNull();
});

test("resume success reads as running with Stop offered", async () => {
  reply(200, { ok: true, pid: 9 });
  render(<RunControls source="s1" run="r1" status="BLOCKED" />);
  fireEvent.click(screen.getByText("Resume"));
  await waitFor(() => expect(screen.queryByText("Resume started.")).not.toBeNull());
  expect(posts).toEqual(["POST /v1/runs/s1/r1/resume"]);
  expect(screen.queryByText("Stop")).not.toBeNull();
});

test("wired run page: BLOCKED header shows Resume and Retry, running header shows Stop", async () => {
  const { wirePages } = await import("../../ui/src/pages/wired");
  const { matchPage } = await import("../../ui/src/pages/registry");
  wirePages();
  const m = matchPage("#/runs/s1/r1")!;
  const Page = m.page.component;
  const detail = (o: Record<string, unknown>) => ({ source_id: "s1", run_id: "r1", origin_repo: "o/r", issue_ref: "o/r#7", verdict: null, status: "running", stages: [], stages_completed: [], files_touched: [], not_proven: [], receipt: null, ...o });
  const serve = (d: unknown) => {
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u.endsWith("/v1/runs/s1/r1")) return new Response(JSON.stringify(d));
      if (u.includes("/events")) return new Response(JSON.stringify({ events: [] }));
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;
  };
  serve(detail({ blocked_question: "Which db?" }));
  const a = render(<Page params={m.params} />);
  await waitFor(() => expect(screen.queryByText("Resume")).not.toBeNull());
  expect(screen.queryByText("Retry")).not.toBeNull();
  expect(screen.queryByText("Stop")).toBeNull();
  a.unmount();
  serve(detail({}));
  render(<Page params={m.params} />);
  await waitFor(() => expect(screen.queryByText("Stop")).not.toBeNull());
  expect(screen.queryByText("Resume")).toBeNull();
});
