// Route registry. Every planned route file has a stub module here, so later slices (CPE-04 onward) only fill their own file.
// `app` serves everywhere; `act` is the loopback-only router (the same Hono as `app` on a loopback bind, a detached one otherwise, so its routes are never registered).
import type { Context, Hono } from "hono";
import type { Db } from "../../db/migrate.ts";
import type { spawnStart } from "../spawn.ts";
import { isLoopbackHost } from "../auth.ts";
import { mountRepos, type GhRunner } from "../repos.ts";
import { mount as artifacts } from "./artifacts.ts";
import { mount as ask } from "./ask.ts";
import { mount as audit } from "./audit.ts";
import { mount as checkpoints } from "./checkpoints.ts";
import { mount as config } from "./config.ts";
import { mount as control } from "./control.ts";
import { mount as cost } from "./cost.ts";
import { mount as costLedger } from "./cost_ledger.ts";
import { mount as fleet } from "./fleet.ts";
import { mount as memory } from "./memory.ts";
import { mount as metrics } from "./metrics.ts";
import { mount as sessionControl } from "./session_control.ts";
import { mount as integrations } from "./integrations.ts";
import { mount as mergeRisk } from "./merge_risk.ts";
import { mount as notify } from "./notify.ts";
import { mount as providers } from "./providers.ts";
import { mount as start } from "./start.ts";
import { mount as stats } from "./stats.ts";
import { mount as stream } from "./stream.ts";
import { mount as verify } from "./verify.ts";

export interface RouteCtx {
  app: Hono;
  act: Hono;
  db: Db;
  repoDir: string;
  /** Bearer token when one is set (tokenGuard already enforces it on /v1/*). */
  token?: string;
  /** The real socket peer is loopback (not the spoofable Host header; unknown peer fails closed). */
  peerIsLoopback: (c: Context) => boolean;
  /** peerIsLoopback plus a loopback Host plus a JSON content type: the guard for state-changing actions. */
  local: (c: Context) => boolean;
  /** Binary for spawned runs (default `loki`) and a spawn seam for tests. */
  startBin?: string;
  spawnImpl?: typeof spawnStart;
  /** Where BLOCKED answers are written (createApp answerDir). */
  answerDir?: string;
  /** gh seam for GET /v1/repos/issues (tests stub it). */
  ghImpl?: GhRunner;
}

export const routeModules: ReadonlyArray<(ctx: RouteCtx) => void> = [artifacts, ask, stream, start, control, stats, cost, costLedger, fleet, metrics, checkpoints, memory, sessionControl, config, providers, verify, integrations, notify, audit, mergeRisk];

export function registerRoutes(ctx: RouteCtx): void {
  mountRepos(ctx.act, ctx.db, ctx.peerIsLoopback, ctx.repoDir, ctx.ghImpl);
  for (const m of routeModules) m(ctx);
}

/** Spawning/probing read routes: with a token set the bearer (enforced by tokenGuard) is the gate; without one they are loopback-only (peer and Host), like the act routes. */
export function probeAllowed(ctx: Pick<RouteCtx, "token" | "peerIsLoopback">, c: Context): boolean {
  return !!ctx.token || (ctx.peerIsLoopback(c) && isLoopbackHost(c.req.header("host")));
}

export const PROBE_CACHE_MS = 60_000;

/** One cached value per key for ttlMs; concurrent callers share the in-flight promise so a burst spawns once. */
export function ttlCache<T>(ttlMs = PROBE_CACHE_MS, now: () => number = Date.now): (key: string, load: () => Promise<T>) => Promise<T> {
  const m = new Map<string, { at: number; p: Promise<T> }>();
  return (key, load) => {
    const hit = m.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.p;
    const p = load();
    m.set(key, { at: now(), p });
    p.catch(() => { if (m.get(key)?.p === p) m.delete(key); });
    return p;
  };
}
