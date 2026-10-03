// local_repos: the server-side map from source_id to a real repo path. Filled only by local discovery (never by /v1/ingest);
// the path never leaves the server. The API exposes display names only.
import { basename, resolve } from "node:path";
import type { Hono } from "hono";
import type { Db } from "../db/migrate.ts";
import { localRepos } from "../db/schema.ts";
import { discoverLocalRepos } from "../shipper/discover.ts";

/** Upsert every locally discovered repo. Returns the number of repos known. */
export function syncLocalRepos(db: Db, repoDir: string, env: NodeJS.ProcessEnv = process.env): number {
  const now = new Date().toISOString();
  const found = discoverLocalRepos(repoDir, env);
  for (const r of found) {
    db.insert(localRepos).values({ sourceId: r.sourceId, realpath: r.realpath, name: r.name, discoveredAt: now })
      .onConflictDoUpdate({ target: localRepos.sourceId, set: { realpath: r.realpath, name: r.name } }).run();
  }
  return found.length;
}

/** Display names only, sorted and de-duplicated. */
export function repoNames(db: Db): string[] {
  return [...new Set(db.select({ name: localRepos.name }).from(localRepos).all().map((r) => r.name))].sort();
}

/** GET /v1/repos. `act` is the loopback-only router; `peerIsLoopback` checks the real socket address. */
export function mountRepos(act: Hono, db: Db, peerIsLoopback: (c: Parameters<Parameters<Hono["get"]>[1]>[0]) => boolean, repoDir?: string): void {
  // default_repo is the folder name of the directory the service was launched from (what a run with no repo chip uses); the path itself is never sent.
  const defaultRepo = repoDir ? basename(resolve(repoDir)) || null : null;
  act.get("/v1/repos", (c) => peerIsLoopback(c) ? c.json({ repos: repoNames(db), default_repo: defaultRepo }) : c.json({ error: "loopback only" }, 403));
}
