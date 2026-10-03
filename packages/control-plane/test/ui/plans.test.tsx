// CPE-17: traceability matrix. A criterion with no passing linked check reads NOT PROVEN, never green.
import "./dom";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
const { cleanup, render, screen } = await import("@testing-library/react");
const { Plans } = await import("../../ui/src/pages/plans/Plans");
const { page, pickerPage } = await import("../../ui/src/pages/plans/index");
const { buildMatrix, criteriaOf, diffFiles } = await import("../../ui/src/pages/plans/logic");

const ISSUE = { title: "Calc", body: "Intro\n## Acceptance criteria\n- add returns the sum\n- divide rejects zero\n" };
const PLAN = { steps: ["Implement add in calc.ts", "Guard divide in calc.ts"] };
const DIFF = "diff --git a/src/calc.ts b/src/calc.ts\n--- a/src/calc.ts\n+++ b/src/calc.ts\n@@\n+x\n";
const RECEIPT = { verdict: "VERIFIED", checks: [{ name: "add returns the sum", cmd: "bun test", result: "pass" }], wall: { files: [] } };

function serve(over: Record<string, string | null> = {}) {
  const art: Record<string, string | null> = { "issue.json": JSON.stringify(ISSUE), "plan.json": JSON.stringify(PLAN), "receipt.json": JSON.stringify(RECEIPT), "diff.patch": DIFF, ...over };
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    const m = /\/artifact\/(.+)$/.exec(u);
    if (m) { const v = art[m[1]!]; return v == null ? new Response("{}", { status: 404 }) : new Response(v); }
    if (/\/v1\/runs\/s1\/r1$/.test(u)) return new Response(JSON.stringify({ stages: [{ stage: "plan", started_at: null, ended_at: null, status: "completed" }] }));
    if (u.startsWith("/v1/runs")) return new Response(JSON.stringify({ runs: [{ source_id: "s1", run_id: "r1", verdict: "VERIFIED", started_at: "2026-10-01T10:00:00Z" }], total: 1, next_cursor: null }));
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
}

beforeAll(() => { (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE = ""; });
afterEach(cleanup);
afterAll(() => { globalThis.fetch = realFetch; });

test("page export shape", () => {
  expect(page.path).toBe("/plans/:source/:run");
  expect(pickerPage.path).toBe("/plans");
});

test("criteria parse from an acceptance section, falling back to the title", () => {
  expect(criteriaOf(ISSUE).list).toEqual(["add returns the sum", "divide rejects zero"]);
  expect(criteriaOf({ title: "Only a title", body: "" })).toEqual({ list: ["Only a title"], source: "title" });
  expect(diffFiles(DIFF)).toEqual(["src/calc.ts"]);
});

test("proven only with a passing linked check; a criterion without evidence is not proven", () => {
  const m = buildMatrix({ issue: ISSUE, plan: PLAN, receipt: RECEIPT, changedFiles: ["src/calc.ts"] });
  expect(m.rows.map((r) => r.status)).toEqual(["proven", "not proven"]);
  expect(m.rows[1]!.note).toContain("no check linked");
});

test("a passing check matched by keyword only stays NOT PROVEN (link inferred)", async () => {
  const receipt = { verdict: "VERIFIED", checks: [{ name: "returns suite", cmd: "bun test sum", result: "pass" }] };
  const m = buildMatrix({ issue: ISSUE, plan: PLAN, receipt, changedFiles: [] });
  expect(m.rows[0]!.status).toBe("not proven");
  expect(m.rows[0]!.note).toBe("link inferred");
  expect(m.rows[0]!.inferred.length).toBe(1);
  const named = buildMatrix({ issue: ISSUE, plan: { steps: [{ title: "Implement returns", checks: ["returns suite"] }] }, receipt, changedFiles: [] });
  expect(named.rows[0]!.status).toBe("proven");
  serve({ "receipt.json": JSON.stringify(receipt) });
  render(<Plans params={{ source: "s1", run: "r1" }} />);
  expect((await screen.findAllByTestId("row-status"))[0]!.textContent).toContain("NOT PROVEN (link inferred)");
  expect(screen.getAllByTestId("inferred-hint").length).toBeGreaterThan(0);
});

test("a non-VERIFIED receipt never yields proven, and no receipt is all not proven", () => {
  expect(buildMatrix({ issue: ISSUE, plan: PLAN, receipt: { ...RECEIPT, verdict: "PARTIAL" }, changedFiles: [] }).rows[0]!.status).toBe("not proven");
  expect(buildMatrix({ issue: ISSUE, plan: PLAN, receipt: null, changedFiles: [] }).rows.every((r) => r.status === "not proven")).toBe(true);
  const failed = buildMatrix({ issue: ISSUE, plan: PLAN, receipt: { verdict: "FAILED", checks: [{ name: "divide rejects zero", result: "fail" }] }, changedFiles: [] });
  expect(failed.rows[1]!.status).toBe("failed");
});

test("renders the matrix with NOT PROVEN rows highlighted", async () => {
  serve();
  render(<Plans params={{ source: "s1", run: "r1" }} />);
  const cells = await screen.findAllByTestId("row-status");
  expect(cells.map((c) => c.getAttribute("data-status"))).toEqual(["proven", "not proven"]);
  expect(cells[1]!.textContent).toContain("NOT PROVEN");
  expect(screen.getByTestId("plans-summary").textContent).toContain("1 of 2 criteria proven");
  expect(screen.getAllByText("src/calc.ts").length).toBeGreaterThan(0);
});

test("missing receipt and plan read as not available, every row not proven", async () => {
  serve({ "receipt.json": null, "plan.json": null });
  render(<Plans params={{ source: "s1", run: "r1" }} />);
  const cells = await screen.findAllByTestId("row-status");
  expect(cells.every((c) => c.getAttribute("data-status") === "not proven")).toBe(true);
  expect(screen.getByTestId("plans-missing").textContent).toContain("receipt.json");
  expect(screen.getByTestId("plans-summary").textContent).toContain("no receipt");
});

test("run picker links to the matrix", async () => {
  serve();
  render(<Plans params={{}} />);
  const a = await screen.findByTestId("plans-pick");
  expect(a.getAttribute("href")).toBe("#/plans/s1/r1");
});
