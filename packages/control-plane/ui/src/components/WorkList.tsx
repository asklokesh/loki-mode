// The list pane: a heading and one row per run. Rows are links to #run/<source>/<run>.
import type { RunRow } from "../api";
import { href } from "../lib/router";
import { ago, chipText, money, repoName, runKey, runTitle, tone, type Tone } from "../lib/model";
import { Icon, type IconId } from "./Icon";

const GLYPH: Record<Tone, IconId | null> = { ok: "done", bad: "x", warn: "pause", idle: "done", run: null };
export const Dot = ({ t }: { t: Tone }) => <span className={`st ${t}`}>{GLYPH[t] ? <Icon id={GLYPH[t]!} /> : null}</span>;
export const Chip = ({ r }: { r: RunRow }) => <span className={`chip ${tone(r)}`}>{chipText(r)}</span>;

const sourceOf = (r: RunRow): string => r.issue_ref ?? (r.task_source ?? "brief");

export function WorkList({ title, sub, rows, selected, filter, onClearFilter, empty, more, onMore }: {
  title: string; sub: string; rows: RunRow[]; selected: string | null; filter: string | null; onClearFilter: () => void; empty: string; more: number; onMore: () => void;
}) {
  return (
    <section className="list" aria-label="Work">
      <div className="lh">
        <h1>{title}</h1>
        <p>{sub}</p>
        {filter ? <div className="filter">Repository: {filter}<button className="iconbtn" style={{ width: 22, height: 22 }} onClick={onClearFilter} aria-label="Clear repository filter"><Icon id="x" /></button></div> : null}
      </div>
      {rows.length === 0 ? <div className="empty">{empty}</div> : rows.map((r) => (
        <a key={runKey(r)} className="row" href={href.run(r.source_id, r.run_id)} aria-selected={selected === runKey(r)}>
          <span className="ic"><Dot t={tone(r)} /></span>
          <span className="t">{runTitle(r)}</span>
          <span className="r"><Chip r={r} /><small>{money(r)}</small></span>
          <span className="s">{repoName(r)} · {sourceOf(r)} · {ago(r.started_at ?? r.last_event_at)}</span>
        </a>
      ))}
      {more > 0 ? <button className="more" onClick={onMore}>Show {more} more</button> : null}
    </section>
  );
}
