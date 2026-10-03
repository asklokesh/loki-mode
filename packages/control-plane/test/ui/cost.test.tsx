// CPE-13: the cost page keeps measured, partial and unmeasured explicit and shows the budget banner.
import "./dom";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
const { cleanup, render, screen } = await import("@testing-library/react");
const { CostPage, page } = await import("../../ui/src/pages/cost/index");

const row = (o: Record<string, unknown>) => ({ runs: 1, measured_runs: 0, partial_runs: 0, unmeasured_runs: 0, measured_usd: 0, partial_usd: 0, input_tokens: 0, output_tokens: 0, ...o });
const body = {
  group: ["day"], since: null,
  rows: [row({ day: "2026-10-03", unmeasured_runs: 1 }), row({ day: "2026-10-02", runs: 2, measured_runs: 1, partial_runs: 1, measured_usd: 1.5, partial_usd: 0.25, input_tokens: 1500, output_tokens: 15 })],
  totals: row({ runs: 3, measured_runs: 1, partial_runs: 1, unmeasured_runs: 1, measured_usd: 1.5, partial_usd: 0.25, input_tokens: 1500, output_tokens: 15 }),
  budget: { api_key_default_cap_usd: 100, subscription_cap: null, api_key_runs: 2, subscription_runs: 1 },
};

beforeAll(() => { (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE = ""; });
afterEach(cleanup);
afterAll(() => { globalThis.fetch = realFetch; });

test("page export is wired for the registry", () => {
  expect(page).toMatchObject({ id: "cost", path: "/cost", title: "Cost and usage" });
});

test("measured, partial and unmeasured are separate; unmeasured is never a dollar zero", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
  render(<CostPage />);
  expect((await screen.findByTestId("cost-measured")).textContent).toBe("$1.50");
  expect(screen.getByTestId("cost-partial").textContent).toBe("$0.25");
  expect(screen.getByTestId("cost-unmeasured").textContent).toBe("1 runs");
  expect(screen.getByTestId("cost-tokens").textContent).toBe("1,500 / 15");
  expect(screen.getAllByText("1 not measured")).toHaveLength(1);
  expect(screen.getByText("$0.25 (partial)")).toBeTruthy();
  expect(screen.getAllByTestId("cost-bar")).toHaveLength(2);
});

test("budget banner: subscription reads no cap, API-key shows the cap", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
  render(<CostPage />);
  expect((await screen.findByTestId("cost-budget-subscription")).textContent).toContain("no cap");
  expect(screen.getByTestId("cost-budget-api").textContent).toContain("$100.00 cap per run");
});

test("an HTTP error shows an unavailable state, not zeros", async () => {
  globalThis.fetch = (async () => new Response("x", { status: 500 })) as unknown as typeof fetch;
  render(<CostPage />);
  expect(await screen.findByText("Cost unavailable")).toBeTruthy();
});
