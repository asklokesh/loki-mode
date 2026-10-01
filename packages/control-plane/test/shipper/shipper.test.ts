// CP-02 Wall check: backfill the CP-00 corpus into a stub /v1/ingest; a kill mid-batch then a rerun delivers every event exactly once;
// a planted token never appears in a posted body; ship.json advances.
import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents } from "../../../../loki-ts/src/engine10/events.ts";
import { backfill } from "../../src/shipper/backfill.ts";
import { backoffMs, sourceId } from "../../src/shipper/ship.ts";
import { createApp } from "../../src/server/app.ts";
import { stubServer } from "./stub.ts";

const CORPUS = join(import.meta.dir, "..", "fixtures", "runs");
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const TOKEN = "ghp_" + "A1b2C3d4E5".repeat(3) + "abcdef"; // ghp_ + 36 chars

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cp02-"));
  roots.push(dir);
  mkdirSync(join(dir, ".loki"), { recursive: true });
  cpSync(CORPUS, join(dir, ".loki", "runs"), { recursive: true });
  const f = join(dir, ".loki", "runs", "verified", "events.jsonl"); // plant a token in the verified run's first event
  const lines = readFileSync(f, "utf8").split("\n");
  const e = JSON.parse(lines[0]!);
  e.data.note = `token ${TOKEN} here`;
  lines[0] = JSON.stringify(e);
  writeFileSync(f, lines.join("\n"));
  return dir;
}
const total = (dir: string): number =>
  readdirSync(join(dir, ".loki", "runs")).reduce((n, r) => n + readEvents(join(dir, ".loki", "runs", r, "events.jsonl")).length, 0); // valid envelopes only: the tampered run holds one non-envelope line
const env = (url: string): NodeJS.ProcessEnv => ({ LOKI_CONTROL_URL: url });

test("backfill ships every corpus event exactly once, redacted, and ship.json advances", async () => {
  const dir = repo(), srv = stubServer();
  try {
    const r = await backfill({ repoDir: dir, env: env(srv.url) });
    expect(r.failed).toEqual([]);
    expect(r.runs).toBe(8);
    expect(srv.events.size).toBe(total(dir));
    expect(srv.bodies.join("")).not.toContain(TOKEN);
    expect(srv.bodies.join("")).toContain("[REDACTED:GITHUB_TOKEN]");
    const ship = JSON.parse(readFileSync(join(dir, ".loki", "runs", "verified", "ship.json"), "utf8"));
    expect(ship.url).toBe(srv.url);
    expect(ship.acked_seq).toBeGreaterThan(0);
    const before = srv.posts();
    expect((await backfill({ repoDir: dir, env: env(srv.url) })).sent).toBe(0); // acked: nothing re-sent
    expect(srv.posts()).toBe(before);
    expect([...srv.events.keys()][0]!.startsWith(sourceId(dir) + ":")).toBe(true);
  } finally { srv.stop(); }
});

test("killed after the server stored a batch but before the ack: rerun delivers each event exactly once", async () => {
  const dir = repo(), srv = stubServer();
  try {
    let calls = 0;
    const dying: typeof fetch = (async (u: unknown, i: unknown) => {
      const res = await fetch(u as string, i as RequestInit); // the server stores it
      if (++calls === 3) throw new Error("killed mid-batch"); // the ack is lost
      return res;
    }) as typeof fetch;
    const first = await backfill({ repoDir: dir, env: env(srv.url), fetchImpl: dying, attempts: 1 });
    expect(first.failed.length).toBe(1);
    expect(existsSync(join(dir, ".loki", "runs", first.failed[0]!, "ship.json"))).toBe(false); // no ack, no cursor
    const second = await backfill({ repoDir: dir, env: env(srv.url) });
    expect(second.failed).toEqual([]);
    expect(srv.events.size).toBe(total(dir)); // exactly once at the server (the resend was a duplicate no-op)
    expect(srv.bodies.join("")).not.toContain(TOKEN);
  } finally { srv.stop(); }
});

test("a server that is down fails every run without throwing; backoff grows to a 60s cap", async () => {
  const dir = repo();
  const r = await backfill({ repoDir: dir, env: env("http://127.0.0.1:1"), attempts: 2, sleep: async () => {} });
  expect(r.failed.length).toBe(8);
  expect(backoffMs(1, () => 0)).toBe(1000);
  expect(backoffMs(3, () => 0)).toBe(4000);
  expect(backoffMs(30, () => 0)).toBe(60000);
});

test("LOKI_CONTROL_URL unset: no network, no ship.json", async () => {
  const dir = repo(), srv = stubServer();
  try {
    expect(await backfill({ repoDir: dir, env: {} })).toEqual({ runs: 0, sent: 0, failed: [] });
    expect(srv.posts()).toBe(0);
    expect(existsSync(join(dir, ".loki", "runs", "verified", "ship.json"))).toBe(false);
  } finally { srv.stop(); }
});

test("real CP-01 service: the whole corpus lands (tampered forgery skipped and counted), a rerun is all duplicates", async () => {
  const dir = repo(), { app, close } = createApp({ dbPath: ":memory:" });
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  try {
    const url = `http://127.0.0.1:${srv.port}`;
    const r = await backfill({ repoDir: dir, env: env(url) });
    expect(r.failed).toEqual([]);
    expect(r.sent).toBe(total(dir));
    const list = (await (await fetch(`${url}/v1/runs?limit=100`)).json()) as { runs?: unknown[] };
    expect((list.runs ?? (list as unknown as unknown[])).length).toBe(8);
    const ship = JSON.parse(readFileSync(join(dir, ".loki", "runs", "tampered", "ship.json"), "utf8"));
    expect(ship.skipped).toBe(1);
    rmSync(join(dir, ".loki", "runs", "tampered", "ship.json"));
    expect((await backfill({ repoDir: dir, env: env(url) })).failed).toEqual([]); // resend: duplicates, not errors
  } finally { srv.stop(true); close(); }
});
