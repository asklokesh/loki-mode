// Session card grid: outcome lines from real fields, NEEDS INPUT with an inline answer, Recent and Groups tabs, search, filter, "unmeasured" for gaps.
import "./dom";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const realFetch = globalThis.fetch;
const { cleanup, fireEvent, render, screen, waitFor, within } = await import("@testing-library/react");
const { CardsView } = await import("../../ui/src/pages/home/Cards");
const { outcome, timeAgo, matches, groupByRepo } = await import("../../ui/src/pages/home/cardtext");

const base = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/runs.json"), "utf8")).runs[0] as Record<string, unknown>;
const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const run = (id: string, extra: Record<string, unknown> = {}) =>
  ({ ...base, run_id: id, title: `title ${id}`, started_at: iso(60_000), last_event_at: iso(60_000), origin_repo: "acme/calc", verdict: "VERIFIED", attested: true, sig_checked: true, tampered: false, pr_url: null, files_touched: ["a.ts", "b.ts"], cost_usd: 0.5, wall_s: 90, ...extra }) as never;

let answers: { url: string; body: unknown }[] = [];
beforeAll(() => {
  (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE = "";
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === "POST") { answers.push({ url: u, body: JSON.parse(String(init.body)) }); return new Response(JSON.stringify({ path: "p", resume: "r" })); }
    if (u.endsWith("/blk")) return new Response(JSON.stringify({ blocked_question: "Which database?" }));
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
});
afterEach(() => { cleanup(); answers = []; });
afterAll(() => { globalThis.fetch = realFetch; });

test("outcome lines are plain English from real fields and read unmeasured for gaps", () => {
  expect(outcome(run("a"))[0]).toBe("Done: the change was verified.");
  expect(outcome(run("a"))[1]).toBe("2 files touched, $0.50, 1m 30s");
  const gap = outcome(run("g", { files_touched: undefined, cost_usd: null, partial_usd: null, wall_s: null }));
  expect(gap[1]).toBe("files unmeasured, cost unmeasured, unmeasured");
  expect(outcome(run("e", { files_touched: [] }))[1]).toStartWith("files unmeasured");
  expect(outcome(run("f", { verdict: "FAILED" }))[0]).toStartWith("Failed:");
  expect(outcome(run("b"), "Which database?")[0]).toBe("Blocked: needs answer. Which database?");
  expect(outcome(run("b"), null)[0]).toContain("question unmeasured");
  expect(outcome(run("r", { verdict: null, current_stage: null, elapsed_s: null }))[0]).toBe("Running: stage unmeasured");
  expect(timeAgo(null, NOW)).toBe("time unmeasured");
  expect(timeAgo(iso(3 * 3_600_000), NOW)).toBe("3h ago");
});

test("card shows title, outcome, verdict, PR and receipt badges, repo and time-ago", () => {
  render(<CardsView runs={[run("one", { pr_url: "https://github.com/o/r/pull/1", pr_draft: true })]} blocked={[]} now={NOW} />);
  const c = screen.getByTestId("session-card");
  expect(within(c).getByTestId("card-title").textContent).toBe("title one");
  expect(within(c).getByTestId("card-outcome").textContent).toContain("Done: the change was verified.");
  expect(c.textContent).toContain("VERIFIED");
  expect(within(c).getByTestId("badge-pr").textContent).toBe("Draft PR");
  expect(within(c).getByTestId("badge-receipt").textContent).toBe("Receipt signed");
  expect(c.textContent).toContain("acme/calc");
  expect(c.textContent).toContain("1m ago");
  expect(c.getAttribute("href")).toContain("#/runs/");
});

test("a finished run without attestation data reads receipt unmeasured, no PR badge without a PR", () => {
  render(<CardsView runs={[run("x", { attested: undefined, origin_repo: null })]} blocked={[]} now={NOW} />);
  expect(screen.getByTestId("badge-receipt").textContent).toBe("receipt unmeasured");
  expect(screen.queryByTestId("badge-pr")).toBeNull();
  expect(screen.getByTestId("session-card").textContent).toContain("repo unmeasured");
});

test("NEEDS INPUT pins blocked runs and answers inline through the answer route", async () => {
  const blocked = [{ id: "n", kind: "blocked", ts: "", source_id: base.source_id as string, run_id: "blk", title: "t", link: "" }];
  render(<CardsView runs={[run("blk", { verdict: "SPEC_CONFLICT" }), run("ok")]} blocked={blocked} now={NOW} />);
  const section = screen.getByTestId("needs-input");
  expect(section.textContent).toContain("NEEDS INPUT (1)");
  await waitFor(() => expect(within(section).getByTestId("card-outcome").textContent).toContain("Which database?"));
  expect(screen.getAllByTestId("session-card").length).toBe(2); // blocked card is pinned, not repeated in the grid
  fireEvent.input(within(section).getByTestId("answer-input"), { target: { value: "postgres" } });
  fireEvent.click(within(section).getByTestId("answer-send"));
  await waitFor(() => expect(answers.length).toBe(1));
  expect(answers[0]!.url).toContain("/blk/answer");
  expect(answers[0]!.body).toEqual({ answer: "postgres" });
  expect((await screen.findByTestId("answer-sent")).textContent).toContain("Answer saved");
});

test("no NEEDS INPUT section when nothing is blocked", () => {
  render(<CardsView runs={[run("ok")]} blocked={[]} now={NOW} />);
  expect(screen.queryByTestId("needs-input")).toBeNull();
});

test("Recent groups by Today and Earlier; Groups tab groups by repo", () => {
  const runs = [run("new"), run("old", { started_at: "2020-01-01T00:00:00Z", last_event_at: "2020-01-01T00:00:00Z", origin_repo: "acme/api" })];
  render(<CardsView runs={runs} blocked={[]} now={NOW} />);
  expect(screen.getAllByTestId("card-group").map((g) => g.getAttribute("aria-label"))).toEqual(["Today", "Earlier"]);
  fireEvent.click(screen.getByTestId("tab-groups"));
  expect(screen.getAllByTestId("card-group").map((g) => g.getAttribute("aria-label"))).toEqual(["acme/calc", "acme/api"]);
  expect(groupByRepo([run("u", { origin_repo: null })])[0]!.repo).toBe("repo unmeasured");
});

test("search and filter narrow the grid", () => {
  const runs = [run("alpha"), run("beta", { verdict: "FAILED" }), run("gamma", { verdict: null })];
  render(<CardsView runs={runs} blocked={[]} now={NOW} />);
  expect(screen.getAllByTestId("session-card").length).toBe(3);
  fireEvent.input(screen.getByTestId("card-search"), { target: { value: "bet" } });
  expect(screen.getAllByTestId("session-card").length).toBe(1);
  fireEvent.input(screen.getByTestId("card-search"), { target: { value: "" } });
  fireEvent.click(screen.getByTestId("filter-running"));
  expect(screen.getAllByTestId("session-card").map((c) => c.textContent).join("")).toContain("title gamma");
  expect(screen.getAllByTestId("session-card").length).toBe(1);
  fireEvent.input(screen.getByTestId("card-search"), { target: { value: "zzz" } });
  expect(screen.getByTestId("cards-empty").textContent).toBe("No sessions match.");
  expect(matches(run("a"), "", "FAILED")).toBe(false);
});

test("receipt badge shows Receipt signed only when the signature was checked", () => {
  const text = (extra: Record<string, unknown>) => {
    const { unmount } = render(<CardsView runs={[run("s", extra)]} blocked={[]} now={NOW} />);
    const out = screen.getByTestId("badge-receipt").textContent;
    unmount();
    return out;
  };
  expect(text({ attested: true, sig_checked: true })).toBe("Receipt signed");
  expect(text({ attested: true, sig_checked: false })).toBe("Receipt unchecked");
  expect(text({ attested: true, sig_checked: undefined })).toBe("receipt unmeasured");
});
