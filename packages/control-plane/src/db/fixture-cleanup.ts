// One-time cleanup of fixture runs that earlier test suites leaked into real control DBs (FC-07b).
// Runs at CP start. A marker audit row makes it run once per DB; every removal is audited first, in the same transaction.
import { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { audit } from "./prune.ts";

export const FIXTURE_REPO = "acme/widget";
const DONE = "fixture.cleanup.v2.done"; // v2 (R2, A3b/A3f): also origin_repo-null test rows, runs in HOME or a non-repo dir, and FAILED runs with no run dir
/** Run ids that only test suites write (e37-cline/codex/aider, e10-sig, e10-sg1/sg2). */
export const TEST_RUN_ID = /^(e37-|e10-sig|e10-sg)/;

export const tempRoots = (): string[] => {
  const roots = new Set<string>(["/tmp", "/private/tmp", "/var/tmp", tmpdir()]);
  for (const r of [...roots]) { try { roots.add(realpathSync(r)); } catch { /* absent */ } }
  return [...roots].map((r) => r.replace(/[\\/]+$/, "")).filter((r) => r.length > 1);
};

export const underTemp = (p: string, roots: string[]): boolean => roots.some((r) => p === r || p.startsWith(r + sep) || p.startsWith(r + "/"));

/** Removes leaked fixture runs once per DB. Returns the number of runs removed (0 on every later start). */
export function cleanupLeakedFixtures(sqlite: Database, rootsOverride?: string[]): number {
  let removed = 0;
  sqlite.transaction(() => {
    if (sqlite.query("select 1 x from audit where action = ?").get(DONE)) return;
    const roots = rootsOverride ?? tempRoots();
    const tempSources = new Set(
      (sqlite.query("select source_id, realpath from local_repos").all() as { source_id: string; realpath: string }[])
        .filter((r) => underTemp(r.realpath, roots)).map((r) => r.source_id),
    );
    const repos = new Map((sqlite.query("select source_id, realpath from local_repos").all() as { source_id: string; realpath: string }[]).map((r) => [r.source_id, r.realpath]));
    const real = (p: string): string => { try { return realpathSync(p); } catch { return p; } };
    const home = real(process.env.HOME || homedir());
    const isGit = (p: string): boolean => { for (let d = p; d !== "/" && d !== home && d !== join(d, ".."); d = join(d, "..")) if (existsSync(join(d, ".git"))) return true; return false; };
    // A3f: a run that started in HOME or a non-repo dir (the composer once started "whats going on so far" in HOME), or FAILED with no run dir on disk.
    const badRun = (r: { source_id: string; run_id: string; verdict: string | null }): boolean => {
      const rp = repos.get(r.source_id);
      if (!rp || !existsSync(rp)) return false;
      const dir = real(rp);
      if (dir === home || dir === "/" || !isGit(dir)) return true;
      return r.verdict === "FAILED" && !existsSync(join(dir, ".loki", "runs", r.run_id));
    };
    const all = sqlite.query("select source_id, run_id, origin_repo, verdict from runs").all() as { source_id: string; run_id: string; origin_repo: string | null; verdict: string | null }[];
    const doomed = all.filter((r) => r.origin_repo === FIXTURE_REPO || tempSources.has(r.source_id) || (r.origin_repo === null && TEST_RUN_ID.test(r.run_id)) || badRun(r));
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
