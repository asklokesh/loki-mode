// loki-ts/src/engine10/dashboard/server.ts -- E-24 local dashboard over SSE (ENGINE.md section
// 12). Binds 127.0.0.1 only, never opens a browser. Reuses events.ts fold()/tail(): runs are
// folded read-only from .loki/runs/*/events.jsonl; the per-run stream is tail()'s replay-then-poll.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fold, readEvents, tail } from "../events.ts";
import type { EventEnvelope, Verdict } from "../types.ts";
import { renderPage } from "./page.ts";
export const DEFAULT_PORT = 57375;
const HOSTNAME = "127.0.0.1"; // section 12: localhost only; never configurable
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
/** CLI entry: cli.ts routes "dashboard" here (E-12). Prints the URL and never
 *  opens a browser (section 12); runs until SIGINT/SIGTERM. */
export async function main(_args: string[]): Promise<number> {
  const repoDir = process.cwd();
  const port = Number(process.env["LOKI_E10_DASHBOARD_PORT"] ?? DEFAULT_PORT);
  const server = startServer(repoDir, port);
  process.stdout.write(`Dashboard: ${server.url}\n`);
  await new Promise<void>(() => {}); // ponytail: blocks forever; the process-level SIGINT/SIGTERM handler in cli.ts terminates it
  return 0;
}
