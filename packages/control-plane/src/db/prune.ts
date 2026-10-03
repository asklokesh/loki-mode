// Removal of runs from the control DB: shared by `loki control prune` (direct DB) and DELETE /v1/runs/:source/:run (server).
// One transaction deletes the runs, their events, and any source left with neither. An audit row is written first, inside the same transaction.
import { Database } from "bun:sqlite";

export interface PruneFilter { repo?: string; before?: string }
export interface PruneCounts { runs: number; events: number; sources: number }

/** Strict ISO 8601 parse: YYYY-MM-DD or a date-time with an explicit Z/offset. Returns a normalized UTC instant or null. */
export function parseBefore(s: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/.test(s)) return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  // reject rolled-over dates such as 2026-02-31
  if (new Date(`${s.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== s.slice(0, 10)) return null;
  return new Date(t).toISOString();
}

type Key = { source_id: string; run_id: string };

function where(f: PruneFilter): { sql: string; args: string[] } {
  const parts: string[] = [];
  const args: string[] = [];
  if (f.repo !== undefined) { parts.push("origin_repo = ?"); args.push(f.repo); }
  if (f.before !== undefined) { parts.push("started_at IS NOT NULL AND julianday(started_at) < julianday(?)"); args.push(f.before); }
  return { sql: parts.join(" AND "), args };
}

const n = (sqlite: Database, sql: string, ...args: string[]): number => (sqlite.query(sql).get(...args) as { n: number }).n;

/** What deleting these runs would remove: runs, their events, and sources that would be left holding nothing. */
function countFor(sqlite: Database, keys: Key[]): PruneCounts {
  const bySource = new Map<string, string[]>();
  for (const k of keys) bySource.set(k.source_id, [...(bySource.get(k.source_id) ?? []), k.run_id]);
  let events = 0, sources = 0;
  for (const [src, runIds] of bySource) {
    let ev = 0;
    for (const r of runIds) ev += n(sqlite, "select count(*) n from events where source_id = ? and run_id = ?", src, r);
    events += ev;
    const runsLeft = n(sqlite, "select count(*) n from runs where source_id = ?", src) - runIds.length;
    const eventsLeft = n(sqlite, "select count(*) n from events where source_id = ?", src) - ev;
    if (runsLeft <= 0 && eventsLeft <= 0 && sqlite.query("select 1 x from sources where id = ?").get(src)) sources++;
  }
  return { runs: keys.length, events, sources };
}

export function audit(sqlite: Database, action: string, actor: string, detail: unknown): void {
  sqlite.query("insert into audit (ts, action, actor, detail) values (?, ?, ?, ?)").run(new Date().toISOString(), action, actor, JSON.stringify(detail));
}

/** Drops only the given sources, and only when they now hold neither runs nor events (matches what countFor reported). */
const dropOrphanSources = (sqlite: Database, ids: Iterable<string>): void => {
  for (const id of ids) sqlite.query("delete from sources where id = ? and not exists (select 1 from runs where source_id = ?) and not exists (select 1 from events where source_id = ?)").run(id, id, id);
};

/** Read-only handle for dry runs: no migrations, no journal-mode change, no writes. */
export const openReadOnly = (path: string): Database => new Database(path, { readonly: true });

/** Removes the matching runs. dryRun counts only and writes nothing. At least one filter is required. */
export function pruneRuns(sqlite: Database, f: PruneFilter, opts: { dryRun?: boolean; actor?: string } = {}): PruneCounts {
  if (f.repo === undefined && f.before === undefined) throw new Error("prune needs --repo or --before");
  const w = where(f);
  const select = (): Key[] => sqlite.query(`select source_id, run_id from runs where ${w.sql}`).all(...w.args) as Key[];
  if (opts.dryRun) return countFor(sqlite, select());
  let out: PruneCounts = { runs: 0, events: 0, sources: 0 };
  sqlite.transaction(() => {
    const keys = select();
    if (keys.length === 0) return;
    out = countFor(sqlite, keys);
    audit(sqlite, "prune", opts.actor ?? "cli", { filter: f, counts: out });
    for (const k of keys) {
      sqlite.query("delete from events where source_id = ? and run_id = ?").run(k.source_id, k.run_id);
      sqlite.query("delete from runs where source_id = ? and run_id = ?").run(k.source_id, k.run_id);
    }
    dropOrphanSources(sqlite, new Set(keys.map((k) => k.source_id)));
  }).immediate();
  return out;
}

/** Removes one run. Null when it does not exist (nothing audited, nothing deleted). Otherwise the counts removed. */
export function removeRun(sqlite: Database, source: string, run: string, actor = "http"): PruneCounts | null {
  let out: PruneCounts | null = null;
  sqlite.transaction(() => {
    if (!sqlite.query("select 1 x from runs where source_id = ? and run_id = ?").get(source, run)) return;
    out = countFor(sqlite, [{ source_id: source, run_id: run }]);
    audit(sqlite, "run.remove", actor, { source_id: source, run_id: run, counts: out });
    sqlite.query("delete from events where source_id = ? and run_id = ?").run(source, run);
    sqlite.query("delete from runs where source_id = ? and run_id = ?").run(source, run);
    dropOrphanSources(sqlite, [source]);
  }).immediate();
  return out;
}
