// CP-ASK slice 4: migration 0005 adds the Ask tables and leaves every existing row untouched.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/migrate.ts";

const DRIZZLE = join(import.meta.dir, "../../drizzle");

/** A migrations folder holding only 0000..0004, to build a db that sits at 0004. */
function folderAt0004(root: string): string {
  const dir = join(root, "drizzle-0004");
  mkdirSync(join(dir, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 4);
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify(journal));
  for (const e of journal.entries) cpSync(join(DRIZZLE, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  return dir;
}

// Columns a later additive migration (0006 token_sessions) may add are excluded so the 0004 rows are compared as seeded.
const dump = (s: Database, table: string, order: string) => JSON.stringify(
  (s.query(`select * from ${table} order by ${order}`).all() as Record<string, unknown>[]).map(({ token_sessions: _t, ...rest }) => rest),
);
const cols = (s: Database, table: string) => (s.query(`pragma table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

function tmp<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "ask-schema-"));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("migrating a db at 0004 keeps seeded runs, events and sources rows byte-equal", () => tmp((root) => {
  const path = join(root, "old.db");
  const old = new Database(path, { create: true });
  migrate(drizzle(old), { migrationsFolder: folderAt0004(root) });
  expect(old.query("select name from sqlite_master where name = 'ask_threads'").all()).toEqual([]);
  old.query("insert into sources (id, first_seen, last_seen) values ('aaaaaaaaaaaaaaaa', 't0', 't1')").run();
  old.query("insert into runs (source_id, run_id, origin_repo, partial_usd, measured_sessions, total_sessions, input_tokens, output_tokens, last_seq, tampered) values ('aaaaaaaaaaaaaaaa', 'r1', 'acme/w', 1.5, 1, 2, 10, 20, 1, 0)").run();
  for (let i = 0; i < 3; i++) {
    old.query("insert into events (source_id, run_id, seq, ts, type, stage, data, line_sha256, received_at) values ('aaaaaaaaaaaaaaaa', 'r1', ?, 't', 'run.started', null, '{\"k\":1}', 'x', 't')").run(i);
  }
  old.query("insert into actions (ts, actor, kind, result) values ('t', 'me', 'start', 'ok')").run();
  const before = [dump(old, "sources", "id"), dump(old, "runs", "run_id"), dump(old, "events", "seq"), dump(old, "actions", "id")];
  old.close();

  const { sqlite } = openDb(path);
  const after = [dump(sqlite, "sources", "id"), dump(sqlite, "runs", "run_id"), dump(sqlite, "events", "seq"), dump(sqlite, "actions", "id")];
  expect(after).toEqual(before);
  expect(before[2]).toContain("\"seq\":2");
  expect(cols(sqlite, "ask_threads").length).toBeGreaterThan(0);
  sqlite.close();
}));

test("the three ask tables exist with the planned columns and indexes", () => {
  const { sqlite } = openDb(":memory:");
  expect(cols(sqlite, "ask_threads")).toEqual(["id", "created_at", "updated_at", "repo", "provider", "model", "title"]);
  expect(cols(sqlite, "ask_messages")).toEqual(["id", "thread_id", "seq", "role", "text", "status", "worker_pid", "pgid", "cost_usd", "error", "started_at", "finished_at"]);
  expect(cols(sqlite, "ask_events")).toEqual(["id", "message_id", "seq", "kind", "payload", "ts"]);
  const idx = (t: string) => (sqlite.query(`pragma index_list(${t})`).all() as { name: string }[]).map((i) => i.name);
  expect(idx("ask_messages")).toContain("ask_messages_status");
  expect(idx("ask_messages")).toContain("ask_messages_thread_seq");
  expect(idx("ask_events")).toContain("ask_events_message_seq");
  sqlite.close();
});

test("a duplicate (thread_id, seq) or (message_id, seq) is rejected", () => {
  const { sqlite } = openDb(":memory:");
  sqlite.query("insert into ask_threads (id, created_at, updated_at, provider) values ('t1', 't', 't', 'claude')").run();
  const msg = (id: string, seq: number) => sqlite.query("insert into ask_messages (id, thread_id, seq, role, text, status) values (?, 't1', ?, 'user', 'q', 'queued')").run(id, seq);
  msg("m1", 0);
  expect(() => msg("m2", 0)).toThrow(/UNIQUE/i);
  msg("m3", 1);
  const ev = (id: string, seq: number) => sqlite.query("insert into ask_events (id, message_id, seq, kind, payload, ts) values (?, 'm1', ?, 'delta', '{}', 't')").run(id, seq);
  ev("e1", 0);
  expect(() => ev("e2", 0)).toThrow(/UNIQUE/i);
  sqlite.close();
});

test("a fresh db migrates cleanly to 0005 and re-opening is idempotent", () => tmp((root) => {
  const path = join(root, "fresh.db");
  openDb(path).sqlite.close();
  const { sqlite } = openDb(path);
  const n = sqlite.query("select count(*) as n from __drizzle_migrations").get() as { n: number };
  expect(n.n).toBe(7);
  sqlite.close();
}));
