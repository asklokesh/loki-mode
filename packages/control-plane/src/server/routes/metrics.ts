// CPE24-P1: GET /v1/metrics, the Prometheus text exposition ported from dashboard/server.py (_build_metrics_text), same .loki/ flat-file sources.
// Honest data: a gauge whose source is absent or unmeasured emits NO sample (only HELP/TYPE plus a "not measured" comment), never a 0.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { probeAllowed, type RouteCtx } from "./index.ts";
import { NOT_MEASURED, costSnapshot, lokiDirExists, lokiDirOf, readJson } from "./cost_ledger.ts";
import { pidAlive } from "./fleet.ts";

type Rec = Record<string, unknown>;
const isObj = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown) => (Array.isArray(v) ? v : []);

export function buildMetricsText(repoDir: string, now = Date.now()): string {
  if (!lokiDirExists(repoDir)) return "# loki_up 0\n";
  const loki = lokiDirOf(repoDir);
  const L: string[] = [];
  const gauge = (name: string, help: string, type: string, samples: string[] | null) => {
    L.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    if (samples === null) L.push(`# ${name} ${NOT_MEASURED}`); else L.push(...samples);
    L.push("");
  };
  const stRaw = readJson(join(loki, "dashboard-state.json"));
  const state: Rec | null = isObj(stRaw) ? stRaw : null;

  let status = 0;
  if (state?.mode === "paused") status = 2;
  else if (state?.mode === "autonomous" || state?.mode === "running") status = 1;
  else {
    try { if (pidAlive(parseInt(readFileSync(join(loki, "loki.pid"), "utf8").trim(), 10))) status = 1; } catch { /* stopped */ }
  }
  gauge("loki_session_status", "Current session status (0=stopped, 1=running, 2=paused)", "gauge", [`loki_session_status ${status}`]);
  gauge("loki_iteration_current", "Current iteration number", "gauge", typeof state?.iteration === "number" ? [`loki_iteration_current ${state.iteration}`] : null);
  const maxIt = Number.parseInt(process.env.LOKI_MAX_ITERATIONS ?? "", 10);
  gauge("loki_iteration_max", "Maximum configured iterations", "gauge", [`loki_iteration_max ${Number.isFinite(maxIt) ? maxIt : 1000}`]);

  const tasks = state && isObj(state.tasks) ? state.tasks : null;
  gauge("loki_tasks_total", "Number of tasks by status", "gauge", tasks ? [
    `loki_tasks_total{status="pending"} ${arr(tasks.pending).length}`, `loki_tasks_total{status="in_progress"} ${arr(tasks.inProgress).length}`,
    `loki_tasks_total{status="completed"} ${arr(tasks.completed).length}`, `loki_tasks_total{status="failed"} ${arr(tasks.failed).length}`,
  ] : null);

  let agents: unknown[] | null = null;
  const af = readJson(join(loki, "state", "agents.json"));
  if (Array.isArray(af) && af.length) agents = af;
  else if (state && Array.isArray(state.agents) && state.agents.length) agents = state.agents;
  const active = (agents ?? []).filter((a) => isObj(a) && a.status === "active").length;
  gauge("loki_agents_active", "Number of currently active agents", "gauge", agents ? [`loki_agents_active ${active}`] : null);
  gauge("loki_agents_total", "Total number of agents registered", "gauge", agents ? [`loki_agents_total ${agents.length}`] : null);

  const cost = costSnapshot(loki);
  gauge("loki_cost_usd", "Estimated total cost in USD", "gauge", cost.estimated_cost_usd !== null ? [`loki_cost_usd ${cost.estimated_cost_usd}`] : null);

  let events: number | null = null;
  try { events = readFileSync(join(loki, "events.jsonl"), "utf8").split("\n").filter((l) => l.trim()).length; } catch { /* absent */ }
  gauge("loki_events_total", "Total number of events recorded", "counter", events !== null ? [`loki_events_total ${events}`] : null);

  let uptime: number | null = null;
  if (typeof state?.startedAt === "string") {
    const s = Date.parse(state.startedAt);
    if (!Number.isNaN(s)) uptime = Math.max(0, Math.round(((now - s) / 1000) * 10) / 10);
  }
  gauge("loki_uptime_seconds", "Seconds since session started", "gauge", uptime !== null ? [`loki_uptime_seconds ${uptime}`] : null);

  let total = 0, ver = 0, gaps = 0, notver = 0, unk = 0, att = 0, sig = 0;
  const pdir = join(loki, "proofs");
  let entries: string[] = [];
  try { entries = readdirSync(pdir).sort(); } catch { /* none */ }
  for (const e of entries) {
    try { if (!statSync(join(pdir, e)).isDirectory()) continue; } catch { continue; }
    const d = readJson(join(pdir, e, "proof.json"));
    if (!isObj(d)) continue;
    total++;
    const head = isObj(d.honesty) ? d.honesty.headline : null;
    if (head === "VERIFIED") ver++; else if (head === "VERIFIED WITH GAPS") gaps++; else if (head === "NOT VERIFIED") notver++; else unk++;
    if (isObj(d.verification)) { if (d.verification.attestation) att++; if (d.verification.gpg_signature) sig++; }
  }
  gauge("loki_receipts_total", "Evidence Receipts on disk", "gauge", [`loki_receipts_total ${total}`]);
  gauge("loki_receipts_by_verdict", "Receipts bucketed on the recorded honesty headline", "gauge", [
    `loki_receipts_by_verdict{verdict="verified"} ${ver}`, `loki_receipts_by_verdict{verdict="with_gaps"} ${gaps}`,
    `loki_receipts_by_verdict{verdict="not_verified"} ${notver}`, `loki_receipts_by_verdict{verdict="unknown"} ${unk}`,
  ]);
  gauge("loki_receipts_with_provenance", "Receipts carrying a checkable provenance record", "gauge", [
    `loki_receipts_with_provenance{kind="attestation"} ${att}`, `loki_receipts_with_provenance{kind="gpg"} ${sig}`,
  ]);
  return L.join("\n") + "\n";
}

export function mount(ctx: RouteCtx): void {
  ctx.app.get("/v1/metrics", (c) => {
    if (!probeAllowed(ctx, c)) return c.json({ error: "loopback only without a token" }, 403);
    return c.text(buildMetricsText(ctx.repoDir), 200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
  });
}
