// CPE-POLISH item 7: a skipped stage carries the engine's recorded reason through the run detail; no reason stays null (the view says so, nothing is invented).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../../src/server/app.ts";

const base = readFileSync(join(import.meta.dir, "../fixtures/runs/verified/events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).slice(0, 3);
const ev = (seq: number, type: string, stage: string, data: unknown) => ({ v: 1, seq, ts: `2026-10-01T15:55:09.${seq}00Z`, run: base[0].run, type, stage, data });

test("run detail stages expose the skip reason from stage.skipped; missing reason is null", async () => {
  const { app } = createApp({ dbPath: ":memory:" });
  const events = [
    ...base,
    ev(3, "stage.started", "plan", { target_s: 45, limit_s: 90 }),
    ev(4, "stage.skipped", "plan", { size: "small", reason: "small task: implementer plans" }),
    ev(5, "stage.started", "wall", { target_s: 45, limit_s: 90 }),
    ev(6, "stage.skipped", "wall", {}),
  ];
  await app.request("/v1/ingest", { method: "POST", body: JSON.stringify({ source: "abcdef0123456789", run_id: base[0].run, events }) });
  const d = (await (await app.request(`/v1/runs/abcdef0123456789/${base[0].run}`)).json()) as any;
  const by = (n: string) => d.stages.find((s: any) => s.stage === n);
  expect(by("plan")).toMatchObject({ status: "skipped", reason: "small task: implementer plans" });
  expect(by("wall")).toMatchObject({ status: "skipped", reason: null });
  expect(by("intake").reason).toBeNull();
});
