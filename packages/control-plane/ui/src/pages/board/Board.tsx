// Work board (CPE-18): a kanban of runs. Issue, Running, PR, then Verified or Not proven. Cards open the run thread.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { listRuns, watchRuns, type RunRow } from "../../api";
import { Badge, Card, EmptyState, Spinner, VerdictBadge } from "../../design/primitives";
import { columnOf, type ColumnId } from "./columns";

const TITLES: Record<ColumnId, string> = { issue: "Issue", running: "Running", pr: "PR open", verified: "Verified", notproven: "Not proven" };

function RunCard({ r }: { r: RunRow }) {
  const title = r.issue_ref ?? r.run_id;
  return (
    <a href={`#/runs/${encodeURIComponent(r.source_id)}/${encodeURIComponent(r.run_id)}`} data-testid="board-card" data-run={r.run_id} style={{ textDecoration: "none", color: "inherit" }}>
      <Card interactive compact>
        <div style={{ fontWeight: 600, fontSize: "var(--cp-text-md)", overflowWrap: "anywhere" }}>{title}</div>
        <div style={{ color: "var(--cp-text-muted)", fontSize: "var(--cp-text-xs)", marginTop: 2 }}>{r.origin_repo ?? "repo not recorded"}</div>
        <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
          {r.verdict ? <VerdictBadge verdict={r.verdict} /> : r.pr_url ? <Badge tone="info">{r.pr_draft ? "draft PR" : "PR open"}</Badge> : r.status === "running" ? <VerdictBadge verdict="running" /> : <Badge>queued</Badge>}
          {r.current_stage && !r.verdict ? <Badge>{r.current_stage}</Badge> : null}
        </div>
      </Card>
    </a>
  );
}

function Lane({ id, runs }: { id: ColumnId; runs: RunRow[] }) {
  return (
    <section data-testid={`lane-${id}`} aria-label={TITLES[id]} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--cp-text-xs)", color: "var(--cp-text-2)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
        <span>{TITLES[id]}</span><span>{runs.length}</span>
      </div>
      {runs.length === 0 ? <div style={{ color: "var(--cp-text-muted)", fontSize: "var(--cp-text-xs)" }}>none</div> : runs.map((r) => <RunCard key={`${r.source_id}/${r.run_id}`} r={r} />)}
    </section>
  );
}

function Column({ id, children }: { id: string; children: ReactNode }) {
  return <div data-testid={`col-${id}`} style={{ background: "var(--cp-bg-2)", borderRadius: "var(--cp-radius-lg)", padding: 10, display: "flex", flexDirection: "column", gap: 16, minWidth: 220 }}>{children}</div>;
}

export function Board() {
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => { listRuns().then((x) => { setRuns(x.runs); setErr(null); }).catch((e: Error) => setErr(e.message)); }, []);
  useEffect(() => { load(); return watchRuns(load); }, [load]);

  if (err && !runs) return <EmptyState title="Could not load runs" hint={err} />;
  if (!runs) return <div style={{ padding: 24 }}><Spinner label="Loading runs" /></div>;
  if (runs.length === 0) return <EmptyState title="No runs yet" hint="Start a run and it will appear here." />;

  const by = (c: ColumnId) => runs.filter((r) => columnOf(r) === c);
  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontFamily: "var(--cp-font-serif)", fontSize: "var(--cp-text-2xl)", margin: "0 0 16px" }}>Work</h1>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, alignItems: "start" }}>
        <Column id="issue"><Lane id="issue" runs={by("issue")} /></Column>
        <Column id="running"><Lane id="running" runs={by("running")} /></Column>
        <Column id="pr"><Lane id="pr" runs={by("pr")} /></Column>
        <Column id="done"><Lane id="verified" runs={by("verified")} /><Lane id="notproven" runs={by("notproven")} /></Column>
      </div>
    </div>
  );
}
