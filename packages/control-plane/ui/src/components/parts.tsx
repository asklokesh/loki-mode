// The small pieces every page shares: badge, run list, stage bar, acceptance table. Each takes plain data and draws it; none fetches.
import { Check, Minus, X } from "lucide-react";
import type { AcceptanceRow, RunRow, TimelineStage } from "../api";
import { ago, duration, isWorking, label, money, repoOf, runTitle, type Tone } from "../lib/format";
import { href } from "../lib/router";

export function Badge({ text, tone }: { text: string; tone: Tone }) {
  return (
    <span className={`badge ${tone}`}>
      {tone === "live" ? <i className="pulse" /> : null}
      {text}
    </span>
  );
}

export function RunBadge({ run }: { run: Pick<RunRow, "verdict" | "status" | "effective_verdict" | "last_event_at"> }) {
  const l = label(run);
  return <Badge text={l.text} tone={l.tone} />;
}

export function RunList({ runs, showRepo = true, empty }: { runs: RunRow[]; showRepo?: boolean; empty: string }) {
  if (runs.length === 0) return <div className="empty">{empty}</div>;
  return (
    <div className="rows">
      {runs.map((r) => (
        <a key={`${r.source_id}/${r.run_id}`} className="row" href={href.run(r.source_id, r.run_id)}>
          <div style={{ minWidth: 0 }}>
            <div className="title">{runTitle(r)}</div>
            <div className="meta">
              {showRepo ? `${repoOf(r)}  ·  ` : ""}
              {r.issue_ref ?? r.task_source ?? "task"}
              {isWorking(r) && r.current_stage ? `  ·  ${r.current_stage}` : ""}
            </div>
          </div>
          <div className="meta">{money(r)}</div>
          <div className="meta">{isWorking(r) ? duration(r.elapsed_s) : ago(r.ended_at ?? r.last_event_at ?? r.started_at)}</div>
          <RunBadge run={r} />
        </a>
      ))}
    </div>
  );
}

const STAGE_NAMES: Record<string, string> = { intake: "Read", plan: "Plan", wall: "Checks", implement: "Build", verify: "Verify", fix: "Fix", commit: "Commit", seal: "Label", pr: "Pull request", deep: "Deep check" };

export function StageBar({ stages }: { stages: TimelineStage[] }) {
  if (stages.length === 0) return null;
  return (
    <div className="stages">
      {stages.map((s) => {
        const cls = s.status === "started" ? "now" : s.status === "completed" ? "done" : s.status === "failed" ? "failed" : "";
        const secs = s.started_at && s.ended_at ? (Date.parse(s.ended_at) - Date.parse(s.started_at)) / 1000 : null;
        return (
          <span key={s.stage} className={`stage ${cls}`} title={s.reason ?? ""}>
            {STAGE_NAMES[s.stage] ?? s.stage}
            {secs !== null && secs >= 1 ? <span className="muted">{duration(secs)}</span> : null}
          </span>
        );
      })}
    </div>
  );
}

export function AcceptanceTable({ rows, source }: { rows: AcceptanceRow[]; source?: "issue" | "plan" }) {
  if (rows.length === 0) return <div className="empty">This run has no acceptance lines to check.</div>;
  const met = rows.filter((r) => r.status === "met").length;
  return (
    <div>
      <div className="inline" style={{ justifyContent: "space-between", marginBottom: 10 }}>
        <span className="muted" style={{ fontSize: 13 }}>
          {source === "plan" ? "Written by Loki from the issue, which has no checklist" : "The issue's own words"}
        </span>
        <strong>
          {met} of {rows.length} met
        </strong>
      </div>
      <div className="bar">
        <i style={{ width: `${(met / rows.length) * 100}%` }} />
      </div>
      <div className="acc" style={{ marginTop: 8 }}>
        {rows.map((r, i) => (
          <div className="acc-row" key={i}>
            <span className={`dot ${r.status === "met" ? "met" : r.status === "unmet" ? "unmet" : ""}`}>
              {r.status === "met" ? <Check size={13} strokeWidth={3} /> : r.status === "unmet" ? <X size={13} strokeWidth={3} /> : <Minus size={13} />}
            </span>
            <div>
              <div>{r.line}</div>
              {r.status === "unmet" && r.reason ? <div className="why">{r.reason}</div> : null}
            </div>
            <span className="muted" style={{ fontSize: 13, whiteSpace: "nowrap" }}>
              {r.status === "met" ? (r.checks > 0 ? `${r.checks} check${r.checks === 1 ? "" : "s"} passed` : "met") : r.status === "unmet" ? "not met" : "waiting"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Counts for a set of runs: how many are safe to merge, need a person, or are still working. */
export function tally(runs: RunRow[]): { total: number; safe: number; needs: number; working: number; spend: number } {
  let safe = 0, needs = 0, working = 0, spend = 0;
  for (const r of runs) {
    const t = label(r).tone;
    if (t === "ok") safe++; else if (t === "live") working++; else if (t === "warn" || t === "bad") needs++;
    spend += typeof r.cost_usd === "number" ? r.cost_usd : r.partial_usd ?? 0;
  }
  return { total: runs.length, safe, needs, working, spend };
}

export function Stats({ runs }: { runs: RunRow[] }) {
  const t = tally(runs);
  const cell = (n: string, l: string) => (
    <div className="card stat">
      <div className="n">{n}</div>
      <div className="l">{l}</div>
    </div>
  );
  return (
    <div className="stats">
      {cell(String(t.safe), "safe to merge")}
      {cell(String(t.needs), "need you")}
      {cell(String(t.working), "working now")}
      {cell(`$${t.spend.toFixed(2)}`, `spent on ${t.total} run${t.total === 1 ? "" : "s"}`)}
    </div>
  );
}
