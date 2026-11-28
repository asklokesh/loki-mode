// local_repos: the server-side map from source_id to a real repo path. Filled only by local discovery (never by /v1/ingest);
// the path never leaves the server. The API exposes display names only.
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { desc, eq, isNotNull } from "drizzle-orm";
import type { Context, Hono } from "hono";
import type { Db } from "../db/migrate.ts";
import { localRepos, prState, runs } from "../db/schema.ts";
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

/** The local directories a repository name can mean: a checkout whose folder has that name, or a checkout whose runs recorded an origin `owner/<name>`
 *  (the dashboard names a repository by its GitHub name, and a checkout of asklokesh/FireLater may sit in a folder called `work`). Existing directories only. */
export function repoPathsByName(db: Db, name: string): string[] {
  const rows = db.select({ sourceId: localRepos.sourceId, realpath: localRepos.realpath, name: localRepos.name }).from(localRepos).all();
  const byOrigin = new Set(db.selectDistinct({ s: runs.sourceId, r: runs.originRepo }).from(runs).all().filter((x) => x.r !== null && x.r.split("/").pop() === name).map((x) => x.s));
  return [...new Set(rows.filter((r) => r.name === name || byOrigin.has(r.sourceId)).map((r) => r.realpath))].filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; } });
}
/** Display names only, sorted and de-duplicated. */
export function repoNames(db: Db): string[] {
  return [...new Set(db.select({ name: localRepos.name }).from(localRepos).all().map((r) => r.name))].sort();
}

/** GET /v1/repos. `act` is the loopback-only router; `peerIsLoopback` checks the real socket address. */
export type GhRunner = (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
export const defaultGh: GhRunner = (argv) => new Promise((done) => {
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

// PR state for the Spend merge rate and the Delivered merged mark. GitHub is read with gh (fixed argv, no shell), one `pr list` per repo, cached in pr_state.
// The route answers from the cache at once and refreshes stale rows in the background, so a page never waits on GitHub. A failed lookup stores nothing.
const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9._-]{1,100})\/pull\/([0-9]{1,7})(?:[/?#].*)?$/;
export const PR_TTL_MS = { open: 10 * 60_000, closed: 24 * 3_600_000 } as const; // a merged PR never changes back
const PR_RETRY_MS = 60_000, PR_MAX_URLS = 300, PR_LIST_LIMIT = 200, PR_VIEW_MAX = 20;
type PrKind = "merged" | "open" | "closed";
const prKind = (state: unknown, mergedAt: unknown): PrKind | null => {
  const s = String(state ?? "").toUpperCase();
  return s === "MERGED" || (s === "CLOSED" && typeof mergedAt === "string" && mergedAt !== "") ? "merged" : s === "OPEN" ? "open" : s === "CLOSED" ? "closed" : null;
};
const prStale = (kind: string, checkedAt: string, now: number): boolean => kind !== "merged" && now - Date.parse(checkedAt) > PR_TTL_MS[kind === "open" ? "open" : "closed"];

/** Reads the state of `want` (urls the cache lacks or holds stale), one gh call per repo plus a few single reads for PRs older than the list window. Writes only what gh answered. */
async function refreshPrState(db: Db, gh: GhRunner, want: string[], failed: Map<string, number>, now: () => number): Promise<void> {
  const byRepo = new Map<string, Map<number, string>>();
  for (const u of want) { const m = PR_URL.exec(u)!; const repo = `${m[1]}/${m[2]}`; (byRepo.get(repo) ?? byRepo.set(repo, new Map()).get(repo)!).set(Number(m[3]), u); }
  const save = (url: string, kind: PrKind, mergedAt: unknown): void => {
    const row = { prUrl: url, state: kind, mergedAt: typeof mergedAt === "string" && mergedAt ? mergedAt : null, checkedAt: new Date(now()).toISOString() };
    db.insert(prState).values(row).onConflictDoUpdate({ target: prState.prUrl, set: row }).run();
    failed.delete(url);
  };
  for (const [repo, nums] of byRepo) {
    const seen = new Set<number>();
    const l = await gh(["pr", "list", "--repo", repo, "--state", "all", "--limit", String(PR_LIST_LIMIT), "--json", "number,state,mergedAt"]);
    if (l.code === 0) {
      try {
        const j = JSON.parse(l.stdout) as unknown;
        if (Array.isArray(j)) for (const p of j as Array<{ number?: unknown; state?: unknown; mergedAt?: unknown }>) {
          const url = typeof p.number === "number" ? nums.get(p.number) : undefined, kind = prKind(p.state, p.mergedAt);
          if (url && kind) { save(url, kind, p.mergedAt); seen.add(p.number as number); }
        }
      } catch { /* unreadable list: the urls stay unanswered and are retried after the backoff */ }
    }
    let views = 0;
    for (const [n, url] of nums) {
      if (seen.has(n)) continue;
      if (views++ >= PR_VIEW_MAX) { failed.set(url, now()); continue; }
      const v = await gh(["pr", "view", String(n), "--repo", repo, "--json", "state,mergedAt"]);
      let kind: PrKind | null = null, mergedAt: unknown;
      if (v.code === 0) { try { const j = JSON.parse(v.stdout) as { state?: unknown; mergedAt?: unknown }; kind = prKind(j.state, j.mergedAt); mergedAt = j.mergedAt; } catch { kind = null; } }
      if (kind) save(url, kind, mergedAt); else failed.set(url, now());
    }
  }
}

/** GET /v1/pr-state: `{ states: { <pr_url>: { state, merged_at, checked_at } }, checking }`. A url with no entry is unknown once checking is false. Loopback only (it can spawn gh). */
export function mountPrState(act: Hono, db: Db, peerIsLoopback: (c: Context) => boolean, gh: GhRunner = defaultGh, now: () => number = Date.now): void {
  const failed = new Map<string, number>();
  let inflight: Promise<void> | null = null;
  act.get("/v1/pr-state", (c) => {
    if (!peerIsLoopback(c)) return c.json({ error: "loopback only" }, 403);
    const urls = [...new Set(db.select({ u: runs.prUrl }).from(runs).where(isNotNull(runs.prUrl)).orderBy(desc(runs.startedAt)).limit(PR_MAX_URLS * 2).all().map((r) => r.u!).filter((u) => PR_URL.test(u)))].slice(0, PR_MAX_URLS);
    const cached = new Map(db.select().from(prState).all().map((r) => [r.prUrl, r]));
    const t = now();
    const want = urls.filter((u) => { const r = cached.get(u); return (!r || prStale(r.state, r.checkedAt, t)) && !(failed.has(u) && t - failed.get(u)! < PR_RETRY_MS); });
    if (want.length > 0 && !inflight) inflight = refreshPrState(db, gh, want, failed, now).catch(() => { for (const u of want) failed.set(u, now()); }).finally(() => { inflight = null; });
    const states: Record<string, { state: PrKind; merged_at: string | null; checked_at: string }> = {};
    for (const u of urls) { const r = cached.get(u); if (r) states[u] = { state: r.state as PrKind, merged_at: r.mergedAt, checked_at: r.checkedAt }; }
    return c.json({ states, checking: inflight !== null });
  });
}

export function mountRepos(act: Hono, db: Db, peerIsLoopback: (c: Context) => boolean, repoDir?: string, gh: GhRunner = defaultGh): void {
  mountPrState(act, db, peerIsLoopback, gh);
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
