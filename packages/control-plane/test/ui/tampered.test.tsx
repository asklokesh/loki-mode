// CPE-27: a tampered run renders TAMPERED everywhere and is never counted as verified (Engine Laws L3, L7).
import "./dom";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const realFetch = globalThis.fetch;
const { cleanup, render, screen, within } = await import("@testing-library/react");
const { effectiveVerdict, isVerified, VERDICT_TONE } = await import("../../ui/src/design/primitives");
const { RunsPage } = await import("../../ui/src/pages/runs");
const { rollupByRepo } = await import("../../ui/src/pages/runs/logic");
const { RunThread } = await import("../../ui/src/pages/run");
const { HomeView } = await import("../../ui/src/pages/home/Home");
const { Receipts } = await import("../../ui/src/pages/receipts/Receipts");
const { columnOf } = await import("../../ui/src/pages/board/columns");
const { verifiedTrend } = await import("../../ui/src/pages/receipts/api");

const row = (o: Record<string, unknown>) => ({
  source_id: "s1", run_id: "t1", origin_repo: "o/x", issue_ref: null, task_source: "text", provider: "claude", model: "sonnet",
  started_at: "2026-10-03T10:00:00Z", ended_at: "2026-10-03T10:05:00Z", verdict: "VERIFIED", pr_url: null, pr_draft: null, cost_usd: 1, partial_usd: 0,
  measured_sessions: 1, total_sessions: 1, input_tokens: null, output_tokens: null, wall_s: 300, last_seq: 3, last_event_at: null,
  tampered: true, conflict: false, status: "completed", ...o,
}) as import("../../ui/src/api").RunRow;
const tampered = row({});
const clean = row({ run_id: "ok1", tampered: false });

beforeAll(() => {
  (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE = "";
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    if (u.endsWith("/verify")) return new Response(JSON.stringify({ run: "t1", verdict: "VERIFIED", reasons: [], receipt_sha256: null, verified_at: "x" }));
    if (u.startsWith("/v1/keys")) return new Response("{}", { status: 404 });
    if (u.endsWith("/v1/runs/s1/t1")) return new Response(JSON.stringify({ ...tampered, stages: [], stages_completed: [], receipt: { sha256: "ab", signed: true, verdict: "VERIFIED", path: null }, not_proven: [] }));
    if (u.includes("/events")) return new Response(JSON.stringify({ events: [] }));
    if (u.startsWith("/v1/runs")) return new Response(JSON.stringify({ runs: [tampered, clean], total: 2, next_cursor: null }));
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
});
afterEach(cleanup);
afterAll(() => { globalThis.fetch = realFetch; });

test("effectiveVerdict: any tamper or integrity signal wins over the stored verdict", () => {
  expect(effectiveVerdict(tampered)).toBe("TAMPERED");
  expect(effectiveVerdict({ verdict: "VERIFIED", integrity: "TAMPERED" })).toBe("TAMPERED");
  expect(effectiveVerdict({ verdict: "VERIFIED", receipt: { verdict: "TAMPERED" } })).toBe("TAMPERED");
  expect(effectiveVerdict(clean)).toBe("VERIFIED");
  expect(effectiveVerdict({ verdict: null })).toBeNull();
  expect(isVerified(tampered)).toBe(false);
  expect(VERDICT_TONE.TAMPERED).toBe("error");
});

test("runs list shows TAMPERED and the rollup does not count it as verified", async () => {
  render(<RunsPage subscribe={null} />);
  const rows = await screen.findAllByTestId("run-row");
  const t = rows.find((r) => r.getAttribute("data-run") === "t1")!;
  expect(within(t).getByText("TAMPERED")).toBeTruthy();
  expect(within(t).queryByText("VERIFIED")).toBeNull();
  expect(rollupByRepo([tampered, clean])[0]!.verified).toBe(1);
});

test("run page shows TAMPERED", async () => {
  render(<RunThread source="s1" run="t1" />);
  await screen.findByTestId("run-elapsed");
  expect(screen.getByTestId("run-outcome").textContent).toBe("Tampered");
  expect(screen.queryByText("Verified")).toBeNull();
});

test("home shows TAMPERED in recent runs", () => {
  const stats = { since: null, runs_total: 1, runs_finished: 1, runs_running: 0, by_verdict: { TAMPERED: 1 }, blocked_waiting: 0, verified_rate: 0, cost: { measured_usd: null, measured_runs: 0, partial_usd: null, partial_runs: 0, label: "not measured" }, receipts: { total: 0, signed: 0 } };
  render(<HomeView data={{ today: stats as never, week: stats as never, runs: [tampered as never], blocked: [], blockedTotal: 0 }} />);
  expect(screen.getByText("TAMPERED")).toBeTruthy();
  expect(screen.queryByText("VERIFIED")).toBeNull();
});

test("receipts list shows TAMPERED and the rate excludes it", async () => {
  render(<Receipts />);
  await screen.findAllByTestId("verify-btn");
  expect(screen.getAllByText("TAMPERED").length).toBe(1);
  expect(screen.getByText("50%")).toBeTruthy();
  expect(verifiedTrend([{ started_at: "2026-10-03T10:00:00Z", verdict: "VERIFIED", tampered: true }])[0]!.rate).toBe(0);
});

test("board puts a tampered run in not proven", () => { expect(columnOf(tampered)).toBe("notproven"); });

test("guard: no .tsx under ui/src outside primitives renders a verdict string directly", () => {
  const root = join(import.meta.dir, "../../ui/src");
  const files: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".tsx")) files.push(p); } };
  walk(root);
  const bad: string[] = [];
  const VERDICTS = "VERIFIED|NOT_VERIFIED|TAMPERED|PARTIAL|FAILED|SPEC_CONFLICT";
  const re = new RegExp(`["'\`](?:${VERDICTS})["'\`]|>\\s*(?:${VERDICTS})\\s*<`);
  for (const f of files) {
    const rel = relative(root, f);
    if (rel.startsWith("design/primitives")) continue;
    readFileSync(f, "utf8").split("\n").forEach((l, i) => { if (re.test(l)) bad.push(`${rel}:${i + 1}: ${l.trim().slice(0, 100)}`); });
  }
  expect(bad).toEqual([]);
});
