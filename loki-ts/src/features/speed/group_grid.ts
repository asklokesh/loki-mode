// loki-ts/src/features/speed/group_grid.ts
//
// D61 slice 15 (design section 3D): the live unit grid for one group, served
// by the engine10 dashboard at /g/<group>. Folds .loki/runs/*/events.jsonl and
// keeps the runs whose run.started carries group_id. No server, no state.
import { fold, readEvents } from "../../engine10/events.ts";
import { eventsPath, listRunIds } from "../../engine10/status.ts";

export interface GridRow {
  runId: string;
  unitId: string;
  stage: string;
  elapsedS: number | null;
}

export function groupGrid(repoDir: string, group: string, now: number = Date.now()): GridRow[] {
  const rows: GridRow[] = [];
  for (const runId of listRunIds(repoDir)) {
    const events = readEvents(eventsPath(repoDir, runId));
    const f = fold(events);
    const sd = f.run.started?.data ?? {};
    if (sd["group_id"] !== group) continue;
    const startMs = f.run.started ? Date.parse(f.run.started.ts) : NaN;
    const endMs = f.run.completed ? Date.parse(f.run.completed.ts) : now;
    rows.push({
      runId,
      unitId: typeof sd["unit_id"] === "string" ? sd["unit_id"] : runId,
      stage: f.run.completed ? "done" : (events[events.length - 1]?.stage ?? "starting"),
      elapsedS: Number.isNaN(startMs) ? null : Math.max(0, (endMs - startMs) / 1000),
    });
  }
  return rows.sort((a, b) => a.unitId.localeCompare(b.unitId));
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));

export function renderGroupPage(group: string, rows: GridRow[]): string {
  const body = rows.length === 0
    ? "<p>no data ingested</p>"
    : "<table><tr><th>unit</th><th>stage</th><th>elapsed</th></tr>" +
      rows.map((r) => `<tr><td>${esc(r.unitId)}</td><td>${esc(r.stage)}</td><td>${r.elapsedS == null ? "not measured" : `${Math.round(r.elapsedS)}s`}</td></tr>`).join("") +
      "</table>";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="2"><title>Loki group ${esc(group)}</title>` +
    `<style>body{font:13px/1.5 ui-monospace,monospace;padding:16px;background:#0b0b0c;color:#ddd}td,th{padding:2px 14px 2px 0;text-align:left}</style>` +
    `</head><body><h1>Group ${esc(group)}</h1>${body}</body></html>`;
}

export async function groupResponse(repoDir: string, group: string): Promise<Response> {
  return new Response(renderGroupPage(group, groupGrid(repoDir, group)), { headers: { "content-type": "text/html; charset=utf-8" } });
}
