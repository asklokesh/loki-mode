// The three levels the Loki UI shows: an account, the projects under it (grouped by org), and the repositories of each project; plus what Loki and
// Claude Code know about one repository (its instruction files and Loki's notes) and the one write the UI makes there (the repository's CLAUDE.md, the
// file Claude Code itself reads, so instructions written in the UI work outside Loki too).
// Storage: one JSON file, ~/.loki/control/workspace.json (LOKI_WORKSPACE_FILE overrides). Reads follow the probe rule; writes are loopback JSON only.
// (New file: repos.ts lists repository names, memory.ts serves the focused project's run memory; neither owns grouping or repository instructions.)
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { Context } from "hono";
import { localRepos, runs } from "../../db/schema.ts";
import type { Db } from "../../db/migrate.ts";
import { audit } from "../audit.ts";
import { repoNames } from "../repos.ts";
import { originOk } from "./start.ts";
import { probeAllowed, type RouteCtx } from "./index.ts";

export interface Project { id: string; name: string; repos: string[] }
export interface Org { id: string; name: string; projects: Project[] }
export interface Workspace { account: { name: string }; orgs: Org[] }

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/, MAX_BYTES = 200_000;
export const workspaceFile = (env: NodeJS.ProcessEnv = process.env): string => env["LOKI_WORKSPACE_FILE"] || join(homedir(), ".loki", "control", "workspace.json");
const accountName = (): string => { try { return userInfo().username || "me"; } catch { return "me"; } };
const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() !== "" && v.length <= max ? v.trim() : null);

/** A workspace from untrusted JSON, or the reason it is refused. Unknown keys are dropped; ids must be short lowercase slugs, unique where they must be. */
export function parseWorkspace(raw: unknown): { ok: true; ws: Workspace } | { ok: false; error: string } {
  const o = raw as { account?: { name?: unknown }; orgs?: unknown } | null;
  const name = text(o?.account?.name, 80); if (!name) return { ok: false, error: "account.name must be 1 to 80 characters" };
  if (!Array.isArray(o?.orgs) || o!.orgs.length === 0 || o!.orgs.length > 50) return { ok: false, error: "orgs must hold 1 to 50 entries" };
  const orgs: Org[] = [], orgIds = new Set<string>();
  for (const x of o!.orgs as { id?: unknown; name?: unknown; projects?: unknown }[]) {
    const id = text(x?.id, 40), nm = text(x?.name, 80);
    if (!id || !ID.test(id) || orgIds.has(id) || !nm) return { ok: false, error: "each org needs a unique lowercase id and a name" };
    orgIds.add(id);
    if (!Array.isArray(x.projects) || x.projects.length > 200) return { ok: false, error: `org ${id}: projects must be a list of at most 200` };
    const projects: Project[] = [], pIds = new Set<string>();
    for (const p of x.projects as { id?: unknown; name?: unknown; repos?: unknown }[]) {
      const pid = text(p?.id, 40), pn = text(p?.name, 80);
      if (!pid || !ID.test(pid) || pIds.has(pid) || !pn) return { ok: false, error: `org ${id}: each project needs a unique lowercase id and a name` };
      pIds.add(pid);
      const repos = Array.isArray(p.repos) ? [...new Set((p.repos as unknown[]).filter((r): r is string => typeof r === "string" && r.length > 0 && r.length <= 200))].slice(0, 500) : [];
      projects.push({ id: pid, name: pn, repos });
    }
    orgs.push({ id, name: nm, projects });
  }
  return { ok: true, ws: { account: { name }, orgs } };
}
/** The saved workspace, or a first one: your account, one org, one project holding every repository that has a run. Never throws. */
export function loadWorkspace(known: string[], file = workspaceFile()): Workspace {
  try { if (existsSync(file)) { const p = parseWorkspace(JSON.parse(readFileSync(file, "utf8"))); if (p.ok) return p.ws; } } catch { /* unreadable: fall through to the default */ }
  return { account: { name: accountName() }, orgs: [{ id: "personal", name: "Personal", projects: [{ id: "default", name: "My project", repos: [...known] }] }] };
}
export function saveWorkspace(ws: Workspace, file = workspaceFile()): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(ws, null, 2) + "\n", { mode: 0o600 }); renameSync(tmp, file);
}
/** Short names of the repositories that have at least one run: the ones worth showing before anyone has organised anything. */
export function reposWithRuns(db: Db): string[] {
  const names = db.selectDistinct({ r: runs.originRepo }).from(runs).all().map((x) => (x.r ? x.r.split("/").pop() ?? "" : "")).filter(Boolean);
  return [...new Set(names)].sort();
}
/** Every repository the UI can name: the ones found on this machine plus the ones runs recorded. */
export const knownRepos = (db: Db): string[] => [...new Set([...repoNames(db), ...reposWithRuns(db)])].sort();
/** The repositories with runs that no project holds yet, so work is never invisible (a machine can hold hundreds of idle checkouts; those stay in the picker). */
export const unassigned = (ws: Workspace, withRuns: string[]): string[] => { const held = new Set(ws.orgs.flatMap((o) => o.projects.flatMap((p) => p.repos))); return withRuns.filter((r) => !held.has(r)); };

/** The local directory of a registered repository (by display name), or null. Only directories Loki itself discovered are ever read or written. */
export function repoDirsOf(db: Db, name: string): string[] {
  const rows = db.select({ name: localRepos.name, realpath: localRepos.realpath }).from(localRepos).all().filter((r) => r.name === name);
  return [...new Set(rows.map((r) => r.realpath))].filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; /* moved or deleted */ } });
}
export const repoDirOf = (db: Db, name: string): string | null => repoDirsOf(db, name)[0] ?? null;
const INSTRUCTION_FILES = ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md", "AGENTS.md"] as const;
const NOTE_DIRS = [".loki/memory", ".loki/learnings", ".claude/rules"] as const;
const readCapped = (p: string): { text: string; bytes: number; truncated: boolean } | null => { try { const st = statSync(p); if (!st.isFile()) return null; const b = readFileSync(p); return { text: b.subarray(0, MAX_BYTES).toString("utf8"), bytes: st.size, truncated: st.size > MAX_BYTES }; } catch { return null; } };
/** What is written down about one repository: the instruction files Claude Code reads, and Loki's own notes. Text is capped; nothing outside the repository is read. */
export function repoKnowledge(dir: string): { instructions: { path: string; bytes: number; truncated: boolean; text: string }[]; notes: { path: string; bytes: number; preview: string }[] } {
  const instructions = INSTRUCTION_FILES.flatMap((f) => { const r = readCapped(join(dir, f)); return r ? [{ path: f, ...r }] : []; });
  const notes: { path: string; bytes: number; preview: string }[] = [];
  for (const d of NOTE_DIRS) {
    let names: string[] = []; try { names = readdirSync(join(dir, d)).filter((n) => /\.(md|json|jsonl|txt)$/i.test(n)).sort().slice(0, 40); } catch { continue; }
    for (const n of names) { const r = readCapped(join(dir, d, n)); if (r) notes.push({ path: `${d}/${n}`, bytes: r.bytes, preview: r.text.slice(0, 600) }); }
  }
  return { instructions, notes };
}
/** Writes the repository's CLAUDE.md (temp file, then rename). The path is fixed: the UI can never name another file. */
export function writeInstructions(dir: string, content: string): void {
  const root = resolve(dir), target = join(root, "CLAUDE.md");
  if (!target.startsWith(root + sep)) throw new Error("path outside the repository");
  const tmp = `${target}.${process.pid}.tmp`; writeFileSync(tmp, content); renameSync(tmp, target);
}

export function mount(ctx: RouteCtx): void {
  const { app, act, db, local } = ctx, deny = { error: "loopback only without a token" };
  const body = async (c: Context): Promise<{ ok: true; json: unknown } | { ok: false; res: Response }> => {
    if (!local(c)) return { ok: false, res: c.json({ error: "loopback JSON requests only" }, 403) };
    if (!originOk(c.req.header("origin"))) return { ok: false, res: c.json({ error: "origin not allowed" }, 403) };
    const t = await c.req.text(); if (t.length > MAX_BYTES + 2000) return { ok: false, res: c.json({ error: "body too large" }, 413) };
    try { return { ok: true, json: JSON.parse(t) }; } catch { return { ok: false, res: c.json({ error: "invalid JSON" }, 400) }; }
  };
  app.get("/v1/workspace", (c) => { if (!probeAllowed(ctx, c)) return c.json(deny, 403); const active = reposWithRuns(db), ws = loadWorkspace(active); return c.json({ ...ws, repos: knownRepos(db), unassigned: unassigned(ws, active) }); });
  act.put("/v1/workspace", async (c) => {
    const b = await body(c); if (!b.ok) return b.res;
    const p = parseWorkspace(b.json); if (!p.ok) { audit(db, { kind: "workspace.save", result: "refused", detail: p.error }); return c.json({ error: p.error }, 400); }
    try { saveWorkspace(p.ws); } catch (e) { return c.json({ error: `could not save: ${(e as Error).message}` }, 500); }
    audit(db, { kind: "workspace.save", result: "saved", detail: `${p.ws.orgs.length} org(s), ${p.ws.orgs.reduce((a, o) => a + o.projects.length, 0)} project(s)` });
    return c.json({ ...p.ws, repos: knownRepos(db), unassigned: unassigned(p.ws, reposWithRuns(db)) });
  });
  app.get("/v1/repo/knowledge", (c) => {
    if (!probeAllowed(ctx, c)) return c.json(deny, 403);
    const name = c.req.query("repo") ?? "", dir = name ? repoDirOf(db, name) : null;
    if (!dir) return c.json({ error: "not a repository Loki has seen on this machine" }, 404);
    return c.json({ repo: name, ...repoKnowledge(dir) });
  });
  act.put("/v1/repo/instructions", async (c) => {
    const b = await body(c); if (!b.ok) return b.res;
    const name = text((b.json as { repo?: unknown } | null)?.repo, 200), content = (b.json as { content?: unknown } | null)?.content;
    if (!name || typeof content !== "string" || content.length > MAX_BYTES) return c.json({ error: `repo and content (at most ${MAX_BYTES} characters) are required` }, 400);
    const dirs = repoDirsOf(db, name), dir = dirs[0]; if (!dir) return c.json({ error: "not a repository Loki has seen on this machine" }, 404);
    if (dirs.length > 1) { audit(db, { kind: "repo.instructions", target: name, result: "refused", detail: `${dirs.length} checkouts share this name` }); return c.json({ error: `${dirs.length} checkouts on this machine are named ${name}; edit CLAUDE.md in the one you mean` }, 409); } // a write must never land in a checkout the person did not mean
    try { writeInstructions(dir, content); } catch (e) { audit(db, { kind: "repo.instructions", target: name, result: "error", detail: (e as Error).message }); return c.json({ error: `could not write CLAUDE.md: ${(e as Error).message}` }, 500); }
    audit(db, { kind: "repo.instructions", target: name, result: "saved", detail: `${content.length} characters` });
    return c.json({ repo: name, ...repoKnowledge(dir) });
  });
}
