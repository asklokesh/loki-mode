// Plans and traceability: requirement -> plan step -> files changed -> evidence. A criterion with no evidence reads "not proven", never green.
import { useEffect, useState } from "react";
import { getRun, listRuns, type RunRow } from "../../api";
import { Badge, Card, EmptyState, Spinner, Table, Timeline, VerdictBadge, type Tone } from "../../design/primitives";
import { loadPlan, type PlanData } from "./api";
import type { RowStatus } from "./logic";

const TONE: Record<RowStatus, Tone> = { proven: "success", failed: "error", "not proven": "warning" };
const mono = { fontFamily: "var(--cp-font-mono)", fontSize: 12, wordBreak: "break-all" } as const;
const none = <span style={{ color: "var(--cp-text-2)" }}>none</span>;

export function Plans({ params }: { params: Record<string, string> }) {
  const source = params.source, run = params.run;
  if (!source || !run) return <RunPicker />;
  return <MatrixView source={source} run={run} />;
}

function RunPicker() {
  const [rows, setRows] = useState<RunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { let live = true; listRuns().then((r) => live && setRows(r.runs), (e: Error) => live && setError(e.message)); return () => { live = false; }; }, []);
  if (error) return <EmptyState title="Plans unavailable" hint={error} />;
  if (!rows) return <Spinner label="Loading runs" />;
  if (!rows.length) return <EmptyState title="No runs yet" hint="Start a run to see its plan and traceability here." />;
  return (
    <div data-testid="plans-picker">
      <Table caption="Pick a run" columns={["Run", "Outcome", "Started"]} rows={rows.map((r) => [
        <a key="a" href={`#/plans/${encodeURIComponent(r.source_id)}/${encodeURIComponent(r.run_id)}`} style={mono} data-testid="plans-pick">{r.run_id}</a>,
        r.verdict ? <VerdictBadge key="v" run={r} /> : "running",
        r.started_at ?? "not measured",
      ])} />
    </div>
  );
}

function MatrixView({ source, run }: { source: string; run: string }) {
  const [data, setData] = useState<PlanData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setData(null);
    (async () => {
      const detail = await getRun(source, run).catch(() => null);
      return loadPlan(source, run, detail?.stages ?? null, detail);
    })().then((d) => live && setData(d), (e: Error) => live && setError(e.message));
    return () => { live = false; };
  }, [source, run]);

  if (error) return <EmptyState title="Plan unavailable" hint={error} />;
  if (!data) return <Spinner label="Loading plan" />;
  const { matrix, have } = data;
  const missing = (["issue", "plan", "receipt"] as const).filter((k) => !have[k]);
  const proven = matrix.rows.filter((r) => r.status === "proven").length;

  return (
    <div data-testid="plans" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card style={{ padding: "14px 16px" }}>
        <div style={{ fontFamily: "var(--cp-font-mono)" }}>{run}</div>
        <div data-testid="plans-summary" style={{ color: "var(--cp-text-2)" }}>
          {matrix.rows.length ? `${proven} of ${matrix.rows.length} criteria proven` : "not measured: no criteria"}
          {data.verdict ? ` - verdict ${data.verdict}` : have.receipt ? " - verdict unavailable" : " - no receipt"}
        </div>
        {missing.length ? <div data-testid="plans-missing" style={{ color: "var(--cp-text-2)" }}>not available: {missing.map((m) => `${m}.json`).join(", ")}</div> : null}
      </Card>
      {data.stages?.length ? <Timeline stages={data.stages.map((s) => ({ label: s.stage, status: s.status === "completed" ? "success" : s.status === "failed" ? "error" : "pending" }))} /> : null}
      {matrix.rows.length === 0 ? <EmptyState title="No requirements found" hint="issue.json has no title or acceptance criteria for this run." /> : (
        <Table
          caption="Traceability matrix"
          columns={["Requirement", "Plan step", "Files changed", "Evidence", "Verdict"]}
          rows={matrix.rows.map((r) => [
            r.criterion,
            r.steps.length ? <ol key="s" style={{ margin: 0, paddingLeft: 16 }}>{r.steps.map((s) => <li key={s}>{s}</li>)}</ol> : none,
            r.files.length ? <div key="f" style={mono}>{r.files.map((f) => <div key={f}>{f}</div>)}</div> : none,
            r.evidence.length || r.inferred.length ? <div key="e">{r.evidence.map((c) => <div key={c.name} style={mono}>{c.result}: {c.name}</div>)}{r.inferred.map((c) => <div key={`i-${c.name}`} data-testid="inferred-hint" style={{ ...mono, color: "var(--cp-text-2)" }}>inferred, not recorded: {c.result}: {c.name}</div>)}</div> : none,
            <span key="v" data-testid="row-status" data-status={r.status}><Badge tone={TONE[r.status]}>{r.status === "not proven" ? (r.note === "link inferred" ? "NOT PROVEN (link inferred)" : "NOT PROVEN") : r.status.toUpperCase()}</Badge>{r.note ? <div style={{ color: "var(--cp-text-2)", fontSize: 12 }}>{r.note}</div> : null}</span>,
          ])}
        />
      )}
      {matrix.unmapped_files.length ? (
        <Card style={{ padding: "14px 16px" }} data-testid="plans-unmapped">
          <div style={{ color: "var(--cp-text-2)" }}>Changed files not tied to any requirement</div>
          <div style={mono}>{matrix.unmapped_files.map((f) => <div key={f}>{f}</div>)}</div>
        </Card>
      ) : null}
    </div>
  );
}
