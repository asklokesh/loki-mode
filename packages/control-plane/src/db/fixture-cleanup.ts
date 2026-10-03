// One-time cleanup of fixture runs that earlier test suites leaked into real control DBs (FC-07b).
// Runs at CP start. A marker audit row makes it run once per DB; every removal is audited first, in the same transaction.
import { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { sep } from "node:path";
import { audit } from "./prune.ts";

export const FIXTURE_REPO = "acme/widget";
const DONE = "fixture.cleanup.done";

const tempRoots = (): string[] => {
  const roots = new Set<string>(["/tmp", "/private/tmp", "/var/tmp", tmpdir()]);
  for (const r of [...roots]) { try { roots.add(realpathSync(r)); } catch { /* absent */ } }
  return [...roots].map((r) => r.replace(/[\\/]+$/, "")).filter((r) => r.length > 1);
};

const underTemp = (p: string, roots: string[]): boolean => roots.some((r) => p === r || p.startsWith(r + sep) || p.startsWith(r + "/"));

/** Removes leaked fixture runs once per DB. Returns the number of runs removed (0 on every later start). */
export function cleanupLeakedFixtures(sqlite: Database): number {
  let removed = 0;
  sqlite.transaction(() => {
    if (sqlite.query("select 1 x from audit where action = ?").get(DONE)) return;
    const roots = tempRoots();
    const tempSources = new Set(
      (sqlite.query("select source_id, realpath from local_repos").all() as { source_id: string; realpath: string }[])
        .filter((r) => underTemp(r.realpath, roots)).map((r) => r.source_id),
    );
    const all = sqlite.query("select source_id, run_id, origin_repo from runs").all() as { source_id: string; run_id: string; origin_repo: string | null }[];
    const doomed = all.filter((r) => r.origin_repo === FIXTURE_REPO || tempSources.has(r.source_id));
    const touched = new Set<string>();
    for (const k of doomed) {
      const ev = (sqlite.query("select count(*) n from events where source_id = ? and run_id = ?").get(k.source_id, k.run_id) as { n: number }).n;
      audit(sqlite, "fixture.cleanup", "startup", { source_id: k.source_id, run_id: k.run_id, origin_repo: k.origin_repo, events: ev });
      sqlite.query("delete from events where source_id = ? and run_id = ?").run(k.source_id, k.run_id);
      sqlite.query("delete from runs where source_id = ? and run_id = ?").run(k.source_id, k.run_id);
      touched.add(k.source_id);
      removed++;
    }
    for (const id of touched) {
      sqlite.query("delete from sources where id = ? and not exists (select 1 from runs where source_id = ?) and not exists (select 1 from events where source_id = ?)").run(id, id, id);
    }
    audit(sqlite, DONE, "startup", { removed });
  }).immediate();
  return removed;
}
