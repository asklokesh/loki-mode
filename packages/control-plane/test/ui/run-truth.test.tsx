// RELEASE-11 A4b: the run page tells the truth. One run from each of 10.6.x, 10.7.1, 10.9.1 and 10.10.5 plus the real FireLater#17 run (fea1)
// renders with zero ANSI garbage, no enum strings and no false "unmeasured"; the Why comes from the terminal stop reason; an own-rules block offers Retry only.
import "./dom";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { cleanup, render, screen, fireEvent, waitFor } = await import("@testing-library/react");
const { createApp } = await import("../../src/server/app.ts");
const { RunThread } = await import("../../ui/src/pages/run");
const { receiptFacts, evidenceFacts, summaryLine } = await import("../../ui/src/pages/run/facts");
const realFetch = globalThis.fetch;
const fx = (p: string) => readFileSync(join(import.meta.dir, "../fixtures/compat", p), "utf8");
const events = (p: string) => fx(p).trim().split("\n").map((l) => JSON.parse(l));

// Real server projection behind the page; receipt.json is served as the artifact file (or 404 when the CP cannot reach it, as for FireLater).
async function serve(eventsPath: string, receiptPath: string | null, source = "abcdef0123456789") {
  const evs = events(eventsPath);
  const run = evs[0].run as string;
  const { app } = createApp({ dbPath: ":memory:" });
  await app.request("/v1/ingest", { method: "POST", body: JSON.stringify({ source, run_id: run, events: evs }) });
  const posts: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === "POST") { posts.push(u); return new Response(JSON.stringify({ ok: true })); }
    if (u.endsWith("/artifact/receipt.json") && receiptPath) return new Response(fx(receiptPath));
    if (u.includes("/artifact/")) return new Response("nope", { status: 404 });
    if (u.includes("/stream")) return new Response("nope", { status: 404 });
    return app.request(u.replace(/^https?:\/\/[^/]+/, ""));
  }) as unknown as typeof fetch;
  return { source, run, posts };
}

beforeAll(() => { (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE = ""; });
afterEach(cleanup);
afterAll(() => { globalThis.fetch = realFetch; });

const ENUM = /\b(VERIFIED|PARTIAL|FAILED|BLOCKED|SPEC_CONFLICT|ALREADY_SATISFIED|TAMPERED|UNVERIFIED)\b|[A-Z]{3,}_[A-Z_]{3,}|FAILED \(|\u001b|\[\d{1,3}m/;

for (const v of ["10.6.14", "10.7.1", "10.9.1", "10.10.5"]) {
  test(`compat ${v}: receipt facts render from receipt.json, no garbage, no enum, no false unmeasured`, async () => {
    const { source, run } = await serve(`${v}/events.jsonl`, `${v}/receipt.json`);
    render(<RunThread source={source} run={run} />);
    await screen.findByTestId("run-thread");
    const r = JSON.parse(fx(`${v}/receipt.json`));
    await waitFor(() => expect(screen.getByTestId("rr-base").textContent).toContain(String(r.base_sha).slice(0, 12)));
    expect(screen.getByTestId("rr-head").textContent).toContain(String(r.head_sha).slice(0, 12));
    expect(screen.getByTestId("rr-diff").textContent).toContain(String(r.diff_sha256).slice(0, 16));
    expect(screen.getByTestId("rr-checks").textContent).toContain(r.checks.length ? `${r.checks.length} run` : "none recorded");
    for (const id of ["rr-base", "rr-head", "rr-diff", "rr-checks", "rr-verdict"]) expect(screen.getByTestId(id).textContent).not.toContain("unmeasured");
    expect(screen.queryByTestId("not-proven-owner")).toBeNull();
    const text = screen.getByTestId("run-thread").textContent ?? "";
    expect(text).not.toMatch(ENUM);
    expect(screen.getByTestId("run-outcome").textContent).not.toMatch(/_|FAILED|PARTIAL/);
  });
}

test("fea1 (FireLater#17, receipt file out of reach): one clean Why, Needs your answer, own-rules Retry, no reply box, no false unmeasured", async () => {
  const { source, run, posts } = await serve("10.9.1-fea1/events.jsonl", null);
  render(<RunThread source={source} run={run} />);
  await screen.findByTestId("run-thread");
  expect(screen.getByTestId("run-outcome").textContent).toBe("Needs your answer");
  await screen.findByTestId("run-own-rules");
  expect(screen.getByTestId("run-own-rules-text").textContent).toBe("Loki's own rules stopped this run (fixed in 10.10.3). Retry on the latest version.");
  expect(screen.queryByTestId("run-reply")).toBeNull();
  expect(screen.queryByTestId("run-reply-card")).toBeNull();
  const retry = screen.getByTestId("run-own-rules-retry") as HTMLButtonElement;
  fireEvent.click(retry);
  await waitFor(() => expect(posts.some((p) => p.endsWith(`/v1/runs/${source}/${run}/retry`))).toBe(true));
  // evidence comes from the run's own events when the file is out of reach; a field with no source says why, never "unmeasured"
  await waitFor(() => expect(screen.getByTestId("rr-head").textContent).toContain("93c917373d1f"));
  expect(screen.getByTestId("rr-checks").textContent).toMatch(/\d+ run: \d+ passed/);
  expect(screen.getByTestId("rr-diff").textContent).toContain("receipt file not reachable");
  expect(screen.getByTestId("rr-base").textContent).toContain("be0799f0c5eb");
  expect(screen.getByTestId("run-receipt").textContent).not.toContain("unmeasured");
  expect(screen.queryByTestId("not-proven-owner")).toBeNull();
  expect(screen.getByTestId("run-not-proven").textContent).toContain("full suite");
  expect(screen.getByTestId("run-thread").textContent).not.toMatch(ENUM);
  expect(screen.getByTestId("run-pr").textContent).toContain("pull/26");
});

test("a spec conflict that is not an own-rules block keeps the reply box and a clean one-sentence Why behind Show raw", async () => {
  const evs = events("10.9.1-fea1/events.jsonl").filter((e: any) => e.type !== "log.sealed" && e.type !== "receipt.sealed").map((e: any, k: number) => ({ ...e, seq: k }));
  const i = evs.findIndex((e: any) => e.type === "stage.completed" && e.stage === "implement");
  evs[i].data.spec_conflict_reason = "\u001b[31mWhich database should the migration target?\u001b[39m The spec names two.";
  const { app } = createApp({ dbPath: ":memory:" });
  await app.request("/v1/ingest", { method: "POST", body: JSON.stringify({ source: "abcdef0123456789", run_id: evs[0].run, events: evs }) });
  globalThis.fetch = (async (url: string) => String(url).includes("/artifact/") || String(url).includes("/stream") ? new Response("nope", { status: 404 }) : app.request(String(url))) as unknown as typeof fetch;
  render(<RunThread source="abcdef0123456789" run={evs[0].run} />);
  await screen.findByTestId("run-reply-card");
  expect(screen.queryByTestId("run-own-rules")).toBeNull();
  const why = screen.getByTestId("run-why").textContent ?? "";
  expect(why).toContain("Which database should the migration target?");
  expect(why).not.toMatch(/\u001b|\[\d+m/);
  expect(screen.queryByTestId("run-why-raw")).toBeNull();
  fireEvent.click(screen.getByTestId("run-why-raw-toggle"));
  expect(screen.getByTestId("run-why-raw").textContent).toContain("\u001b[31m");
});

test("receipt adapter: aliases and a checks map from an old receipt; a readable receipt lacking a field is unmeasured, an unreachable one is not", () => {
  const old = receiptFacts(JSON.stringify({ result: "PARTIAL", diff_hash: "d".repeat(64), base: "b".repeat(40), head: "h".repeat(40), checks: { a: "passed", b: { status: "failed" }, c: "skipped" } }));
  expect(old).toEqual({ verdict: "PARTIAL", diffSha: "d".repeat(64), base: "b".repeat(40), head: "h".repeat(40), checks: { total: 3, pass: 1, fail: 1, notRun: 1 } });
  expect(receiptFacts("not json")).toBeNull();
  expect(evidenceFacts(JSON.stringify({ verdict: "VERIFIED" }), []).state).toBe("read");
  expect(evidenceFacts(null, []).state).toBe("unreachable");
  expect(evidenceFacts(undefined, []).state).toBe("loading");
});

test("R3 summary: a run that failed with no verify event never says it did not pass verification", () => {
  expect(summaryLine({ verdict: "FAILED", hadVerify: false })).toBe("The run failed before verification ran.");
  expect(summaryLine({ verdict: "FAILED", hadVerify: true })).toBe("The run did not pass verification.");
  expect(summaryLine({ verdict: "FAILED", stop_reason: "The run failed in the verify stage: empty diff." })).toBe("The run failed in the verify stage: empty diff.");
  expect(summaryLine({ verdict: "VERIFIED" })).toBeNull();
});
