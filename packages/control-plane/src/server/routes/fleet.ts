// CPE24-P1: fleet spend, ported from dashboard/registry.py (get_fleet_runs / get_fleet_summary). Same sources: the machine registry
// ~/.loki/dashboard/projects.json plus each project's .loki/ (dashboard-state.json, session.json, metrics/efficiency/*.json, context/tracking.json).
// A run with no measured cost has cost_usd null; the summed total is null when none measured and flagged partial when some did not.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { probeAllowed, type RouteCtx } from "./index.ts";
import { NOT_MEASURED, readJson, recordIsMeasured } from "./cost_ledger.ts";

type Rec = Record<string, unknown>;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

export const registryFile = () => join(process.env.HOME ?? homedir(), ".loki", "dashboard", "projects.json");

export function pidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

export function projectSnapshot(path: string) {
  const snap = { phase: "", iteration: null as number | null, cost_usd: null as number | null, started_at: null as string | null, ended_at: null as string | null };
  if (!path) return snap;
  const loki = join(path, ".loki");
  const st = readJson(join(loki, "dashboard-state.json"));
  if (isObj(st)) { snap.phase = typeof st.phase === "string" ? st.phase : ""; snap.iteration = Number.isInteger(st.iteration) ? (st.iteration as number) : null; }
  const ss = readJson(join(loki, "session.json"));
  if (isObj(ss)) {
    const a = ss.startedAt || ss.started_at, b = ss.endedAt || ss.ended_at;
    snap.started_at = typeof a === "string" ? a : null;
    snap.ended_at = typeof b === "string" ? b : null;
  }
  let cost = 0, found = false;
  const eff = join(loki, "metrics", "efficiency");
  let names: string[] = [];
  try { names = readdirSync(eff).filter((n) => n.endsWith(".json")); } catch { /* none */ }
  for (const n of names) {
    const d = readJson(join(eff, n));
    if (isObj(d) && isNum(d.cost_usd) && recordIsMeasured(d)) { cost += d.cost_usd; found = true; }
  }
  if (!found) {
    const t = readJson(join(loki, "context", "tracking.json"));
    const totals = isObj(t) && isObj(t.totals) ? t.totals : null;
    if (totals && isNum(totals.total_cost_usd) && recordIsMeasured({ cost_usd: totals.total_cost_usd, input_tokens: totals.total_input, output_tokens: totals.total_output })) {
      cost = totals.total_cost_usd; found = true;
    }
  }
  snap.cost_usd = found ? Math.round(cost * 1e6) / 1e6 : null;
  return snap;
}

export function fleetRuns(includeInactive = true, file = registryFile()) {
  let projects: Rec[] = [];
  try {
    const reg = JSON.parse(readFileSync(file, "utf8"));
    if (isObj(reg) && isObj(reg.projects)) projects = Object.values(reg.projects).filter(isObj);
  } catch { return []; }
  if (!includeInactive) projects = projects.filter((p) => p.status === "active");
  const out = projects.map((p) => {
    const path = typeof p.path === "string" ? p.path : "";
    const running = pidAlive(p.pid);
    const snap = projectSnapshot(path);
    const reg = String(p.status ?? "unknown").toLowerCase();
    const status = running ? "running" : ["running", "building", "active", "in_progress"].includes(reg) ? "stale" : (p.status ?? "unknown");
    let duration: number | null = null;
    if (snap.started_at) {
      const s = Date.parse(snap.started_at);
      if (!Number.isNaN(s)) {
        const e = snap.ended_at && !running ? Date.parse(snap.ended_at) : NaN;
        duration = Math.max(0, Math.floor(((Number.isNaN(e) ? Date.now() : e) - s) / 1000));
      }
    }
    return {
      id: p.id ?? null, name: (p.name as string) || (path ? basename(path) : "project"), path, status, running, phase: snap.phase,
      iteration: snap.iteration, cost_usd: snap.cost_usd, started_at: snap.started_at, duration_seconds: duration, port: p.port ?? null,
    };
  });
  out.sort((a, b) => (a.running === b.running ? String(b.started_at ?? "").localeCompare(String(a.started_at ?? "")) : a.running ? -1 : 1));
  return out;
}

export function fleetSummary(includeInactive = true, file = registryFile()) {
  const runs = fleetRuns(includeInactive, file);
  const costs = runs.map((r) => r.cost_usd).filter((c): c is number => isNum(c));
  const running = runs.filter((r) => r.running).length;
  return {
    total_runs: runs.length, running_runs: running, stopped_runs: runs.length - running,
    total_cost_usd: costs.length ? Math.round(costs.reduce((a, b) => a + b, 0) * 1e6) / 1e6 : null,
    total_cost_partial: costs.length > 0 && costs.length < runs.length,
    ...(costs.length ? {} : { not_measured: NOT_MEASURED }),
  };
}

export const parseInactive = (v: string | undefined) => !["false", "0", "no"].includes((v ?? "true").toLowerCase());

export function mount(ctx: RouteCtx): void {
  const deny = { error: "loopback only without a token" };
  // /v1 never exposes a project's filesystem path.
  ctx.app.get("/v1/fleet/runs", (c) => (probeAllowed(ctx, c) ? c.json(fleetRuns(parseInactive(c.req.query("include_inactive"))).map(({ path: _p, ...r }) => r)) : c.json(deny, 403)));
  ctx.app.get("/v1/fleet/summary", (c) => (probeAllowed(ctx, c) ? c.json(fleetSummary(parseInactive(c.req.query("include_inactive")))) : c.json(deny, 403)));
}
