// Human timeline of a run, folded from its events (run.started, stage.started/completed, cost, pr.opened, run.completed, receipt.sealed).
// Nothing is invented: a value the events do not carry is null and the view shows "--".
import type { RunEvent } from "./stream";

export interface TimelineLine {
  key: string;
  ts: string | null;
  kind: "run" | "stage" | "pr" | "verdict" | "receipt";
  label: string;
  duration_s: number | null;
  model: string | null;
  cost_usd: number | null | "no-session"; // "no-session": the stage ran no model session (verify, commit, seal)
  outcome: string;
  detail?: string;
}

const obj = (d: unknown): Record<string, unknown> => (d && typeof d === "object" ? (d as Record<string, unknown>) : {});
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const ms = (ts: string | null): number | null => { const n = ts ? Date.parse(ts) : NaN; return Number.isNaN(n) ? null : n; };

export function buildTimeline(events: RunEvent[]): TimelineLine[] {
  const lines: TimelineLine[] = [];
  const open = new Map<string, TimelineLine & { startedMs: number | null }>();
  const costs = new Map<string, { usd: number; unmeasured: boolean; seen: boolean }>();
  const models = new Map<string, string>();
  const sessions = new Set<string>();
  for (const e of events) {
    const d = obj(e.data);
    const st = e.stage ?? "";
    if (e.type === "session.started" && st) sessions.add(st);
    if (e.type === "session.started" && st && str(d.model)) models.set(st, str(d.model)!);
    if (e.type === "cost" && st) {
      const c = costs.get(st) ?? { usd: 0, unmeasured: false, seen: false };
      const usd = num(d.usd);
      c.seen = true;
      if (usd === null) c.unmeasured = true; else c.usd += usd;
      costs.set(st, c);
      if (str(d.model) && !models.has(st)) models.set(st, str(d.model)!);
    }
  }
  const costOf = (st: string): number | null | "no-session" => { const c = costs.get(st); if (!c && !sessions.has(st) && !models.has(st)) return "no-session"; return c && c.seen && !c.unmeasured ? c.usd : null; };
  for (const e of events) {
    const d = obj(e.data);
    if (e.type === "run.started") {
      lines.push({ key: `s${e.seq}`, ts: e.ts ?? null, kind: "run", label: "Run started", duration_s: null, model: str(d.model), cost_usd: null, outcome: "started", detail: str(d.issue_ref) ?? undefined });
    } else if (e.type === "stage.started" && e.stage) {
      const line = { key: `s${e.seq}`, ts: e.ts ?? null, kind: "stage" as const, label: e.stage, duration_s: null, model: models.get(e.stage) ?? null, cost_usd: costOf(e.stage), outcome: "running", startedMs: ms(e.ts) };
      open.set(e.stage, line);
      lines.push(line);
    } else if ((e.type === "stage.skipped" || e.type === "stage.failed") && e.stage) {
      const line = open.get(e.stage);
      const why = str(d.reason) ?? (e.type === "stage.skipped" ? "no reason recorded" : null);
      const outcome = e.type === "stage.skipped" ? "skipped" : "failed";
      if (line) Object.assign(line, { outcome, detail: why ?? undefined, cost_usd: costOf(e.stage) });
      else lines.push({ key: `s${e.seq}`, ts: e.ts ?? null, kind: "stage", label: e.stage, duration_s: null, model: null, cost_usd: costOf(e.stage), outcome, detail: why ?? undefined });
      open.delete(e.stage);
    } else if (e.type === "stage.completed" && e.stage) {
      const line = open.get(e.stage);
      const dur = num(d.duration_s) ?? (line?.startedMs != null && ms(e.ts) != null ? (ms(e.ts)! - line.startedMs) / 1000 : null);
      const reason = str(d.skipped_reason) ?? str(d.reason);
      const outcome = d.skipped === true ? "skipped" : "completed";
      if (line) Object.assign(line, { duration_s: dur, outcome, model: models.get(e.stage) ?? line.model, cost_usd: costOf(e.stage), detail: reason ?? undefined });
      else lines.push({ key: `s${e.seq}`, ts: e.ts ?? null, kind: "stage", label: e.stage, duration_s: dur, model: models.get(e.stage) ?? null, cost_usd: costOf(e.stage), outcome, detail: reason ?? undefined });
      open.delete(e.stage);
    } else if (e.type === "pr.opened") {
      lines.push({ key: `s${e.seq}`, ts: e.ts ?? null, kind: "pr", label: "Pull request opened", duration_s: null, model: null, cost_usd: null, outcome: d.draft === true ? "draft" : "opened", detail: str(d.url) ?? undefined });
    } else if (e.type === "receipt.sealed") {
      lines.push({ key: `s${e.seq}`, ts: e.ts ?? null, kind: "receipt", label: "Receipt sealed", duration_s: null, model: null, cost_usd: null, outcome: d.signed === true ? "signed" : "unsigned" });
    } else if (e.type === "run.completed") {
      lines.push({ key: `s${e.seq}`, ts: e.ts ?? null, kind: "verdict", label: "Run completed", duration_s: null, model: null, cost_usd: null, outcome: str(d.verdict) ?? "no verdict" });
    }
  }
  return lines;
}
