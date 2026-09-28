// loki-ts/src/engine10/modernize/dashboard.ts -- M-24: the dashboard's /modernize view
// (docs/v10/MODERNIZE.md, D33: this view lives here, not dashboard/modernize.ts, so core's
// dashboard/server.ts never needs a static import of modernize/ -- it reaches modernizeRoute
// via a dynamic import(), the same pattern machine.ts/session.ts/supervisor.ts already use to
// keep a module out of core's static graph).
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readModernizeEvents } from "./log.ts";

export interface ModernizeSummary {
  mid: string;
  to: string | null;
  status: string; // last event's type, "unknown" with no events yet
  startedTs: string | null;
  completedTs: string | null;
}

function modernizeDir(repoDir: string): string {
  return join(repoDir, ".loki", "modernize");
}

export function listModernizeIds(repoDir: string): string[] {
  const dir = modernizeDir(repoDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

export function summarizeModernize(repoDir: string, mid: string): ModernizeSummary {
  const events = readModernizeEvents(repoDir, mid);
  const started = events.find((e) => e.type === "modernize.started");
  const completed = events.find((e) => e.type === "modernize.completed");
  return {
    mid,
    to: started ? ((started.data as { to?: string }).to ?? null) : null,
    status: events.length ? events[events.length - 1]!.type : "unknown",
    startedTs: started?.ts ?? null,
    completedTs: completed?.ts ?? null,
  };
}

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

function renderRow(s: ModernizeSummary): string {
  return `<tr><td>${esc(s.mid)}</td><td>${esc(s.to ?? "-")}</td><td>${esc(s.status)}</td>` +
    `<td>${esc(s.startedTs ?? "-")}</td><td>${esc(s.completedTs ?? "-")}</td></tr>`;
}

function renderModernizePage(repoDir: string): string {
  const rows = listModernizeIds(repoDir).map((mid) => renderRow(summarizeModernize(repoDir, mid))).join("");
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Loki 10 modernize</title>
<style>
  body { font: 13px/1.5 ui-monospace, monospace; margin: 0; padding: 16px; background: #0b0b0c; color: #ddd; }
  h1 { font-size: 15px; margin: 0 0 12px; }
  table { border-collapse: collapse; }
  th, td { text-align: left; padding: 4px 12px 4px 0; border-bottom: 1px solid #222; }
  th { color: #888; font-weight: normal; }
</style>
</head>
<body>
<h1>Loki 10 modernize</h1>
<table><thead><tr><th>id</th><th>to</th><th>status</th><th>started</th><th>completed</th></tr></thead>
<tbody>${rows}</tbody></table>
</body>
</html>
`;
}

/** cli.ts routes `dashboard/server.ts`'s `/modernize` here via a dynamic import (see header). */
export function modernizeRoute(repoDir: string): Response {
  return new Response(renderModernizePage(repoDir), { headers: { "content-type": "text/html; charset=utf-8" } });
}
