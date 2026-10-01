// CP-RELAND live view: a partial run (events before run.completed) reports running, stage, elapsed and files; the rest completes it.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../../src/server/app.ts";

const evs = readFileSync(join(import.meta.dir, "../fixtures/runs/verified-pr/events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const SRC = "abcdef0123456789";
const run = evs[0].run as string;
const { app } = createApp({ dbPath: ":memory:" });
const post = (events: unknown[]) => app.request("/v1/ingest", { method: "POST", body: JSON.stringify({ source: SRC, run_id: run, events }) });
const detail = async () => (await (await app.request(`/v1/runs/${SRC}/${run}`)).json()) as any;

test("first 24 events: running, current stage commit, elapsed, files touched, no PR yet", async () => {
  expect((await post(evs.slice(0, 24))).status).toBe(200);
  const d = await detail();
  expect(d).toMatchObject({ status: "running", current_stage: "commit", files_touched: ["calc.ts"], verdict: null, ended_at: null, pr_url: null });
  expect(d.elapsed_s).toBeGreaterThan(0);
  const list = (await (await app.request("/v1/runs")).json()) as any;
  expect(list.runs[0]).toMatchObject({ status: "running", current_stage: "commit", files_touched: ["calc.ts"] });
});

test("pr.opened arrives mid-run: PR link is reported while still running", async () => {
  expect((await post(evs.slice(24, 29))).status).toBe(200);
  const d = await detail();
  expect(d.status).toBe("running");
  expect(d.pr_url).toBe(evs[28].data.url);
});

test("the rest arrives: completed with a verdict", async () => {
  expect((await post(evs.slice(29))).status).toBe(200);
  const d = await detail();
  expect(d).toMatchObject({ status: "completed", verdict: "VERIFIED", current_stage: null });
  expect(d.ended_at).not.toBeNull();
});
