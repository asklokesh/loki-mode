// CP follow-ups: changed files from the receipt range, the Why line, structured receipt rows, the right column, and the repo chip.
import "./dom";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { RunThread } = await import("../../ui/src/pages/run");
const { Composer } = await import("../../ui/src/pages/compose");
const { whyLine, changedFilesFor } = await import("../../ui/src/pages/run/model");
const { receiptFacts } = await import("../../ui/src/pages/run/facts");
const { outcome } = await import("../../ui/src/pages/home/cardtext");

const STAT = { base: "b".repeat(40), head: "a".repeat(40), files: [{ path: "src/x.ts", added: 5, removed: 2 }, { path: "logo.png", added: null, removed: null }], added: 5, removed: 2 };
const detail = (o: Record<string, unknown> = {}) => ({
  source_id: "s1", run_id: "r1", origin_repo: "o/r", issue_ref: "o/r#17", title: "Fix it", task_source: "issue", provider: "claude", model: "sonnet",
  started_at: "2026-10-03T10:00:00Z", ended_at: "2026-10-03T10:05:00Z", verdict: "PARTIAL", attested: true, sig_checked: true, pr_url: null, pr_draft: null,
  cost_usd: 1, partial_usd: 0, measured_sessions: 1, total_sessions: 1, wall_s: 300, last_seq: 3, tampered: false, conflict: false, status: "completed",
  files_touched: [], diff_stat: STAT, stages: [], stages_completed: [], receipt: { sha256: "ab".repeat(32), signed: true, verdict: "PARTIAL", path: null }, not_proven: ["full suite"], ...o,
});
const EVENTS = [
  { seq: 1, ts: "2026-10-03T10:00:00Z", type: "test.result", stage: "verify", data: { name: "bun:backend/tests/unit/validation.test.ts", result: "fail", first_error: "failed to load (Failed Suites 1)" } },
  { seq: 2, ts: "2026-10-03T10:01:00Z", type: "stage.completed", stage: "fix", data: { round: 1, killed: true } },
  { seq: 3, ts: "2026-10-03T10:02:00Z", type: "stage.completed", stage: "fix", data: { round: 2, killed: true } },
];
const RECEIPT = JSON.stringify({ verdict: "PARTIAL", diff_sha256: "d".repeat(64), base_sha: "b".repeat(40), head_sha: "a".repeat(40), checks: [{ result: "pass" }, { result: "pass" }, { result: "fail" }, { result: "not_run" }] });

function serve(d: unknown, events: unknown[] = EVENTS, repoInfo: unknown = { repos: ["alpha"], default_repo: "lokimode-anthropic" }) {
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    if (u.endsWith("/v1/runs/s1/r1")) return new Response(JSON.stringify(d));
    if (u.includes("/events")) return new Response(JSON.stringify({ events }));
    if (u.endsWith("/artifact/receipt.json")) return new Response(RECEIPT);
    if (u.endsWith("/artifact/receipt.md")) return new Response("# raw receipt text");
    if (u.startsWith("/v1/repos")) return new Response(JSON.stringify(repoInfo));
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
}
beforeAll(() => { (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE = ""; });
afterEach(cleanup);
afterAll(() => { globalThis.fetch = realFetch; });

test("1: a committed run with no patch shows files and counts from the receipt range, binary without counts", async () => {
  serve(detail());
  render(<RunThread source="s1" run="r1" />);
  await waitFor(() => expect(screen.getAllByTestId("changed-file")).toHaveLength(2));
  const t = screen.getByTestId("run-diff").textContent ?? "";
  expect(t).toContain("src/x.ts");
  expect(t).toContain("2 files, +5 -2");
  expect(t).toContain("binary");
  expect(screen.queryByTestId("changed-files-unmeasured")).toBeNull();
  expect(changedFilesFor(null, null)).toBeNull();
});

test("1: with no patch and no range the section still says unmeasured", async () => {
  serve(detail({ diff_stat: null }));
  render(<RunThread source="s1" run="r1" />);
  await waitFor(() => expect(screen.getByTestId("changed-files-unmeasured").textContent).toContain("unmeasured"));
});

test("1: the home card counts files from diff_stat", () => {
  const row = { source_id: "s", run_id: "r", verdict: "VERIFIED", attested: true, sig_checked: true, tampered: false, files_touched: [], diff_stat: STAT, cost_usd: 1, wall_s: 5 } as never;
  expect(outcome(row)[1]).toStartWith("2 files touched, +5 -2");
  expect(outcome({ ...(row as object), diff_stat: null } as never)[1]).toStartWith("files unmeasured");
});

test("2: the Why is the terminal stop reason; the verify failures sit behind Show raw; a VERIFIED run has no Why line", async () => {
  serve(detail({ verdict: "FAILED", stop_reason: "The run failed in the verify stage: empty diff." }));
  render(<RunThread source="s1" run="r1" />);
  await waitFor(() => expect(screen.getByTestId("run-why").textContent).toBe("Why: The run failed in the verify stage: empty diff."));
  expect(screen.queryByTestId("run-why-raw")).toBeNull();
  fireEvent.click(screen.getByTestId("run-why-raw-toggle"));
  expect(screen.getByTestId("run-why-raw").textContent).toContain("verify: bun:backend/tests/unit/validation.test.ts failed to load (Failed Suites 1)");
  expect(screen.getByTestId("run-why-raw").textContent).toContain("2 fix rounds hit time limits");
  cleanup();
  serve(detail({ verdict: "VERIFIED" }));
  render(<RunThread source="s1" run="r1" />);
  await screen.findByTestId("run-thread");
  expect(screen.queryByTestId("run-why")).toBeNull();
  cleanup();
  serve(detail({ verdict: "FAILED" }), []);
  render(<RunThread source="s1" run="r1" />);
  await screen.findByTestId("run-thread");
  expect(screen.queryByTestId("run-why")).toBeNull();
});

test("2: whyLine uses the last result per check and stage failure reasons", () => {
  const ev = [
    { type: "test.result", stage: "verify", data: { name: "a", result: "fail", first_error: "boom" } },
    { type: "test.result", stage: "verify", data: { name: "a", result: "pass" } },
    { type: "stage.failed", stage: "verify", data: { reason: "empty diff without an already_done marker" } },
  ];
  expect(whyLine(ev)).toBe("verify: empty diff without an already_done marker");
  expect(whyLine([])).toBeNull();
});

test("3: receipt facts render as rows, and the raw text is behind Show raw", async () => {
  serve(detail());
  render(<RunThread source="s1" run="r1" />);
  await waitFor(() => expect(screen.getByTestId("rr-checks").textContent).toContain("4 run: 2 passed, 1 failed, 1 not run"));
  expect(screen.getByTestId("rr-verdict").textContent).toContain("receipt says Partly verified");
  expect(screen.getByTestId("rr-diff").textContent).toContain("d".repeat(16));
  expect(screen.getByTestId("rr-base").textContent).toContain("b".repeat(12));
  expect(screen.getByTestId("rr-head").textContent).toContain("a".repeat(12));
  expect(screen.getByTestId("rr-sig").textContent).toEndWith("signed, signature checked");
  expect(screen.queryByTestId("receipt-raw")).toBeNull();
  fireEvent.click(screen.getByTestId("receipt-raw-toggle"));
  await waitFor(() => expect(screen.getByTestId("receipt-raw").textContent).toContain("raw receipt text"));
});

test("3: an unreachable receipt file is said so (never unmeasured); unchecked signature is stated", async () => {
  expect(receiptFacts("not json")).toBeNull();
  expect(receiptFacts("{}")?.checks).toBeNull();
  serve(detail({ sig_checked: false, diff_stat: null }));
  globalThis.fetch = ((orig) => (async (u: string) => (String(u).endsWith("receipt.json") ? new Response("nope", { status: 404 }) : orig(u))) as unknown as typeof fetch)(globalThis.fetch);
  render(<RunThread source="s1" run="r1" />);
  await screen.findByTestId("run-thread");
  expect(screen.getByTestId("rr-sig").textContent).toEndWith("signed, signature not checked");
  await waitFor(() => expect(screen.getByTestId("rr-checks").textContent).toEndWith("0 passed, 1 failed"));
  expect(screen.getByTestId("rr-diff").textContent).toEndWith("receipt file not reachable from this Control Plane");
  expect(screen.getByTestId("run-receipt").textContent).not.toContain("unmeasured");
});

test("4: NOT PROVEN and the pull request sit in the right column, above the terminal panel", async () => {
  serve(detail());
  render(<RunThread source="s1" run="r1" />);
  const aside = await screen.findByTestId("run-aside");
  expect(aside.contains(screen.getByTestId("run-not-proven"))).toBe(true);
  expect(aside.contains(screen.getByTestId("run-pr"))).toBe(true);
  const panel = screen.getByTestId("run-panel");
  expect(screen.getByTestId("run-summary").compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("5: the composer repo chip shows the server directory folder name and keeps the picker", async () => {
  serve(detail());
  render(<Composer />);
  await waitFor(() => expect(screen.getByTestId("chip-repo").textContent).toContain("lokimode-anthropic"));
  fireEvent.click(screen.getByTestId("chip-repo").querySelector("button")!);
  expect((await screen.findAllByRole("menuitem")).map((m) => m.textContent)).toEqual(["lokimode-anthropic (server directory)", "alpha"]);
  cleanup();
  serve(detail(), [], { repos: [] });
  render(<Composer />);
  await waitFor(() => expect(screen.getByTestId("no-repos")).toBeTruthy());
  expect(screen.getByTestId("chip-repo").textContent).toContain("server directory");
});
