// CPE24-P3: memory, context, focus and tasks, ported from dashboard/server.py (list_tasks, set_focus, list_episodes, list_patterns, list_skills,
// get_token_economics, get_context). Same .loki/ flat-file sources; the legacy SQLite memory backend and the SQL task store have no CP equivalent, so
// those paths are not ported (see docs/v10/CP-ENTERPRISE-UI.md). Unmeasured values are null, never a fabricated zero.
// Every path read is derived from the focused project dir plus a fixed suffix; a request value is only ever compared to an id, never joined into a path.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import type { Context } from "hono";
import { join, sep } from "node:path";
import { isLoopbackHost, peerIsLoopback } from "../auth.ts";
import { probeAllowed, type RouteCtx } from "./index.ts";
import { lokiDirOf, readJson } from "./cost_ledger.ts";
import { registryFile } from "./fleet.ts";

type Rec = Record<string, unknown>;
const isObj = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown) => !(v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0) || (isObj(v) && Object.keys(v).length === 0));

/** The focused project dir (POST /v1/focus); null means the server's own checkout. Process-wide, like the legacy _active_project_dir. */
export const focus: { dir: string | null } = { dir: null };
export const lokiFor = (repoDir: string) => lokiDirOf(focus.dir ?? repoDir);

/** State-changing guard: loopback peer and Host, JSON content type, and a browser Origin (when sent) equal to the Host. */
export function mutationAllowed(c: Context): boolean {
  if (!peerIsLoopback(c) || !isLoopbackHost(c.req.header("host"))) return false;
  if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) return false;
  const origin = c.req.header("origin");
  if (origin === undefined) return true;
  try { return new URL(origin).host.toLowerCase() === (c.req.header("host") ?? "").toLowerCase(); } catch { return false; }
}

/** Every .json file under dir (sorted), never following symlinks, so nothing resolves outside dir. */
function jsonFiles(dir: string, cap = Infinity): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let ents: Dirent[] = [];
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (out.length >= cap) return;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.isFile() && e.name.endsWith(".json")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

export function focusInfo(repoDir: string) { return { project_dir: focus.dir, loki_dir: lokiFor(repoDir) }; }

/** A focus target must be this checkout or a project in the machine registry, and hold a .loki dir; `..` and relative paths are refused. */
export function setFocus(repoDir: string, raw: unknown, registry = registryFile()): { ok: true } | { ok: false; error: string } {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return { ok: false, error: "project_dir must not be empty" };
  if (!s.startsWith("/") || s.split(/[\\/]/).includes("..")) return { ok: false, error: "project_dir must be an absolute path without .. segments" };
  let real = "";
  try { real = realpathSync(s); if (!statSync(real).isDirectory()) throw new Error("not a dir"); } catch { return { ok: false, error: `Directory does not exist: ${s}` }; }
  if (!existsSync(join(real, ".loki")) || !statSync(join(real, ".loki")).isDirectory()) return { ok: false, error: `Directory does not contain a .loki/ subdirectory: ${s}` };
  const allowed = new Set<string>();
  try { allowed.add(realpathSync(repoDir)); } catch { /* unreadable */ }
  const reg = readJson(registry);
  if (isObj(reg) && isObj(reg.projects)) for (const p of Object.values(reg.projects)) {
    if (isObj(p) && typeof p.path === "string") { try { allowed.add(realpathSync(p.path)); } catch { /* gone */ } }
  }
  if (!allowed.has(real)) return { ok: false, error: "project_dir is not this checkout or a registered project" };
  focus.dir = real;
  return { ok: true };
}

// ---- tasks (dashboard-state.json groups plus .loki/queue/*.json), deduped with the legacy terminal-wins rule ----
const GROUPS: [string, string][] = [["pending", "pending"], ["inProgress", "in_progress"], ["review", "review"], ["completed", "done"], ["failed", "done"]];
const QUEUES: [string, string][] = [["pending.json", "pending"], ["in-progress.json", "in_progress"], ["completed.json", "done"], ["failed.json", "done"], ["dead-letter.json", "done"]];
const RANK: Record<string, number> = { done: 3, in_progress: 2, review: 1, pending: 0 };

export function tasksList(loki: string, status?: string): Rec[] {
  const all: Rec[] = [];
  const st = readJson(join(loki, "dashboard-state.json"));
  const groups = isObj(st) && isObj(st.tasks) ? st.tasks : {};
  for (const [key, mapped] of GROUPS) {
    const g = groups[key];
    if (!Array.isArray(g)) continue;
    g.forEach((t, i) => {
      if (!isObj(t)) return;
      const payload = isObj(t.payload) ? t.payload : {};
      const e: Rec = { id: t.id ?? `${key}-${i}`, title: t.title ?? payload.action ?? t.type ?? "Task", description: t.description ?? payload.description ?? "", status: mapped, priority: t.priority ?? payload.priority ?? "medium", type: t.type ?? "task", position: i };
      for (const f of ["acceptance_criteria", "notes", "logs", "user_story", "project", "source", "specification", "provider", "startedAt", "full_content", "completedAt", "phase", "exitCode"]) if (nonEmpty(t[f])) e[f] = t[f];
      if (t.exitCode === 0) e.exitCode = 0;
      if (key === "completed" || key === "failed") e._terminal_outcome = key;
      all.push(e);
    });
  }
  for (const [file, qs] of QUEUES) {
    const raw = readJson(join(loki, "queue", file));
    const items = isObj(raw) ? raw.tasks : raw;
    if (!Array.isArray(items)) continue;
    const term = file === "completed.json" ? "completed" : file === "failed.json" || file === "dead-letter.json" ? "failed" : null;
    items.forEach((it, i) => {
      if (!isObj(it)) return;
      const id = it.id ?? `q-${qs}-${i}`;
      if (term === null && all.some((t) => t.id === id)) return;
      const e: Rec = { id, title: it.title ?? it.action ?? "Task", description: it.description ?? "", status: qs, priority: it.priority ?? "medium", type: it.type ?? "task", position: i };
      for (const f of ["acceptance_criteria", "user_story", "project", "source", "provider", "startedAt", "completedAt", "phase"]) if (nonEmpty(it[f])) e[f] = it[f];
      for (const f of ["notes", "logs"]) if (Array.isArray(it[f])) e[f] = it[f];
      if (Number.isInteger(it.exitCode)) e.exitCode = it.exitCode;
      if (term) e._terminal_outcome = term;
      all.push(e);
    });
  }
  const auth = (t: Rec) => [RANK[t.status as string] ?? -1, t._terminal_outcome === "failed" ? 1 : 0] as const;
  const better = (a: Rec, b: Rec) => { const x = auth(a), y = auth(b); return x[0] !== y[0] ? x[0] > y[0] : x[1] > y[1]; };
  const byId = new Map<unknown, Rec>(), order: (Rec | { ref: unknown })[] = [];
  for (const t of all) {
    if (t.id === undefined || t.id === null) { order.push(t); continue; }
    const prev = byId.get(t.id);
    if (!prev) { byId.set(t.id, t); order.push({ ref: t.id }); } else if (better(t, prev)) byId.set(t.id, t);
  }
  const out = order.map((o) => ("ref" in o ? (byId.get(o.ref) as Rec) : o));
  for (const t of out) {
    if (t.type === "iteration" && !t.description) {
      const ec = t.exitCode, failed = t._terminal_outcome === "failed";
      const o = Number.isInteger(ec) && ec === 0 && !failed ? "completed cleanly (exit 0)" : Number.isInteger(ec) && ec !== 0 ? `failed (exit ${ec})` : failed ? "failed"
        : t._terminal_outcome === "completed" ? "completed" : t.status === "done" ? "finished" : null;
      if (o) t.description = `Iteration ${o}${t.provider ? `, built by ${t.provider}` : ""}.`;
    }
  }
  return status ? out.filter((t) => t.status === status) : out;
}

// ---- memory (.loki/memory JSON store) ----
const memDir = (loki: string, sub: string) => join(loki, "memory", sub);

export function memoryEpisodes(loki: string, limit = 50): Rec[] {
  const eps = jsonFiles(memDir(loki, "episodic")).map(readJson).filter(isObj);
  eps.sort((a, b) => String(b.timestamp ?? "").localeCompare(String(a.timestamp ?? "")));
  return eps.slice(0, limit);
}
export function memoryEpisode(loki: string, id: string): Rec | null {
  for (const f of jsonFiles(memDir(loki, "episodic"))) {
    const d = readJson(f);
    if (isObj(d) && (d.id === id || f.split(sep).pop() === `${id}.json`)) return d;
  }
  return null;
}
export function memoryPatterns(loki: string): Rec[] {
  const d = readJson(join(memDir(loki, "semantic"), "patterns.json"));
  const list = Array.isArray(d) ? d : isObj(d) && Array.isArray(d.patterns) ? d.patterns : [];
  return list.filter(isObj);
}
export const memorySkills = (loki: string): Rec[] => jsonFiles(memDir(loki, "skills")).map(readJson).filter(isObj);

export function memoryEconomics(loki: string) {
  const rawV = readJson(join(loki, "memory", "token_economics.json"));
  const raw: Rec = isObj(rawV) ? rawV : {};
  const m = isObj(raw.metrics) ? raw.metrics : {};
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0);
  const hits = n(m.cache_hits), misses = n(m.cache_misses), total = hits + misses;
  const recorded = Object.keys(m).length > 0;
  const disc = recorded ? n(m.discovery_tokens) : null, read = recorded ? n(m.read_tokens) : null;
  const cands: Rec[] = [];
  for (const kind of ["episodic", "semantic"]) {
    for (const f of jsonFiles(memDir(loki, kind), 300)) {
      const d = readJson(f);
      if (!isObj(d)) continue;
      const ctx = isObj(d.context) ? d.context : {};
      cands.push({ id: d.id ?? "", kind, access_count: n(d.access_count), importance: Number(d.importance) || 0, summary: String(d.summary || d.pattern || ctx.goal || "").slice(0, 160) });
    }
  }
  cands.sort((a, b) => (b.access_count as number) - (a.access_count as number) || (b.importance as number) - (a.importance as number));
  return {
    session_id: raw.session_id ?? null, discovery_tokens: disc, read_tokens: read, total_tokens: recorded ? (disc as number) + (read as number) : null,
    cache_hits: hits, cache_misses: misses, hit_rate: total > 0 ? Math.round((hits / total) * 1e4) / 1e4 : null, ratio: raw.ratio ?? null,
    savings_percent: raw.savings_percent ?? null, top_patterns: cands.slice(0, 10).filter((p) => (p.access_count as number) > 0),
    discoveryTokens: disc, readTokens: read, savingsPercent: raw.savings_percent ?? null, raw,
  };
}

/** .loki/context/tracking.json; absent means the tracker never ran, so every reading is null. A file that exists but is unreadable is an error, not a zero. */
export function contextTracking(loki: string): { status: 200 | 500; body: unknown } {
  const f = join(loki, "context", "tracking.json");
  if (!existsSync(f)) {
    return { status: 200, body: {
      session_id: null, updated_at: null,
      current: { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null, total_tokens: null, context_window_pct: null, estimated_cost_usd: null },
      compactions: [], per_iteration: [],
      totals: { total_input: null, total_output: null, total_cost_usd: null, compaction_count: null, iterations_tracked: null },
    } };
  }
  try { return { status: 200, body: JSON.parse(readFileSync(f, "utf8")) }; } catch { return { status: 500, body: { error: "Failed to read context tracking data" } }; }
}

export function mount(ctx: RouteCtx): void {
  const deny = { error: "loopback only without a token" };
  const read = (path: string, fn: (c: Context, loki: string) => Response) =>
    ctx.app.get(path, (c) => (probeAllowed(ctx, c) ? fn(c, lokiFor(ctx.repoDir)) : c.json(deny, 403)));
  read("/v1/tasks", (c, l) => {
    if (c.req.query("project_id") !== undefined) return c.json({ error: "project_id filter is not supported by the Control Plane" }, 400);
    return c.json(tasksList(l, c.req.query("status")));
  });
  read("/v1/memory/episodes", (c, l) => {
    const lim = c.req.query("limit") === undefined ? 50 : Number(c.req.query("limit"));
    return Number.isInteger(lim) && lim >= 1 && lim <= 1000 ? c.json(memoryEpisodes(l, lim)) : c.json({ error: "limit must be 1..1000" }, 422);
  });
  read("/v1/memory/episodes/:id", (c, l) => { const e = memoryEpisode(l, c.req.param("id")); return e ? c.json(e) : c.json({ error: "Episode not found" }, 404); });
  read("/v1/memory/patterns", (c, l) => c.json(memoryPatterns(l)));
  read("/v1/memory/patterns/:id", (c, l) => { const p = memoryPatterns(l).find((x) => x.id === c.req.param("id")); return p ? c.json(p) : c.json({ error: "Pattern not found" }, 404); });
  read("/v1/memory/skills", (c, l) => c.json(memorySkills(l)));
  read("/v1/memory/economics", (c, l) => c.json(memoryEconomics(l)));
  read("/v1/context", (c, l) => { const r = contextTracking(l); return c.json(r.body, r.status); });
  read("/v1/focus", (c) => c.json(focusInfo(ctx.repoDir)));
  ctx.act.post("/v1/focus", async (c) => {
    if (!mutationAllowed(c)) return c.json({ error: "loopback JSON requests only" }, 403);
    const body = await c.req.json().catch(() => null);
    const r = setFocus(ctx.repoDir, isObj(body) ? body.project_dir : undefined);
    return r.ok ? c.json(focusInfo(ctx.repoDir)) : c.json({ error: r.error }, 400);
  });
  ctx.act.delete("/v1/focus", (c) => {
    if (!mutationAllowed(c)) return c.json({ error: "loopback JSON requests only" }, 403);
    focus.dir = null;
    return c.json(focusInfo(ctx.repoDir));
  });
}
