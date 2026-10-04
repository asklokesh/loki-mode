// CP-ASK slice 2: read-only data tools for Ask Loki, as pure functions over the CP database.
// Nothing here writes, spawns a build, or returns a path, URL or token. Run, event and artifact text is untrusted data.
// Cost and events reuse the route handlers through an in-process Hono (no HTTP, no duplicated logic); the artifact
// allowlist and read cap come from routes/artifacts.ts.
import { realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "../db/migrate.ts";
import { localRepos } from "../db/schema.ts";
import { mount as mountArtifacts, NAME, readCapped, safeId } from "../server/routes/artifacts.ts";
import { mount as mountCost } from "../server/routes/cost.ts";
import { computeStats } from "../server/routes/stats.ts";
import type { RouteCtx } from "../server/routes/index.ts";
import { repoNames } from "../server/repos.ts";
import { listRuns, runDetail } from "../server/runs.ts";

export type ToolResult = Record<string, unknown>;
export const TOOL_NAMES = ["runs_search", "run_get", "run_events", "run_artifact", "runs_compare", "stats", "cost", "repos_list"] as const;

const err = (error: string): ToolResult => ({ error });
const isoOk = (s: string | undefined) => s === undefined || (!Number.isNaN(Date.parse(s)) && /^\d{4}-\d{2}-\d{2}/.test(s));

function internal(db: Db): Hono {
  const app = new Hono();
  const ctx = { app, act: new Hono(), db } as unknown as RouteCtx;
  mountCost(ctx);
  mountArtifacts(ctx);
  return app;
}

async function internalGet(db: Db, path: string): Promise<ToolResult> {
  const r = await internal(db).request(path);
  const body = (await r.json().catch(() => ({ error: "unreadable response" }))) as ToolResult;
  return r.status === 200 ? body : err(typeof body.error === "string" ? body.error : `request failed (${r.status})`);
}

export function runsSearch(db: Db, a: { verdict?: string; repo?: string; since?: string; until?: string; group_id?: string; limit?: number; cursor?: string }): ToolResult {
  if (!isoOk(a.since) || !isoOk(a.until)) return err("since and until must be ISO dates");
  if (a.limit !== undefined && (!Number.isInteger(a.limit) || a.limit < 1 || a.limit > 200)) return err("limit must be 1..200");
  return listRuns(db, a);
}

export function runGet(db: Db, a: { source_id: string; run_id: string }): ToolResult {
  if (!safeId(a.source_id) || !safeId(a.run_id)) return err("invalid source_id or run_id");
  return runDetail(db, a.source_id, a.run_id) ?? err("run not found");
}

export async function runEvents(db: Db, a: { source_id: string; run_id: string; after?: number; limit?: number }): Promise<ToolResult> {
  if (!safeId(a.source_id) || !safeId(a.run_id)) return err("invalid source_id or run_id");
  if (a.after !== undefined && (!Number.isInteger(a.after) || a.after < 0)) return err("after must be a non-negative integer");
  if (a.limit !== undefined && (!Number.isInteger(a.limit) || a.limit < 1)) return err("limit must be a positive integer");
  const q = new URLSearchParams();
  if (a.after !== undefined) q.set("after", String(a.after));
  if (a.limit !== undefined) q.set("limit", String(a.limit));
  return internalGet(db, `/v1/runs/${a.source_id}/${a.run_id}/events?${q}`);
}

/** One allowlisted artifact of a run, read through the same containment the HTTP route uses. Binary (png) is refused. */
export function runArtifact(db: Db, a: { source_id: string; run_id: string; name: string }): ToolResult {
  if (!safeId(a.source_id) || !safeId(a.run_id)) return err("invalid source_id or run_id");
  if (typeof a.name !== "string" || !NAME.test(a.name)) return err("artifact is not on the allowlist");
  if (a.name.endsWith(".png")) return err("binary artifacts are not readable through this tool");
  if (!runDetail(db, a.source_id, a.run_id)) return err("run not found");
  const repo = db.select({ p: localRepos.realpath }).from(localRepos).where(eq(localRepos.sourceId, a.source_id)).get();
  if (!repo) return err("artifact not available");
  try {
    const runsRoot = realpathSync(join(repo.p, ".loki", "runs"));
    const runDir = realpathSync(join(runsRoot, a.run_id));
    if (runDir !== join(runsRoot, a.run_id)) return err("artifact not found");
    const file = realpathSync(join(runDir, a.name));
    if (!file.startsWith(runDir + sep)) return err("artifact not found");
    const r = readCapped(file);
    if (r.status !== 200) return err(r.status === 413 ? "artifact too large" : "artifact not found");
    return { name: a.name, content: r.body.toString("utf8") };
  } catch { return err("artifact not found"); }
}

/** Both runs side by side: ids, verdicts, costs, tokens and the cost delta (b minus a). */
export function runsCompare(db: Db, a: { source_a: string; run_a: string; source_b: string; run_b: string }): ToolResult {
  const out: Record<string, unknown>[] = [];
  for (const [s, r] of [[a.source_a, a.run_a], [a.source_b, a.run_b]] as const) {
    const d = runGet(db, { source_id: s, run_id: r }) as Record<string, any>;
    if (d.error) return err(`${s}/${r}: ${d.error}`);
    out.push({
      source_id: d.source_id, run_id: d.run_id, origin_repo: d.origin_repo, verdict: d.verdict, effective_verdict: d.effective_verdict,
      status: d.status, provider: d.provider, model: d.model, cost_usd: d.cost_usd, partial_usd: d.partial_usd,
      input_tokens: d.input_tokens, output_tokens: d.output_tokens, wall_s: d.wall_s, pr_url: d.pr_url, tampered: d.tampered,
    });
  }
  const ca = out[0]?.cost_usd, cb = out[1]?.cost_usd;
  const delta = typeof ca === "number" && typeof cb === "number" ? Math.round((cb - ca) * 1e6) / 1e6 : null;
  return { runs: out, cost_delta_usd: delta };
}

export function stats(db: Db, a: { since?: string }): ToolResult {
  if (!isoOk(a.since)) return err("since must be an ISO date");
  return computeStats(db, a.since === undefined ? null : new Date(a.since).toISOString()) as unknown as ToolResult;
}

export function cost(db: Db, a: { group?: string; since?: string }): Promise<ToolResult> | ToolResult {
  if (!isoOk(a.since)) return err("since must be an ISO date");
  const q = new URLSearchParams({ group: a.group ?? "day" });
  if (a.since) q.set("since", a.since);
  return internalGet(db, `/v1/stats/cost?${q}`);
}

/** Display names only, never paths. */
export function reposList(db: Db): ToolResult {
  return { repos: repoNames(db) };
}
