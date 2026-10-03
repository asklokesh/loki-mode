// FC-07b: leaked fixture runs are removed once per DB at CP start, audited, and real runs are never touched.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/migrate.ts";
import { createApp } from "../../src/server/app.ts";

const run = (s: Database, src: string, id: string, repo: string | null) => {
  s.query("insert or ignore into sources (id, first_seen, last_seen) values (?, 't', 't')").run(src);
  s.query("insert into runs (source_id, run_id, origin_repo, partial_usd, measured_sessions, total_sessions, input_tokens, output_tokens, last_seq, tampered) values (?, ?, ?, 0, 0, 0, 0, 0, 0, 0)").run(src, id, repo);
  s.query("insert into events (source_id, run_id, seq, ts, type, stage, data, line_sha256, received_at) values (?, ?, 0, 't', 'run.started', null, '{}', 'x', 't')").run(src, id);
};
type Database = import("bun:sqlite").Database;

function seed(path: string) {
  const { sqlite } = openDb(path);
  run(sqlite, "aaaaaaaaaaaaaaaa", "e10-t1", "acme/widget");
  run(sqlite, "aaaaaaaaaaaaaaaa", "e10-t2", "acme/widget");
  run(sqlite, "bbbbbbbbbbbbbbbb", "tmp-run", null);
  sqlite.query("insert into local_repos (source_id, realpath, name, discovered_at) values (?, ?, 'x', 't')").run("bbbbbbbbbbbbbbbb", join(tmpdir(), "somefixture"));
  run(sqlite, "cccccccccccccccc", "real-1", "acme/real");
  sqlite.query("insert into local_repos (source_id, realpath, name, discovered_at) values (?, '/Users/someone/code/real', 'real', 't')").run("cccccccccccccccc");
  sqlite.close();
}

const count = (path: string, sql: string): number => {
  const { sqlite } = openDb(path);
  const n = (sqlite.query(sql).get() as { n: number }).n;
  sqlite.close();
  return n;
};

test("first start removes fixture runs and audits each; second start removes nothing; real runs untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-fixclean-"));
  const path = join(dir, "control.db");
  try {
    seed(path);
    createApp({ dbPath: path });
    expect(count(path, "select count(*) n from runs where run_id in ('e10-t1','e10-t2','tmp-run')")).toBe(0);
    expect(count(path, "select count(*) n from events where run_id in ('e10-t1','e10-t2','tmp-run')")).toBe(0);
    expect(count(path, "select count(*) n from audit where action = 'fixture.cleanup'")).toBe(3);
    expect(count(path, "select count(*) n from audit where action = 'fixture.cleanup.done'")).toBe(1);
    expect(count(path, "select count(*) n from runs where run_id = 'real-1'")).toBe(1);
    expect(count(path, "select count(*) n from events where run_id = 'real-1'")).toBe(1);
    expect(count(path, "select count(*) n from sources where id in ('aaaaaaaaaaaaaaaa','bbbbbbbbbbbbbbbb')")).toBe(0);

    // A fixture-looking row appearing later is not touched: the marker makes this once per DB.
    const { sqlite } = openDb(path);
    run(sqlite, "dddddddddddddddd", "late", "acme/widget");
    sqlite.close();
    createApp({ dbPath: path });
    expect(count(path, "select count(*) n from runs where run_id = 'late'")).toBe(1);
    expect(count(path, "select count(*) n from audit where action = 'fixture.cleanup'")).toBe(3);
    expect(count(path, "select count(*) n from audit where action = 'fixture.cleanup.done'")).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
