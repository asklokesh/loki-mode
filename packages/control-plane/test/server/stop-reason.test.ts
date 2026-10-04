// RELEASE-11 A4b: the run's Why comes from the terminal stop reason, never from verify failures; the own-rules block (FC-19) is flagged.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../../src/server/app.ts";

const load = (p: string) => readFileSync(join(import.meta.dir, p), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const detail = async (events: any[]) => {
  const { app } = createApp({ dbPath: ":memory:" });
  await app.request("/v1/ingest", { method: "POST", body: JSON.stringify({ source: "abcdef0123456789", run_id: events[0].run, events }) });
  return (await (await app.request(`/v1/runs/abcdef0123456789/${events[0].run}`)).json()) as any;
};

test("fea1 (SPEC_CONFLICT): stop reason is one clean sentence about the conflict, flagged as an own-rules block", async () => {
  const d = await detail(load("../fixtures/compat/10.9.1-fea1/events.jsonl"));
  expect(d.stop_reason).toMatch(/^The run stopped on a spec conflict: /);
  expect(d.stop_reason).not.toMatch(/\u001b|\[\d+m|vitest|Failed Suites/);
  expect(d.stop_reason.split("\n").length).toBe(1);
  expect(d.own_rules_block).toBe(true);
});

test("a FAILED run with no verify event says where it failed, never that verification failed", async () => {
  const d = await detail(load("../fixtures/runs/failed/events.jsonl"));
  expect(d.stop_reason).toMatch(/^The run failed in the verify stage: empty diff without an already_done marker/);
  expect(d.own_rules_block).toBe(false);
});

test("a verified run has no stop reason", async () => {
  const d = await detail(load("../fixtures/runs/verified/events.jsonl"));
  expect(d.stop_reason).toBeNull();
  expect(d.own_rules_block).toBe(false);
});
