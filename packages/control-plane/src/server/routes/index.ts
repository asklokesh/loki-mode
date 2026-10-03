// Route registry. Every planned route file has a stub module here, so later slices (CPE-04 onward) only fill their own file.
// `app` serves everywhere; `act` is the loopback-only router (the same Hono as `app` on a loopback bind, a detached one otherwise, so its routes are never registered).
import type { Context, Hono } from "hono";
import type { Db } from "../../db/migrate.ts";
import type { spawnStart } from "../spawn.ts";
import { mountRepos } from "../repos.ts";
import { mount as artifacts } from "./artifacts.ts";
import { mount as audit } from "./audit.ts";
import { mount as config } from "./config.ts";
import { mount as control } from "./control.ts";
import { mount as cost } from "./cost.ts";
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
  /** The real socket peer is loopback (not the spoofable Host header; unknown peer fails closed). */
  peerIsLoopback: (c: Context) => boolean;
  /** peerIsLoopback plus a loopback Host plus a JSON content type: the guard for state-changing actions. */
  local: (c: Context) => boolean;
  /** Binary for spawned runs (default `loki`) and a spawn seam for tests. */
  startBin?: string;
  spawnImpl?: typeof spawnStart;
  /** Where BLOCKED answers are written (createApp answerDir). */
  answerDir?: string;
}

export const routeModules: ReadonlyArray<(ctx: RouteCtx) => void> = [artifacts, stream, start, control, stats, cost, config, providers, verify, integrations, notify, audit, mergeRisk];

export function registerRoutes(ctx: RouteCtx): void {
  mountRepos(ctx.act, ctx.db, ctx.peerIsLoopback);
  for (const m of routeModules) m(ctx);
}
