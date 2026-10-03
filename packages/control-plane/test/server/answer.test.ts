// BLOCKED answer endpoint: validation, run state, and the file it writes.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app.ts";

const FIX = join(import.meta.dir, "../fixtures/runs");
const SRC = "abcdef0123456789";
const dir = mkdtempSync(join(tmpdir(), "cp-answer-"));
const { app } = createApp({ dbPath: ":memory:", answerDir: dir });
const load = async (name: string) => {
  const evs = readFileSync(join(FIX, name, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  await app.request("/v1/ingest", { method: "POST", body: JSON.stringify({ source: SRC, run_id: evs[0].run, events: evs }) });
  return evs[0].run as string;
};
const ans = (run: string, body: unknown, ct = "application/json") => app.request(`/v1/runs/${SRC}/${run}/answer`, { method: "POST", headers: { "content-type": ct }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("blocked run exposes its question and an answer is written to a file", async () => {
  const run = await load("blocked");
  const d = (await (await app.request(`/v1/runs/${SRC}/${run}`)).json()) as any;
  expect(d.blocked_question).toContain("calc.ts");
  const r = await ans(run, { answer: "keep add pure; use a parameter" });
  expect(r.status).toBe(200);
  const j = (await r.json()) as any;
  expect(j.path).toBe(join(dir, SRC, `${run}.answer.txt`));
  expect(readFileSync(j.path, "utf8")).toBe("keep add pure; use a parameter\n");
});

test("validation: empty, too long, bad JSON, wrong content type, bad id, unknown run, not blocked", async () => {
  const run = await load("blocked");
  expect((await ans(run, { answer: "  " })).status).toBe(400);
  expect((await ans(run, { answer: 5 })).status).toBe(400);
  expect((await ans(run, { answer: "x".repeat(4001) })).status).toBe(413);
  expect((await ans(run, "{nope")).status).toBe(400);
  expect((await ans(run, { answer: "x" }, "text/plain")).status).toBe(400);
  expect((await app.request(`/v1/runs/${SRC}/..%2Fevil/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: "x" }) })).status).toBeGreaterThanOrEqual(400);
  expect((await ans("nope-1", { answer: "x" })).status).toBe(404);
  const ok = await load("verified");
  expect((await ans(ok, { answer: "x" })).status).toBe(409);
  expect(existsSync(join(dir, SRC, `${ok}.answer.txt`))).toBe(false);
});

test("cleanup", () => { rmSync(dir, { recursive: true, force: true }); });
