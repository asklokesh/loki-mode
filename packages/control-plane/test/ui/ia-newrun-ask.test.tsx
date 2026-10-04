// A4a: New run picker (registered repos, real issues, explicit confirm) and Ask Loki (stream, follow-ups, offers).
import "./dom";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
const { cleanup, fireEvent, render, screen, waitFor, within } = await import("@testing-library/react");
const { NewRunPicker } = await import("../../ui/src/pages/compose");
const { closeNewRun, getNewRun } = await import("../../ui/src/pages/compose/store");
const ask = await import("../../ui/src/pages/ask/api");
const { AskThreadView, Offers } = await import("../../ui/src/pages/ask");

interface Call { url: string; method: string; body: string | null }
let calls: Call[] = [];
function serve(routes: Record<string, (init?: RequestInit) => Response>) {
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : null });
    const key = Object.keys(routes).find((k) => u.split("?")[0] === k);
    return key ? routes[key]!(init) : new Response(JSON.stringify({ error: "nope" }), { status: 404 });
  }) as unknown as typeof fetch;
}
const json = (b: unknown, status = 200) => () => new Response(JSON.stringify(b), { status });
const pick = (el: HTMLElement, v: string) => { fireEvent.input(el, { target: { value: v } }); };
const posts = () => calls.filter((c) => c.method === "POST");

beforeAll(() => { (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE = ""; });
beforeEach(() => { location.hash = ""; closeNewRun(); ask.resetAskState(); });
afterEach(cleanup);
afterAll(() => { globalThis.fetch = realFetch; location.hash = ""; });

const ISSUES = { issues: [{ number: 7, title: "Crash on save", url: "https://github.com/o/alpha/issues/7" }, { number: 8, title: "Slow list", url: "https://github.com/o/alpha/issues/8" }] };

test("picker: registered repos only, real issues, nothing posts until the explicit confirm", async () => {
  serve({ "/v1/repos": json({ repos: ["alpha", "beta"] }), "/v1/repos/issues": json(ISSUES), "/v1/runs": json({ ok: true, pid: 1, command: "x" }) });
  render(<NewRunPicker preset={null} onDone={() => {}} />);
  const sel = await screen.findByTestId("picker-repo");
  expect(within(sel).getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose a registered repo", "alpha", "beta"]);
  pick(sel, "alpha");
  const opts = await screen.findAllByTestId("issue-option");
  expect(opts.length).toBe(2);
  expect(calls.some((c) => c.url.includes("/v1/repos/issues?repo=alpha"))).toBe(true);
  fireEvent.click(opts[0]!);
  fireEvent.click(screen.getByTestId("picker-continue"));
  expect(screen.getByTestId("confirm-text").textContent).toContain("o/alpha#7");
  expect(posts().length).toBe(0);
  fireEvent.click(screen.getByTestId("confirm-start"));
  await waitFor(() => expect(posts().length).toBe(1));
  expect(JSON.parse(posts()[0]!.body!)).toEqual({ target: "o/alpha#7", repo: "alpha" });
});

test("picker: free text never starts a run; Review only moves to the confirm step", async () => {
  serve({ "/v1/repos": json({ repos: ["alpha"] }), "/v1/repos/issues": json({ issues: [] }), "/v1/runs": json({ ok: true, pid: 1, command: "x" }) });
  render(<NewRunPicker preset={null} onDone={() => {}} />);
  pick(await screen.findByTestId("picker-repo"), "alpha");
  expect(await screen.findByTestId("issues-empty")).toBeTruthy();
  expect((screen.getByTestId("picker-continue") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.input(screen.getByLabelText("Task"), { target: { value: "tidy the readme" } });
  fireEvent.click(screen.getByTestId("picker-continue"));
  expect(screen.getByTestId("confirm-step")).toBeTruthy();
  expect(posts().length).toBe(0);
});

test("picker: an issues-route failure is a real error state, not an empty list", async () => {
  serve({ "/v1/repos": json({ repos: ["alpha"] }), "/v1/repos/issues": json({ error: "gh failed" }, 502) });
  render(<NewRunPicker preset={null} onDone={() => {}} />);
  pick(await screen.findByTestId("picker-repo"), "alpha");
  expect((await screen.findByTestId("issues-error")).textContent).toContain("gh failed");
  expect(screen.queryByTestId("issues-empty")).toBeNull();
});

test("picker: an offered ref for a registered repo goes straight to confirm; an unregistered repo is refused", async () => {
  serve({ "/v1/repos": json({ repos: ["alpha"] }), "/v1/runs": json({ ok: true, pid: 1, command: "x" }) });
  const { unmount } = render(<NewRunPicker preset="o/alpha#7" onDone={() => {}} />);
  expect((await screen.findByTestId("confirm-text")).textContent).toContain("o/alpha#7");
  expect(posts().length).toBe(0);
  unmount();
  render(<NewRunPicker preset="o/ghost#7" onDone={() => {}} />);
  expect((await screen.findByTestId("picker-error")).textContent).toContain("not a registered repo");
  expect(posts().length).toBe(0);
});

test("ask api: parseFrames keeps the unfinished tail and decodes every event type", () => {
  const buf = 'event: delta\ndata: {"text":"Hi"}\n\nevent: tool_use\ndata: {"name":"Read"}\n\nevent: result\ndata: {"text":"r","isError":true}\n\nevent: error\ndata: {"message":"m"}\n\nevent: done\ndata: {"status":"done"}\n\nevent: delta\ndata: {"te';
  const { events, rest } = ask.parseFrames(buf);
  expect(events).toEqual([{ type: "delta", text: "Hi" }, { type: "tool_use", name: "Read" }, { type: "result", text: "r", isError: true }, { type: "error", message: "m" }, { type: "done", status: "done" }]);
  expect(rest).toBe('event: delta\ndata: {"te');
});

test("ask api: offersIn finds only the literal offer convention", () => {
  expect(ask.offersIn("Start a run on o/x#4? Also Start a run on o/x#4? and Start a run on a/b#5?")).toEqual(["o/x#4", "a/b#5"]);
  expect(ask.offersIn("I will start a run on o/x#4 now")).toEqual([]);
});

test("offer button only opens the confirm dialog, it never posts", () => {
  serve({});
  render(<Offers text="Start a run on o/alpha#7?" />);
  fireEvent.click(screen.getByTestId("offer-run"));
  expect(getNewRun()).toEqual({ open: true, preset: "o/alpha#7" });
  expect(posts().length).toBe(0);
});

test("ask thread: streams an answer with an offer, then a follow-up posts with the thread id", async () => {
  const sse = 'event: delta\ndata: {"text":"The run failed. "}\n\nevent: delta\ndata: {"text":"Start a run on o/alpha#7?"}\n\nevent: done\ndata: {"status":"done"}\n\n';
  serve({
    "/v1/ask/threads/t1": json({ thread: { id: "t1", title: "Why", repo: null }, messages: [
      { id: "m1", seq: 1, role: "user", text: "why", status: "done", error: null, cost_usd: null },
      { id: "m2", seq: 2, role: "assistant", text: "", status: "streaming", error: null, cost_usd: null }] }),
    "/v1/ask/messages/m2/stream": () => new Response(sse, { headers: { "content-type": "text/event-stream" } }),
    "/v1/ask/threads": json({ threads: [] }),
    "/v1/ask": () => new Response(JSON.stringify({ thread_id: "t1", message_id: "m3" }), { status: 202 }),
  });
  render(<AskThreadView id="t1" />);
  expect(await screen.findByText(/The run failed\./)).toBeTruthy();
  expect(await screen.findByTestId("offer-run")).toBeTruthy();
  await waitFor(() => expect((screen.getByTestId("ask-input") as HTMLTextAreaElement).disabled).toBe(false));
  fireEvent.input(screen.getByTestId("ask-input"), { target: { value: "and now?" } });
  fireEvent.click(screen.getByTestId("ask-send"));
  await waitFor(() => expect(posts().length).toBe(1));
  expect(JSON.parse(posts()[0]!.body!)).toEqual({ question: "and now?", thread_id: "t1" });
  expect(getNewRun().open).toBe(false);
});

test("ask thread: a missing route shows a real error state", async () => {
  serve({});
  render(<AskThreadView id="gone" />);
  expect(await screen.findByText("Could not open this thread")).toBeTruthy();
});
