// Start-a-run and repo-picker helpers for the UI. A run is started by spawning the same `loki start` path an operator would type (argv array, no shell).
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const ISSUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}#[1-9][0-9]{0,8}$/;
// A free-text task: letters, digits, spaces and a small punctuation set. No colon, quotes, backticks, $, ;, &, |, <, >, parens, braces, backslash or control chars.
const TASK = /^[A-Za-z0-9][A-Za-z0-9 .,_/#@+=-]{0,499}$/;
const hasDotDot = (t: string): boolean => t.split(/[\\/ ]/).some((seg) => seg.startsWith(".."));

/** Child env: the server's own secrets and bind config never reach a spawned run. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...env, LOKI_NO_BROWSER: "1" };
  for (const k of ["LOKI_CONTROL_TOKEN", "LOKI_CONTROL_DB", "LOKI_CONTROL_HOST", "PORT"]) delete e[k];
  return e;
}

export type StartPlan = { ok: true; argv: string[]; cwd: string } | { ok: false; error: string };

/** Registered project paths from ~/.loki/dashboard/projects.json (the `loki projects` registry), existing directories only. */
export function registryRepos(env: NodeJS.ProcessEnv = process.env): string[] {
  try {
    const j = JSON.parse(readFileSync(join(env.HOME || homedir(), ".loki", "dashboard", "projects.json"), "utf8")) as { projects?: Record<string, { path?: unknown }> };
    return Object.values(j.projects ?? {}).map((p) => (typeof p?.path === "string" ? p.path : "")).filter((p) => p && existsSync(p) && statSync(p).isDirectory());
  } catch { return []; }
}

/** Validate a start request. The repo must be one the server already knows (registry or cwd), never an arbitrary path. */
export function planStart(body: unknown, known: string[], bin = "loki"): StartPlan {
  const b = (body && typeof body === "object" ? body : {}) as { target?: unknown; repo?: unknown };
  if (typeof b.target !== "string") return { ok: false, error: "target must be a string" };
  const target = b.target.trim();
  const issue = ISSUE.test(target);
  if (!issue && !TASK.test(target)) return { ok: false, error: "target must be owner/repo#N or a plain task (letters, digits, spaces, . , _ / # @ + = -)" };
  if (hasDotDot(target)) return { ok: false, error: "target must not contain a .. path segment" };
  let cwd = process.cwd();
  if (b.repo !== undefined && b.repo !== "") {
    if (typeof b.repo !== "string" || b.repo.includes("\0")) return { ok: false, error: "repo must be a path string" };
    // GET /v1/repos exposes display names only, so a repo may be given as a known path or as the unique display name of a known project.
    const want = resolve(b.repo);
    const paths = known.map((k) => resolve(k));
    const named = paths.filter((k) => basename(k) === b.repo);
    const hit = paths.find((k) => k === want) ?? (named.length === 1 ? named[0] : undefined);
    if (!hit) return { ok: false, error: named.length > 1 ? "repo name is ambiguous" : "repo is not a known project" };
    cwd = hit;
  }
  // Free text goes as an explicit brief, never auto-detected as a PRD path.
  return { ok: true, argv: issue ? [bin, "start", target] : [bin, "start", "--brief", target], cwd };
}

/** Spawn detached with no shell; resolves with the pid once the process exists, or an error if it cannot be launched. */
export function spawnStart(argv: string[], cwd: string, onExit: () => void = () => {}): Promise<{ pid: number } | { error: string }> {
  return new Promise((done) => {
    try {
      const [cmd, ...args] = argv;
      const child = spawn(cmd!, args, { cwd, detached: true, stdio: "ignore", shell: false, env: childEnv() });
      child.once("exit", onExit);
      child.once("error", (e) => { onExit(); done({ error: `could not start loki: ${e.message}` }); });
      child.once("spawn", () => { child.unref(); done({ pid: child.pid ?? 0 }); });
    } catch (e) { done({ error: `could not start loki: ${(e as Error).message}` }); }
  });
}
