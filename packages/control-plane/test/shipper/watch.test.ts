// CP-INGEST Wall check: a run whose events exist before startup is visible after startup, and an event appended later is ingested.
import { afterAll, expect, test } from "bun:test";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents } from "../../../../loki-ts/src/engine10/events.ts";
import { ingestAndWatch } from "../../src/shipper/watch.ts";
import { stubServer } from "./stub.ts";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

test("pre-existing run is ingested at startup and a later appended event is tailed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cpingest-"));
  const home = mkdtempSync(join(tmpdir(), "cpingest-home-"));
  roots.push(dir, home);
  const runDir = join(dir, ".loki", "runs", "verified");
  mkdirSync(runDir, { recursive: true });
  cpSync(join(import.meta.dir, "..", "fixtures", "runs", "verified"), runDir, { recursive: true });
  const f = join(runDir, "events.jsonl");
  const before = readEvents(f);
  expect(before.length).toBeGreaterThan(0);
  const srv = stubServer();
  const w = await ingestAndWatch({ repoDir: dir, url: srv.url, env: { HOME: home }, intervalMs: 50 });
  try {
    expect(srv.events.size).toBe(before.length); // visible right after startup
    const last = before[before.length - 1]!;
    const next = { ...last, seq: last.seq + 1, id: `${last.id}-later` };
    appendFileSync(f, JSON.stringify(next) + "\n");
    const deadline = Date.now() + 5000;
    while (srv.events.size < before.length + 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(srv.events.size).toBe(before.length + 1);
    expect(readFileSync(join(runDir, "ship.json"), "utf8")).toContain(String(next.seq));
  } finally { w.stop(); srv.stop(); }
});
