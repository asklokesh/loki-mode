// CP-03 Wall check: the Runs list and detail views render the section 4 JSON captured from the CP-00 corpus.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const realFetch = globalThis.fetch;
GlobalRegistrator.register();
const { cleanup, render, screen, waitFor, within } = await import("@testing-library/react");
const { RunDetail, RunsList } = await import("../../ui/src/App");

const FIX = join(import.meta.dir, "fixtures");
const load = (f: string) => JSON.parse(readFileSync(join(FIX, f), "utf8"));
const expected = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/EXPECTED.json"), "utf8")) as {
  run_count: number;
  runs: Record<string, { verdict: string; cost_usd: number | null; not_proven: string[]; pr_url: string | null }>;
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
afterAll(async () => { await GlobalRegistrator.unregister(); globalThis.fetch = realFetch; });

test("runs list: row count and verdict badges equal EXPECTED.json", async () => {
  serve({ "/v1/runs": load("runs.json") });
  render(<RunsList />);
  const rows = await screen.findAllByTestId("run-row");
  expect(rows.length).toBe(expected.run_count);
  const shown = rows.map((r) => within(r).getByTestId("verdict").textContent).sort();
  expect(shown).toEqual(Object.values(expected.runs).map((r) => r.verdict).sort());
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

test("empty DB shows 'No runs ingested yet' and how to connect", async () => {
  serve({ "/v1/runs": load("empty.json") });
  render(<RunsList />);
  expect(await screen.findByText("No runs ingested yet")).toBeTruthy();
  expect(screen.getByText("LOKI_CONTROL_URL")).toBeTruthy();
  expect(screen.getByText("loki control backfill")).toBeTruthy();
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
