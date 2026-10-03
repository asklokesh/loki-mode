// EL-FC08b B4: migration ordering guard and upgrade path. drizzle's migrator silently SKIPS a migration whose `when` is older than the
// newest applied one, so a numbering or timestamp collision between branches ships a missing column with no error.
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app.ts";

const DRIZZLE = join(import.meta.dir, "../../drizzle");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8")) as { entries: { idx: number; when: number; tag: string }[] };
const tmp = mkdtempSync(join(tmpdir(), "cp-migrations-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test("journal: idx is contiguous, tags are unique and match a .sql file and a numeric prefix, `when` strictly increases in idx order", () => {
  const { entries } = journal;
  expect(entries.map((e) => e.idx)).toEqual(entries.map((_, i) => i));
  expect(new Set(entries.map((e) => e.tag)).size).toBe(entries.length);
  for (const e of entries) {
    expect(e.tag.startsWith(String(e.idx).padStart(4, "0") + "_")).toBe(true);
    expect(existsSync(join(DRIZZLE, `${e.tag}.sql`))).toBe(true);
  }
  for (let i = 1; i < entries.length; i++) expect([entries[i]!.tag, entries[i]!.when > entries[i - 1]!.when]).toEqual([entries[i]!.tag, true]);
});

test("every .sql file in drizzle/ is in the journal (an unjournaled migration never runs)", () => {
  const tags = new Set(journal.entries.map((e) => e.tag));
  for (const f of new Bun.Glob("*.sql").scanSync(DRIZZLE)) expect([f, tags.has(f.replace(/\.sql$/, ""))]).toEqual([f, true]);
});

test("upgrade: a database migrated through main's 0000-0002 gains attested, sig_checked and integrity_reasons, and keeps its rows", async () => {
  const old = join(tmp, "old-drizzle");
  cpSync(DRIZZLE, old, { recursive: true });
  const upto = journal.entries.filter((e) => e.idx <= 2);
  writeFileSync(join(old, "meta/_journal.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8")), entries: upto }, null, 2));
  const dbPath = join(tmp, "upgrade.db");
  const sqlite = new Database(dbPath, { create: true });
  migrate(drizzle(sqlite), { migrationsFolder: old });
  const cols = () => (sqlite.query("pragma table_info(runs)").all() as { name: string }[]).map((c) => c.name);
  expect(cols()).not.toContain("attested");
  sqlite.exec("insert into sources (id, first_seen, last_seen) values ('abcdef0123456789', '2026-10-03T00:00:00Z', '2026-10-03T00:00:00Z')");
  sqlite.exec("insert into runs (source_id, run_id, verdict, partial_usd, measured_sessions, total_sessions, input_tokens, output_tokens, last_seq, tampered) values ('abcdef0123456789', 'legacy-1', 'VERIFIED', 0, 0, 0, 0, 0, 0, 0)");
  sqlite.close();

  const { app } = createApp({ dbPath }); // boot applies 0003 and recomputes legacy rows
  const check = new Database(dbPath, { readonly: true });
  const after = (check.query("pragma table_info(runs)").all() as { name: string }[]).map((c) => c.name);
  expect(after).toEqual(expect.arrayContaining(["attested", "sig_checked", "integrity_reasons"]));
  expect(check.query("select count(*) as n from runs where run_id = 'legacy-1'").get()).toEqual({ n: 1 });
  check.close();
  const detail = (await (await app.request("/v1/runs")).json()) as any;
  expect(detail.runs.length).toBe(1);
});

test("advisory: boot recomputes legacy rows (attested IS NULL) from their stored events", async () => {
  const dbPath = join(tmp, "legacy.db");
  const evs = readFileSync(join(import.meta.dir, "../fixtures/runs/verified/events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const a = createApp({ dbPath });
  await a.app.request("/v1/ingest", { method: "POST", body: JSON.stringify({ source: "abcdef0123456789", run_id: evs[0].run, events: evs }) });
  const raw = new Database(dbPath);
  raw.exec("update runs set attested = null, sig_checked = null, integrity_reasons = null");
  raw.close();
  const b = createApp({ dbPath }); // boot
  const row = ((await (await b.app.request("/v1/runs")).json()) as any).runs[0];
  expect([row.attested, row.tampered, row.effective_verdict]).toEqual([true, false, "VERIFIED (signature not checked)"]);
});

test("journal: every `when` strictly increases and is not later than now (a future stamp makes drizzle skip later migrations)", () => {
  const now = Date.now();
  for (let i = 0; i < journal.entries.length; i++) {
    const e = journal.entries[i]!;
    expect([e.tag, e.when <= now]).toEqual([e.tag, true]);
    if (i > 0) expect([e.tag, e.when > journal.entries[i - 1]!.when]).toEqual([e.tag, true]);
  }
});

test("upgrade: a cpe-base database (0002_cpe03 already created actions and local_repos) migrates to current and keeps its rows", () => {
  const dbPath = join(tmp, "cpe-base.db");
  const sqlite = new Database(dbPath, { create: true });
  migrate(drizzle(sqlite), { migrationsFolder: join(import.meta.dir, "../fixtures/cpe-base-drizzle") });
  sqlite.run("INSERT INTO actions (ts, actor, kind, target, result, detail) VALUES ('2026-10-01T00:00:00Z', 'ui', 'start', 'r1', 'ok', 'kept')");
  sqlite.run("INSERT INTO local_repos (source_id, realpath, name, discovered_at) VALUES ('s1', '/x/y', 'y', '2026-10-01T00:00:00Z')");
  migrate(drizzle(sqlite), { migrationsFolder: DRIZZLE });
  expect(sqlite.query("SELECT detail FROM actions").all()).toEqual([{ detail: "kept" }]);
  expect(sqlite.query("SELECT name FROM local_repos").all()).toEqual([{ name: "y" }]);
  expect(sqlite.query("SELECT 1 FROM pragma_table_info('runs') WHERE name = 'attested'").all().length).toBe(1);
  sqlite.close();
});
