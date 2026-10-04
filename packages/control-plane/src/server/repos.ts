// local_repos: the server-side map from source_id to a real repo path. Filled only by local discovery (never by /v1/ingest);
// the path never leaves the server. The API exposes display names only.
import { execFile } from "node:child_process";
import { basename, resolve } from "node:path";
import { eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import type { Db } from "../db/migrate.ts";
import { localRepos, runs } from "../db/schema.ts";
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
export type GhRunner = (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
const defaultGh: GhRunner = (argv) => new Promise((done) => {
  execFile("gh", argv, { timeout: 15000, maxBuffer: 2_000_000, shell: false }, (err, stdout, stderr) => {
    done({ code: err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0, stdout: String(stdout), stderr: String(stderr || (err?.message ?? "")) });
  });
});
const OWNER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$/;

/** owner/name of a registered repo (by display name), from the origin_repo its runs recorded. Null when the name is not registered or has no known origin. */
export function registeredOwnerName(db: Db, name: string): string | null {
  for (const r of db.select().from(localRepos).where(eq(localRepos.name, name)).all()) {
    const o = db.select({ o: runs.originRepo }).from(runs).where(eq(runs.sourceId, r.sourceId)).all().map((x) => x.o).find((x): x is string => !!x && OWNER_NAME.test(x));
    if (o) return o;
  }
  return null;
}

export function mountRepos(act: Hono, db: Db, peerIsLoopback: (c: Context) => boolean, repoDir?: string, gh: GhRunner = defaultGh): void {
  act.get("/v1/repos/issues", async (c) => {
    if (!peerIsLoopback(c)) return c.json({ error: "loopback only" }, 403);
    const repo = c.req.query("repo") ?? "";
    const ownerName = repo ? registeredOwnerName(db, repo) : null;
    if (!ownerName) return c.json({ error: "repo is not a registered repo with a known owner/name" }, 400);
    const r = await gh(["issue", "list", "--repo", ownerName, "--state", "open", "--json", "number,title,url", "--limit", "50"]);
    if (r.code !== 0) return c.json({ error: `gh issue list failed: ${r.stderr.trim().slice(0, 300) || `exit ${r.code}`}` }, 502);
    try {
      const j = JSON.parse(r.stdout) as unknown;
      if (!Array.isArray(j)) throw new Error("not an array");
      const issues = j.filter((i): i is { number: number; title: string; url: string } => !!i && Number.isInteger((i as { number?: unknown }).number) && typeof (i as { title?: unknown }).title === "string" && typeof (i as { url?: unknown }).url === "string")
        .map((i) => ({ number: i.number, title: i.title, url: i.url }));
      return c.json({ issues });
    } catch (e) { return c.json({ error: `gh returned unreadable output: ${(e as Error).message}` }, 502); }
  });
  // default_repo is the folder name of the directory the service was launched from (what a run with no repo chip uses); the path itself is never sent.
  const defaultRepo = repoDir ? basename(resolve(repoDir)) || null : null;
  act.get("/v1/repos", (c) => peerIsLoopback(c) ? c.json({ repos: repoNames(db), default_repo: defaultRepo }) : c.json({ error: "loopback only" }, 403));
}
