// CP-INGEST: zero-homework ingest. On Control Plane start, backfill the current repo plus every repo in the project
// registry (~/.loki/dashboard/projects.json), then poll each repo's .loki/runs and ship appended events.jsonl lines
// through the same shipRun path as the live hook (idempotent: ship.json holds the acked seq, the server dedupes).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { backfill } from "./backfill.ts";
import { shipRun, sourceId } from "./ship.ts";

/** Repo dirs from the dashboard project registry; never throws, a missing or corrupt registry means none. */
export function registryRepos(env: NodeJS.ProcessEnv): string[] {
  try {
    const reg = JSON.parse(readFileSync(join(env.HOME || homedir(), ".loki", "dashboard", "projects.json"), "utf8")) as { projects?: Record<string, { path?: unknown }> };
    return Object.values(reg.projects ?? {}).map((p) => p.path).filter((p): p is string => typeof p === "string" && p.startsWith("/"));
  } catch { return []; }
}

export interface WatchOpts {
  repoDir: string;
  url: string;
  env?: NodeJS.ProcessEnv;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
}
export interface Watcher { stop: () => void; tick: () => Promise<number> }

const sig = (f: string): string => { try { const s = statSync(f); return `${s.size}:${s.mtimeMs}`; } catch { return ""; } };

/** Backfill every repo, then watch. Resolves once the backfill is done; the watcher keeps polling until stop(). */
export async function ingestAndWatch(o: WatchOpts): Promise<Watcher> {
  const env: NodeJS.ProcessEnv = { ...(o.env ?? process.env), LOKI_CONTROL_URL: o.url };
  const repos = [...new Set([o.repoDir, ...registryRepos(env)])];
  const seen = new Map<string, string>(); // events.jsonl path -> size:mtime last shipped OK
  for (const repoDir of repos) {
    try { await backfill({ repoDir, env, attempts: 1, fetchImpl: o.fetchImpl }); } catch { /* one bad repo must not block the rest */ }
  }
  let busy = false;
  const tick = async (): Promise<number> => {
    if (busy) return 0;
    busy = true;
    let sent = 0;
    try {
      for (const repoDir of repos) {
        const root = join(repoDir, ".loki", "runs");
        let ids: string[] = [];
        try { ids = readdirSync(root); } catch { continue; }
        const source = sourceId(repoDir);
        for (const id of ids) {
          const runDir = join(root, id), f = join(runDir, "events.jsonl"), s = sig(f);
          if (s === "" || seen.get(f) === s) continue;
          try {
            const r = await shipRun({ runDir, url: o.url, source, token: env.LOKI_CONTROL_TOKEN, fetchImpl: o.fetchImpl });
            sent += r.sent;
            if (r.ok) seen.set(f, s);
          } catch { /* retry next tick */ }
        }
      }
    } finally { busy = false; }
    return sent;
  };
  const timer = setInterval(() => { void tick(); }, o.intervalMs ?? 1000);
  (timer as { unref?: () => void }).unref?.();
  return { stop: () => clearInterval(timer), tick };
}
