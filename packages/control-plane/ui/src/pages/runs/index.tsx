// Runs: a dense table grouped by issue. A multi-attempt issue shows one row ("FireLater#17, 6 attempts, latest Failed") that expands to its attempts.
// A field with no data renders nothing. Titles are the issue or task title, never a run id.
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { Fragment, useMemo, useState, type CSSProperties } from "react";
import type { RunRow } from "../../api";
import { Button, Card, Chip, EmptyState, Input, Spinner } from "../../design/primitives";
import { EmptyState as FirstRun } from "../../Shell";
import { openNewRun } from "../compose/store";
import { useAllRuns } from "./data";
import { costOf, durationOf, groupByIssue, groupSummary, outcomeOf, runHref, verdictOf, whenOf, type IssueGroup } from "./issues";
import { OutcomeChip } from "./OutcomeChip";

const cell: CSSProperties = { padding: "12px 14px", verticalAlign: "top" };
const head: CSSProperties = { ...cell, textAlign: "left", fontSize: "var(--cp-text-sm)", fontWeight: 500, color: "var(--cp-text-muted)", borderBottom: "1px solid var(--cp-border)" };
const muted: CSSProperties = { color: "var(--cp-text-muted)", fontSize: "var(--cp-text-sm)" };
const link: CSSProperties = { color: "var(--cp-text)", textDecoration: "none" };

export function PrLink({ run }: { run: RunRow }) {
  if (!run.pr_url) return null;
  const m = /\/pull\/(\d+)/.exec(run.pr_url);
  return <a href={run.pr_url} target="_blank" rel="noreferrer" style={{ color: "var(--cp-accent)", display: "inline-flex", gap: 4, alignItems: "center", textDecoration: "none" }}>{m ? `PR #${m[1]}` : "PR"}<ExternalLink size={12} aria-hidden="true" /></a>;
}

function AttemptRow({ run, now }: { run: RunRow; now: number }) {
  return (
    <tr data-testid="attempt-row" style={{ background: "var(--cp-bg-3)" }}>
      <td style={{ ...cell, paddingLeft: 40 }}><a href={runHref(run)} style={{ ...link, color: "var(--cp-accent)" }}>Attempt</a></td>
      <td style={cell} />
      <td style={cell}><OutcomeChip verdict={verdictOf(run)} /></td>
      <td style={cell}><PrLink run={run} /></td>
      <td style={cell}>{costOf(run)}</td>
      <td style={cell}>{durationOf(run)}</td>
      <td style={{ ...cell, ...muted }}>{whenOf(run, now)}</td>
    </tr>
  );
}

function GroupRows({ g, now }: { g: IssueGroup; now: number }) {
  const [open, setOpen] = useState(false);
  const multi = g.attempts.length > 1;
  const summary = groupSummary(g);
  const r = g.latest;
  return (
    <Fragment>
      <tr data-testid="issue-row" data-attempts={g.attempts.length} style={{ borderTop: "1px solid var(--cp-border-light)" }}>
        <td style={cell}>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            {multi ? (
              <button type="button" data-testid="expand" aria-expanded={open} aria-label={open ? "Hide attempts" : "Show attempts"} onClick={() => setOpen((o) => !o)}
                style={{ background: "none", border: 0, padding: 2, cursor: "pointer", color: "var(--cp-text-muted)" }}>
                {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
              </button>
            ) : <span style={{ width: 18 }} />}
            <div style={{ minWidth: 0 }}>
              <a href={runHref(r)} data-testid="issue-title" style={link}>{g.title}</a>
              {summary ? <div data-testid="group-summary" style={muted}>{summary}</div> : g.ref ? <div style={muted}>{g.ref}</div> : null}
            </div>
          </div>
        </td>
        <td style={{ ...cell, ...muted }}>{g.repo}</td>
        <td style={cell}><OutcomeChip verdict={verdictOf(r)} /></td>
        <td style={cell}><PrLink run={r} /></td>
        <td style={cell}>{costOf(r)}</td>
        <td style={cell}>{durationOf(r)}</td>
        <td style={{ ...cell, ...muted }}>{whenOf(r, now)}</td>
      </tr>
      {multi && open ? g.attempts.map((a) => <AttemptRow key={`${a.source_id}/${a.run_id}`} run={a} now={now} />) : null}
    </Fragment>
  );
}

export interface RunFilter { outcome: string; repo: string; q: string }
export const NO_FILTER: RunFilter = { outcome: "", repo: "", q: "" };

export function filterGroups(groups: IssueGroup[], f: RunFilter): IssueGroup[] {
  const q = f.q.trim().toLowerCase();
  return groups.filter((g) => {
    if (f.outcome && outcomeOf(g.latest).label !== f.outcome) return false;
    if (f.repo && g.repo !== f.repo) return false;
    if (q && ![g.title, g.ref, g.repo].some((v) => (v ?? "").toLowerCase().includes(q))) return false;
    return true;
  });
}

export function RunsView({ runs, now = Date.now() }: { runs: RunRow[]; now?: number }) {
  const [f, setF] = useState<RunFilter>(NO_FILTER);
  const groups = useMemo(() => groupByIssue(runs), [runs]);
  const shown = useMemo(() => filterGroups(groups, f), [groups, f]);
  const outcomes = useMemo(() => [...new Set(groups.map((g) => outcomeOf(g.latest).label))].sort(), [groups]);
  const repos = useMemo(() => [...new Set(groups.map((g) => g.repo).filter((x): x is string => !!x))].sort(), [groups]);
  const filtered = f.outcome !== "" || f.repo !== "" || f.q !== "";
  return (
    <section data-testid="runs-page" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <header style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
        <h1 style={{ fontFamily: "var(--cp-font-serif)", fontWeight: 400, fontSize: "var(--cp-text-2xl)", margin: 0, marginRight: "auto" }}>Runs</h1>
        <Input aria-label="Search runs" placeholder="Search issues" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} style={{ maxWidth: 220 }} />
        <span data-testid="filter-outcome"><Chip label="Outcome" value={f.outcome || "All"} options={[{ value: "", label: "All" }, ...outcomes.map((o) => ({ value: o, label: o }))]} onSelect={(v) => setF({ ...f, outcome: v })} /></span>
        <span data-testid="filter-repo"><Chip label="Repo" value={f.repo || "All"} options={[{ value: "", label: "All" }, ...repos.map((o) => ({ value: o, label: o }))]} onSelect={(v) => setF({ ...f, repo: v })} /></span>
        <Button data-testid="new-run-button" onClick={() => openNewRun()}>New run</Button>
      </header>
      {runs.length === 0 ? <FirstRun /> : shown.length === 0 ? (
        <EmptyState title={filtered ? "No runs match these filters" : "No runs yet"} hint={filtered ? "Clear a filter or the search to see more." : "Use New run to start one from a registered repo."} />
      ) : (
        <Card style={{ padding: 0, overflow: "auto" }}>
          <table data-testid="runs-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--cp-text-base)" }}>
            <thead>
              <tr>{["Issue", "Repo", "Outcome", "PR", "Cost", "Duration", "When"].map((h) => <th key={h} scope="col" style={head}>{h}</th>)}</tr>
            </thead>
            <tbody>{shown.map((g) => <GroupRows key={g.key} g={g} now={now} />)}</tbody>
          </table>
        </Card>
      )}
    </section>
  );
}

export function RunsPage() {
  const { runs, error } = useAllRuns();
  if (runs === null) return error ? <EmptyState title="Could not load runs" hint={error} /> : <Spinner label="Loading runs" />;
  return <RunsView runs={runs} />;
}

export const page = { id: "runs", path: "/runs", title: "Runs", component: RunsPage, inSettings: false };
