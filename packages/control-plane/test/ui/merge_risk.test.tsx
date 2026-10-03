// CPE-25/26: the Merge queue page needs an explicit confirm before a real merge; the PR risk page reads "not measured" on any failure.
import "./dom";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const merge = await import("../../ui/src/pages/merge/index");
const risk = await import("../../ui/src/pages/risk/index");

type Call = { path: string; method: string; body: string | undefined };
let seen: Call[] = [];
let handler: (c: Call) => Response = () => new Response("{}", { status: 404 });
beforeEach(() => {
  seen = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const c = { path: String(url), method: init?.method ?? "GET", body: init?.body as string | undefined };
    seen.push(c);
    return handler(c);
  }) as unknown as typeof fetch;
});
afterEach(cleanup);
afterAll(() => { globalThis.fetch = realFetch; });

test("page exports", () => {
  expect(merge.page).toMatchObject({ id: "merge", path: "/merge" });
  expect(risk.page).toMatchObject({ id: "risk", path: "/risk" });
});

const mergeHandler = (c: Call) => {
  if (c.path.startsWith("/v1/merge/queue") && c.method === "GET") return new Response(JSON.stringify({ measured: true, queue: [12, 40] }));
  if (c.path === "/v1/merge/run") return new Response(JSON.stringify({ ok: true, ran: true, dryRun: JSON.parse(c.body!).dryRun, exit: 0, lines: ["#12: checks green, would merge (squash)"] }));
  return new Response("{}", { status: 404 });
};

test("queue renders, add accepts digits only, preview posts dryRun:true", async () => {
  handler = mergeHandler;
  render(<merge.MergePage />);
  await waitFor(() => screen.getByText("PR #12"));
  const input = screen.getByLabelText("PR number") as HTMLInputElement;
  fireEvent.input(input, { target: { value: "1a;2" } });
  expect(input.value).toBe("12");
  fireEvent.input(input, { target: { value: "" } });
  expect((screen.getByText("Add") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByText("Preview"));
  await waitFor(() => screen.getByText(/would merge/));
  const runs = seen.filter((c) => c.path === "/v1/merge/run");
  expect(runs.map((c) => JSON.parse(c.body!))).toEqual([{ dryRun: true }]);
});

test("a real merge needs an explicit confirm step, and cancel sends nothing", async () => {
  handler = mergeHandler;
  render(<merge.MergePage />);
  await waitFor(() => screen.getByText("PR #12"));
  fireEvent.click(screen.getByRole("button", { name: "Merge queue" }));
  expect(seen.filter((c) => c.path === "/v1/merge/run").length).toBe(0);
  fireEvent.click(screen.getByText("Cancel"));
  expect(seen.filter((c) => c.path === "/v1/merge/run").length).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "Merge queue" }));
  fireEvent.click(screen.getByText("Confirm merge"));
  await waitFor(() => screen.getByText("Merge result"));
  expect(seen.filter((c) => c.path === "/v1/merge/run").map((c) => JSON.parse(c.body!))).toEqual([{ dryRun: false }]);
});

test("a queue that cannot be read is not measured and offers no merge", async () => {
  handler = () => new Response(JSON.stringify({ measured: false, error: "loki merge list exited 3", queue: [] }));
  render(<merge.MergePage />);
  await waitFor(() => screen.getByText("Queue not measured"));
  expect((screen.getByRole("button", { name: "Merge queue" }) as HTMLButtonElement).disabled).toBe(true);
});

test("risk shows the score and per-factor breakdown", async () => {
  handler = () => new Response(JSON.stringify({ measured: true, score: 42, level: "medium", source: "PR #9", files: 3, factors: [{ factor: "size", points: 4, max: 20, detail: "100 changed lines" }] }));
  render(<risk.RiskPage />);
  fireEvent.input(screen.getByLabelText("PR number"), { target: { value: "9" } });
  fireEvent.click(screen.getByText("Measure risk"));
  await waitFor(() => screen.getByText("42/100"));
  expect(screen.getByText("medium")).toBeTruthy();
  expect(screen.getByText("4/20")).toBeTruthy();
  expect(seen[0]!.path).toBe("/v1/review/risk?pr=9");
});

test("risk failure and an unusable response read not measured, never 0", async () => {
  handler = () => new Response(JSON.stringify({ measured: false, reason: "output was not a risk report" }));
  render(<risk.RiskPage />);
  fireEvent.input(screen.getByLabelText("PR number"), { target: { value: "9" } });
  fireEvent.click(screen.getByText("Measure risk"));
  await waitFor(() => screen.getByText("Risk score: not measured"));
  expect(screen.queryByText("0/100")).toBeNull();
  cleanup();
  handler = () => new Response("garbage", { status: 500 });
  render(<risk.RiskPage />);
  fireEvent.input(screen.getByLabelText("PR number"), { target: { value: "9" } });
  fireEvent.click(screen.getByText("Measure risk"));
  await waitFor(() => screen.getByText("Risk score: not measured"));
});
