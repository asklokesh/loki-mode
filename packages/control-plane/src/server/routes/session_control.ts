// CPE24-P4: session control and the Completion Council, ported from dashboard/server.py (/api/control/{pause,resume,stop}, /api/council/*).
// Trust (HIGH tier): control accepts only the fixed ACTIONS enum, never a command string, and writes only the signal files run.sh already
// reads (.loki/PAUSE, .loki/STOP, .loki/signals/COUNCIL_REVIEW_REQUESTED) holding a timestamp. It spawns and signals nothing.
// Council reads are read-only, take no path from the caller, and cap what they return.
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Context } from "hono";
import { audit } from "../audit.ts";
import type { Db } from "../../db/migrate.ts";
import { probeAllowed, type RouteCtx } from "./index.ts";
import { pidAlive } from "./fleet.ts";
import { lokiDirOf } from "./cost_ledger.ts";

type Rec = Record<string, unknown>;
const isObj = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

export const ACTIONS = ["pause", "resume", "stop", "council-review"] as const;
export type ControlAction = (typeof ACTIONS)[number];
export const isAction = (v: string): v is ControlAction => (ACTIONS as readonly string[]).includes(v);

/** A browser Origin, when present, must be this server's own host; a cross-site fetch is refused. Absent Origin (curl, the CLI, the extension host) is allowed. */
export function sameOrigin(c: Context): boolean {
  if (c.req.header("sec-fetch-site") === "cross-site") return false;
  const origin = c.req.header("origin");
  if (origin === undefined) return true;
  try { return new URL(origin).host.toLowerCase() === (c.req.header("host") ?? "").toLowerCase(); } catch { return false; }
}

const readJson = (p: string): unknown => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

function runnerPid(loki: string): number | null {
  try { const pid = parseInt(readFileSync(join(loki, "loki.pid"), "utf8").trim(), 10); return pidAlive(pid) ? pid : null; } catch { return null; }
}

export interface ControlResult { status: 200 | 503; body: Rec }

/** Applies one enum action to <repoDir>/.loki by writing or removing a signal file. Never signals a process. */
export function applyControl(repoDir: string, action: ControlAction): ControlResult {
  const loki = lokiDirOf(repoDir);
  const running = runnerPid(loki) !== null;
  const put = (rel: string) => { const f = join(loki, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, new Date().toISOString()); };
  if (action === "council-review") { put(join("signals", "COUNCIL_REVIEW_REQUESTED")); return { status: 200, body: { success: true, message: "Council review requested" } }; }
  if (action === "resume") {
    for (const n of ["PAUSE", "STOP"]) { try { unlinkSync(join(loki, n)); } catch { /* absent */ } }
    return running ? { status: 200, body: { success: true, message: "Session resumed", process_verified: true } }
      : { status: 503, body: { success: false, message: "Session process is not running; the signal files were cleared" } };
  }
  put(action === "pause" ? "PAUSE" : "STOP");
  if (!running) return { status: 503, body: { success: false, message: `Session process is not running; the ${action} signal may have no effect` } };
  return { status: 200, body: { success: true, message: action === "pause" ? "Session paused" : "Stop requested; the runner exits at its next check", process_verified: true } };
}

/** Runs the guarded, audited control action; shared by /v1/control/:action and the legacy mappings. */
export function runControl(db: Db, repoDir: string, action: ControlAction, c: Context, via: string): Response {
  if (!sameOrigin(c)) { audit(db, { kind: `session.${action}`, target: via, result: "refused", detail: "origin not allowed" }); return c.json({ error: "origin not allowed" }, 403); }
  const r = applyControl(repoDir, action);
  audit(db, { kind: `session.${action}`, target: via, result: r.status === 200 ? "ok" : "unverified" });
  return c.json(r.body, r.status);
}

export function councilState(loki: string): Rec {
  const f = join(loki, "council", "state.json");
  if (!existsSync(f)) return { enabled: false, total_votes: 0, verdicts: [] };
  const d = readJson(f);
  return isObj(d) ? d : { enabled: null, total_votes: null, verdicts: null, error: "unreadable_state" };
}

export function councilVerdicts(loki: string, limit = 20): Rec {
  const st = readJson(join(loki, "council", "state.json"));
  const verdicts = isObj(st) && Array.isArray(st.verdicts) ? st.verdicts : [];
  const votes = join(loki, "council", "votes");
  const details: Rec[] = [];
  let names: string[] = [];
  try { names = readdirSync(votes, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse(); } catch { /* none */ }
  const text = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
  for (const n of names.slice(0, limit)) {
    const dir = join(votes, n), d: Rec = { iteration: n };
    const ev = text(join(dir, "evidence.md"));
    if (ev !== null) d.evidence_preview = ev.slice(0, 500);
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => /^member-.*\.txt$/.test(f)).sort(); } catch { /* none */ }
    d.members = files.flatMap((f) => { const t = text(join(dir, f)); return t === null ? [] : [{ member: f.replace(/\.txt$/, ""), content: t.trim() }]; });
    const con = text(join(dir, "contrarian.txt"));
    if (con !== null) d.contrarian = con.trim();
    details.push(d);
  }
  return { verdicts, details };
}

export function councilConvergence(loki: string): Rec {
  const dataPoints: Rec[] = [];
  let raw = "";
  try { raw = readFileSync(join(loki, "council", "convergence.log"), "utf8"); } catch { /* none */ }
  for (const line of raw.trim().split("\n")) {
    const p = line.split("|");
    if (p.length < 5) continue;
    const n = p.slice(1, 5).map((x) => (/^-?\d+$/.test(x.trim()) ? Number(x) : NaN));
    if (n.some(Number.isNaN)) continue;
    dataPoints.push({ timestamp: p[0], iteration: n[0], files_changed: n[1], no_change_streak: n[2], done_signals: n[3] });
  }
  return { dataPoints };
}

export function councilReport(loki: string): Rec {
  try { return { report: readFileSync(join(loki, "council", "report.md"), "utf8") }; } catch { return { report: null }; }
}

export function councilTranscripts(loki: string, q: { limit?: number; since?: string; iter_min?: number }): Rec {
  const limit = Math.min(Math.max(q.limit ?? 20, 1), 200);
  let since: number | null = null;
  if (q.since) { since = Date.parse(q.since); if (Number.isNaN(since)) return { error: "Invalid 'since' timestamp format; expected ISO8601" }; }
  const dir = join(loki, "council", "transcripts");
  let names: string[] = [];
  try { names = readdirSync(dir).filter((f) => /^iter-.*\.json$/.test(f)).sort().reverse(); } catch { return { transcripts: [], total: 0, latest_id: null }; }
  const out: Rec[] = [];
  for (const n of names) {
    const rec = readJson(join(dir, n));
    if (!isObj(rec) || typeof rec.iteration_id !== "string") continue;
    if (since !== null) { const t = Date.parse(String(rec.timestamp ?? "")); if (Number.isNaN(t) || t <= since) continue; }
    if (q.iter_min !== undefined && Number(rec.iteration ?? 0) < q.iter_min) continue;
    out.push(rec);
    if (out.length >= limit) break;
  }
  return { transcripts: out, total: out.length, latest_id: out.length ? out[0]!.iteration_id : null };
}

/** Parses an optional non-negative integer query param: undefined when absent, null when malformed or above max. */
export const intQ = (v: string | undefined, max: number): number | undefined | null => (v === undefined ? undefined : /^\d+$/.test(v) && Number(v) <= max ? Number(v) : null);

export function mount(ctx: RouteCtx): void {
  const deny = { error: "loopback only without a token" };
  const loki = () => lokiDirOf(ctx.repoDir);
  // Control: registered on `act` (loopback-bound servers only); real loopback peer plus JSON content type (ctx.local), the CP bearer via tokenGuard, and same-origin.
  ctx.act.post("/v1/control/:action", (c) => {
    if (!ctx.local(c)) return c.json({ error: "loopback JSON requests only" }, 403);
    const action = c.req.param("action");
    if (!isAction(action)) return c.json({ error: `action must be one of ${ACTIONS.join(", ")}` }, 400);
    return runControl(ctx.db, ctx.repoDir, action, c, "v1");
  });
  const read = (path: string, f: (c: Context) => Response | Rec) => ctx.app.get(path, (c) => {
    if (!probeAllowed(ctx, c)) return c.json(deny, 403);
    const r = f(c);
    return r instanceof Response ? r : c.json(r);
  });
  read("/v1/council/state", () => councilState(loki()));
  read("/v1/council/verdicts", (c) => { const n = intQ(c.req.query("limit"), 1000); return n === null || n === 0 ? c.json({ error: "limit must be 1..1000" }, 422) : councilVerdicts(loki(), n); });
  read("/v1/council/convergence", () => councilConvergence(loki()));
  read("/v1/council/report", () => councilReport(loki()));
  read("/v1/council/transcripts", (c) => {
    const limit = intQ(c.req.query("limit"), 200), iterMin = intQ(c.req.query("iter_min"), Number.MAX_SAFE_INTEGER);
    if (limit === null || limit === 0 || iterMin === null) return c.json({ error: "limit must be 1..200 and iter_min a non-negative integer" }, 422);
    const r = councilTranscripts(loki(), { limit, since: c.req.query("since"), iter_min: iterMin });
    return "error" in r ? c.json(r, 400) : r;
  });
}
