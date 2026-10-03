// D1 (FC-06 class): a FINISHED run's page loads its stored events through the real server, never "No events yet".
// The page used to request events?after=-1, which the server answered 400, so the log stayed empty for every completed run.
import "./dom";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const realFetch = globalThis.fetch;
const { cleanup, render, screen, waitFor } = await import("@testing-library/react");
const { createApp } = await import("../../src/server/app.ts");
const { RunThread } = await import("../../ui/src/pages/run");
const { fetchEvents } = await import("../../ui/src/pages/run/stream");

const SRC = "abcdef0123456789";
const events = readFileSync(join(import.meta.dir, "../fixtures/runs/verified-pr/events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

beforeAll(() => { (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE = ""; });
afterEach(cleanup);
afterAll(() => { globalThis.fetch = realFetch; });

async function serve() {
  const { app } = createApp({ dbPath: ":memory:" });
  await app.request("/v1/ingest", { method: "POST", body: JSON.stringify({ source: SRC, run_id: events[0].run, events }) });
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("/stream")) return new Response("", { status: 404 }); // a finished run has nothing live to follow
    return app.request(String(url), init);
  }) as unknown as typeof fetch;
}

test("fetchEvents returns every stored event of a finished run", async () => {
  await serve();
  const got = await fetchEvents(SRC, events[0].run);
  expect(got.length).toBe(events.length);
  expect(got[0]!.seq).toBe(0);
  expect((await fetchEvents(SRC, events[0].run, 28)).map((e) => e.seq)).toEqual([29, 30, 31]);
});

test("a completed run page shows its stored timeline, not No events yet", async () => {
  await serve();
  render(<RunThread source={SRC} run={events[0].run} />);
  const tl = await screen.findByTestId("run-timeline");
  await waitFor(() => expect(tl.textContent).not.toContain("No events yet"));
  expect(tl.textContent).toContain("implement");
  expect(tl.textContent).toContain("VERIFIED");
});
