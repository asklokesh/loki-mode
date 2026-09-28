// loki-ts/src/engine10/dashboard/server.ts -- E-24 local dashboard over SSE (ENGINE.md section
// 12). Binds 127.0.0.1 only, never opens a browser. Reuses events.ts fold()/tail(): runs are
// folded read-only from .loki/runs/*/events.jsonl; the per-run stream is tail()'s replay-then-poll.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fold, readEvents, tail } from "../events.ts";
import type { EventEnvelope, Verdict } from "../types.ts";
import { getVersion } from "../../version.ts";
import { renderPage } from "./page.ts";
export const DEFAULT_PORT = 57375;
const HOSTNAME = "127.0.0.1"; // section 12: localhost only; never configurable
const DASHBOARD_IDENT = "loki-v10"; // /version's "dashboard" field, identifies a v10 occupant
export interface RunSummary {
  runId: string;
  verdict: Verdict | null;
  currentStage: string | null;
  pr: { url: string; draft: boolean } | null;
  notProven: string[] | null;
  costUsd: number | null;
  wallS: number | null;
}
function runsDir(repoDir: string): string {
  return join(repoDir, ".loki", "runs");
}
export function eventsPath(repoDir: string, runId: string): string {
  return join(runsDir(repoDir), runId, "events.jsonl");
}
export function listRunIds(repoDir: string): string[] {
  const dir = runsDir(repoDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}
/** Folds one run's events into the summary the dashboard renders. A field the
 *  run has not reached yet is left null (section 12: never a fake 0). */
export function summarizeRun(repoDir: string, runId: string): RunSummary {
  const events = readEvents(eventsPath(repoDir, runId));
  const folded = fold(events);
  const sealData = folded.stages["seal"]?.data as { not_proven?: string[] } | undefined;
  const prData = folded.stages["pr"]?.data as { url?: string; pr_url?: string; draft?: boolean } | undefined;
  const lastEvent = events[events.length - 1] ?? null;
  const startedMs = folded.run.started ? Date.parse(folded.run.started.ts) : null;
  // Wall time is reported only once the run has actually completed: using the
  // last event's timestamp as a stand-in while running would freeze "elapsed"
  // between polls and misreport it as a real, final number.
  const wallS =
    folded.run.completed && startedMs != null ? (Date.parse(folded.run.completed.ts) - startedMs) / 1000 : null;
  const prUrl = prData?.url ?? prData?.pr_url ?? null;
  return {
    runId,
    verdict: folded.run.verdict,
    currentStage: folded.run.completed ? null : (lastEvent?.stage ?? null),
    pr: prUrl ? { url: prUrl, draft: prData?.draft === true } : null,
    notProven: sealData?.not_proven ?? null,
    costUsd: folded.cost.usd,
    wallS,
  };
}
export function listRuns(repoDir: string): RunSummary[] {
  return listRunIds(repoDir).map((id) => summarizeRun(repoDir, id));
}
/** One screen's worth of labeled panels (section 12). A panel with no data
 *  yet is left out of the array entirely; cost/time always render, "not
 *  measured" when null (never 0, matching output.ts's summary convention). */
export function formatPanels(r: RunSummary): { label: string; value: string }[] {
  const panels: { label: string; value: string }[] = [];
  if (r.verdict) panels.push({ label: "Verdict", value: r.verdict });
  else if (r.currentStage) panels.push({ label: "Verdict", value: `running (${r.currentStage})` });
  if (r.pr) panels.push({ label: "PR", value: r.pr.url + (r.pr.draft ? " (draft)" : "") });
  else if (r.verdict) panels.push({ label: "PR", value: "none" });
  if (r.notProven) panels.push({ label: "NOT PROVEN", value: r.notProven.length ? r.notProven.join(", ") : "none" });
  panels.push({ label: "Cost", value: r.costUsd != null ? `$${r.costUsd.toFixed(2)}` : "not measured" });
  panels.push({ label: "Time", value: r.wallS != null ? `${Math.round(r.wallS)}s` : "not measured" });
  return panels;
}
function sseLine(e: EventEnvelope): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`);
}
/** Replays events.jsonl then tails it (events.ts tail(): fs poll, 250ms
 *  default), so a newly appended event reaches the client well inside the
 *  2s green criterion. */
function eventStream(repoDir: string, runId: string): ReadableStream<Uint8Array> {
  let stop: (() => void) | null = null;
  return new ReadableStream({
    start(controller) {
      stop = tail(eventsPath(repoDir, runId), (e) => {
        try {
          controller.enqueue(sseLine(e));
        } catch {
          // Client disconnected; cancel() below stops the underlying poll.
        }
      });
    },
    cancel() {
      stop?.();
    },
  });
}
export interface DashboardServer {
  port: number;
  hostname: string;
  url: string;
  stop(): void;
}
export function startServer(repoDir: string, port: number = DEFAULT_PORT): DashboardServer {
  const server = Bun.serve({
    hostname: HOSTNAME,
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/") {
        return new Response(renderPage(), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (url.pathname === "/version") {
        return Response.json({ dashboard: DASHBOARD_IDENT, version: getVersion(), cliVersion: getCliVersion(), pid: process.pid });
      }
      if (url.pathname === "/api/runs") {
        return Response.json(listRuns(repoDir).map((r) => ({ ...r, panels: formatPanels(r) })));
      }
      const m = /^\/api\/runs\/([^/]+)\/events$/.exec(url.pathname);
      if (m) {
        return new Response(eventStream(repoDir, m[1]!), {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  // A TCP server (never a unix socket, per HOSTNAME above) always has both.
  const boundPort = server.port ?? port;
  const boundHost = server.hostname ?? HOSTNAME;
  return {
    port: boundPort,
    hostname: boundHost,
    url: `http://${boundHost}:${boundPort}/`,
    stop: () => server.stop(true),
  };
}
/** E-70: the "loki that launched it" version, passed in by the CLI shim (not
 *  set by this process). null when unset -- rendered as "unknown", never
 *  faked to match and hide a real mismatch. */
export function getCliVersion(): string | null {
  const v = process.env["LOKI_CLI_VERSION"];
  return v && v.trim() ? v.trim() : null;
}

/** Anchored on the interpreter plus the exact route tokens, never a bare name
 *  match (mirrors autonomy/run.sh's _loki_pid_looks_like_dashboard): a
 *  process merely mentioning "dashboard" in an argument cannot forge
 *  identity. Matches the legacy `python -m dashboard.server` and v10's own
 *  `bun <cli.ts> engine10 dashboard`. */
export function looksLikeDashboardCommand(cmd: string): boolean {
  if (/^\s*(\S*\/)?python(3(\.\d+)?)?\s+-m\s+dashboard\.server(\s|$)/.test(cmd)) return true;
  return /^\s*(\S*\/)?bun\s+.*\bengine10\b.*\bdashboard\b/.test(cmd);
}

function isAddrInUse(err: unknown): boolean {
  if ((err as { code?: string } | null)?.code === "EADDRINUSE") return true;
  return /EADDRINUSE|already in use/i.test(err instanceof Error ? err.message : String(err));
}

interface Occupant {
  isLokiDashboard: boolean;
  version: string | null;
  pid: number | null; // the pid IT reported, trusted without further checks
}

/** Identifies who is on `port` over HTTP: v10's own /version first, falling
 *  back to legacy's /health (docs/v10/ENGINE.md section 12). Never touches
 *  the process; that decision is the caller's. */
async function probeOccupant(port: number): Promise<Occupant> {
  const base = `http://127.0.0.1:${port}`;
  try {
    const r = await fetch(`${base}/version`, { signal: AbortSignal.timeout(1000) });
    if (r.ok) {
      const body = (await r.json()) as { dashboard?: string; version?: string; pid?: number };
      if (body.dashboard === DASHBOARD_IDENT) {
        return {
          isLokiDashboard: true,
          version: typeof body.version === "string" ? body.version : null,
          pid: Number.isInteger(body.pid) ? (body.pid as number) : null,
        };
      }
    }
  } catch {
    // Not a v10 dashboard, or nothing answered; fall through to legacy's probe.
  }
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
    if (r.ok) {
      const body = (await r.json()) as { service?: string };
      if (body.service === "loki-dashboard") return { isLokiDashboard: true, version: null, pid: null };
    }
  } catch {
    // Neither probe answered: an ordinary, non-Loki listener.
  }
  return { isLokiDashboard: false, version: null, pid: null };
}

// lsof/ps are best-effort identification, never load-bearing for safety: a
// missing binary (an unusual host) must fail closed to "unidentified", not
// throw and abort the whole replace-or-refuse decision.
function lsofPortOwnerPid(port: number): number | null {
  try {
    const out = Bun.spawnSync({ cmd: ["lsof", "-ti", `:${port}`], env: process.env, stdout: "pipe", stderr: "ignore" });
    const pid = Number(new TextDecoder().decode(out.stdout).trim().split("\n")[0]);
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

function commandForPid(pid: number): string {
  try {
    const out = Bun.spawnSync({ cmd: ["ps", "-o", "command=", "-p", String(pid)], env: process.env, stdout: "pipe", stderr: "ignore" });
    return new TextDecoder().decode(out.stdout).trim();
  } catch {
    return "";
  }
}

/** The pid owning the port, but ONLY once its command line is verified to be
 *  a dashboard entry -- lsof alone names a port, never an identity. */
function verifiedDashboardPid(port: number): number | null {
  const pid = lsofPortOwnerPid(port);
  return pid != null && looksLikeDashboardCommand(commandForPid(pid)) ? pid : null;
}

async function isPortFree(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      Bun.serve({ hostname: HOSTNAME, port, fetch: () => new Response("") }).stop(true);
      return true;
    } catch {
      await Bun.sleep(50);
    }
  }
  return false;
}

/** TERM then, if the port is still held, KILL -- same fallback order as
 *  autonomy/run.sh's shared-dashboard teardown. */
async function stopAndWaitFree(pid: number, port: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  if (await isPortFree(port, 1500)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
  await isPortFree(port, 1500);
}

/** "loki dashboard" replaces any older dashboard server on its port
 *  (docs/v10/ENGINE.md section 12): binds normally, and only on EADDRINUSE
 *  identifies the occupant over HTTP before touching it. A Loki dashboard
 *  (legacy or v10) is stopped -- by the pid it reported, or, failing that, the
 *  lsof pid verified by command line -- and the bind is retried. Anything
 *  else is left alone: the error names the port and, best-effort, the
 *  process, but never kills it. */
export async function startServerReplacingOlder(repoDir: string, port: number): Promise<DashboardServer> {
  try {
    return startServer(repoDir, port);
  } catch (err) {
    if (!isAddrInUse(err)) throw err;
  }
  const occupant = await probeOccupant(port);
  if (!occupant.isLokiDashboard) {
    const pid = lsofPortOwnerPid(port);
    const cmd = pid != null ? commandForPid(pid) : null;
    throw new Error(
      `Port ${port} is already in use by another process` +
        (pid != null ? ` (pid ${pid}${cmd ? `: ${cmd}` : ""})` : "") +
        `; not killing it. Set LOKI_E10_DASHBOARD_PORT to use a different port.`,
    );
  }
  const pid = occupant.pid ?? verifiedDashboardPid(port);
  if (pid == null) {
    throw new Error(`Port ${port} is held by a Loki dashboard whose process could not be identified; not killing it.`);
  }
  await stopAndWaitFree(pid, port);
  return startServer(repoDir, port);
}

/** CLI entry: cli.ts routes "dashboard" here (E-12). Prints the URL and never
 *  opens a browser (section 12); runs until SIGINT/SIGTERM. */
export async function main(_args: string[]): Promise<number> {
  const repoDir = process.cwd();
  const port = Number(process.env["LOKI_E10_DASHBOARD_PORT"] ?? DEFAULT_PORT);
  let server: DashboardServer;
  try {
    server = await startServerReplacingOlder(repoDir, port);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  process.stdout.write(`Dashboard: ${server.url}\n`);
  await new Promise<void>(() => {}); // ponytail: blocks forever; the process-level SIGINT/SIGTERM handler in cli.ts terminates it
  return 0;
}
