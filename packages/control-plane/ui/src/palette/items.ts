// Palette data (CPE-22): pure builders for the three result groups and the matcher. No React here.
import type { RunRow } from "../api";
import type { PageDef } from "../pages/registry";

export type ItemKind = "Pages" | "Runs" | "Actions";
export interface PaletteItem {
  id: string;
  kind: ItemKind;
  label: string;
  hint?: string;
  /** Hash route to open, e.g. "/runs/a/b". Absent for pure actions. */
  to?: string;
  action?: "new-run" | "toggle-theme";
}

/** Dispatched on window by Cmd+Enter. The composer (CPE-08) listens for it and submits. */
export const COMPOSER_SUBMIT_EVENT = "loki:composer-submit";
export const MAX_RUNS = 8;

export const actionItems = (): PaletteItem[] => [
  { id: "action:new-run", kind: "Actions", label: "New run", hint: "Cmd+N", to: "/new", action: "new-run" },
  { id: "action:toggle-theme", kind: "Actions", label: "Toggle theme", hint: "Cmd+Shift+D", action: "toggle-theme" },
];

/** Pages with a parameter segment cannot be opened without a value, so they are not listed. */
export const pageItems = (pages: PageDef[]): PaletteItem[] =>
  pages.filter((p) => !p.path.includes(":")).map((p) => ({ id: `page:${p.id}`, kind: "Pages", label: p.title, hint: p.path, to: p.path }));

const stamp = (r: RunRow): number => { const n = Date.parse(r.started_at ?? r.last_event_at ?? ""); return Number.isNaN(n) ? 0 : n; };

export const runItems = (runs: RunRow[]): PaletteItem[] =>
  [...runs].sort((a, b) => stamp(b) - stamp(a)).map((r) => ({
    id: `run:${r.source_id}/${r.run_id}`,
    kind: "Runs" as const,
    label: r.run_id,
    hint: [r.origin_repo, r.verdict ?? r.status].filter(Boolean).join(" / ") || undefined,
    to: `/runs/${encodeURIComponent(r.source_id)}/${encodeURIComponent(r.run_id)}`,
  }));

const matches = (it: PaletteItem, q: string): boolean => {
  const hay = `${it.label} ${it.hint ?? ""}`.toLowerCase();
  return q.split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
};

/** Groups in a fixed order: Actions, Pages, Runs (runs capped at MAX_RUNS). Empty query lists everything. */
export function search(query: string, pages: PaletteItem[], runs: PaletteItem[], actions: PaletteItem[]): PaletteItem[] {
  const q = query.trim().toLowerCase();
  const f = (l: PaletteItem[]) => (q ? l.filter((i) => matches(i, q)) : l);
  return [...f(actions), ...f(pages), ...f(runs).slice(0, MAX_RUNS)];
}
