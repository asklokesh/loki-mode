// CPE-13 Cost and usage page. Measured, partial and unmeasured are always separate; unmeasured never reads as $0.
import { useEffect, useState } from "react";
import { Badge, Card, Chip, EmptyState, KpiTile, Spinner, Table } from "../../design/primitives";
import { fmtUsd } from "../../format";
import { getCost } from "./data";
import type { CostResponse, CostRow, Dim } from "./data";

const usd = fmtUsd;
const tok = (n: number) => n.toLocaleString("en-US");
const DIMS: Array<{ value: Dim; label: string }> = [
  { value: "day", label: "Day" }, { value: "model", label: "Model" }, { value: "repo", label: "Repo" }, { value: "provider", label: "Provider" },
];

export function BudgetBanner({ budget }: { budget: CostResponse["budget"] }) {
  const n = (k: number) => `${k} run${k === 1 ? "" : "s"}`;
  return (
    <Card data-testid="cost-budget" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div data-testid="cost-budget-subscription">
        <Badge tone="info">Subscription runs</Badge>{" "}
        no cap ({n(budget.subscription_runs)}): usage counts against your plan limits, no dollar figure is measured.
      </div>
      <div data-testid="cost-budget-api">
        <Badge tone="warning">API-key runs</Badge>{" "}
        {usd(budget.api_key_default_cap_usd)} cap per run by default ({n(budget.api_key_runs)}); <code>--max-cost</code> and loki.yaml <code>budgets.per_run</code> override it.
      </div>
    </Card>
  );
}

function Bar({ row, max }: { row: CostRow; max: number }) {
  const w = (v: number) => (max > 0 ? `${(v / max) * 100}%` : "0%");
  return (
    <div data-testid="cost-bar" role="img" aria-label={`measured ${usd(row.measured_usd)}, partial ${usd(row.partial_usd)}`} style={{ display: "flex", height: 8, minWidth: 120, background: "var(--cp-bg-3)", borderRadius: 4, overflow: "hidden" }}>
      <span data-part="measured" style={{ width: w(row.measured_usd), background: "var(--cp-accent)" }} />
      <span data-part="partial" style={{ width: w(row.partial_usd), background: "var(--cp-warning-fill)" }} />
    </div>
  );
}

export function CostPage() {
  const [dim, setDim] = useState<Dim>("day");
  const [data, setData] = useState<CostResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setData(null); setErr(null);
    getCost(dim).then((d) => { if (live) setData(d); }, (e: Error) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [dim]);

  if (err) return <EmptyState title="Cost unavailable" hint={err} />;
  if (!data) return <Spinner label="Loading cost" />;
  const t = data.totals;
  const max = Math.max(0, ...data.rows.map((r) => r.measured_usd + r.partial_usd));
  const label = DIMS.find((d) => d.value === dim)!.label;
  return (
    <div data-testid="cost-page" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h1 style={{ margin: 0, fontFamily: "var(--cp-font-serif)", fontWeight: 400 }}>Cost and usage</h1>
      <BudgetBanner budget={data.budget} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        <KpiTile label="Measured" value={<span data-testid="cost-measured">{usd(t.measured_usd)}</span>} trend={`${t.measured_runs} runs`} trendTone="success" />
        <KpiTile label="Partial (priced sessions only)" value={<span data-testid="cost-partial">{usd(t.partial_usd)}</span>} trend={`${t.partial_runs} runs`} trendTone="warning" />
        <KpiTile label="Unmeasured" value={<span data-testid="cost-unmeasured">{t.unmeasured_runs} runs</span>} trend="not measured" />
        <KpiTile label="Tokens in / out" value={<span data-testid="cost-tokens">{tok(t.input_tokens)} / {tok(t.output_tokens)}</span>} />
      </div>
      <div><Chip label="Group by" value={label} options={DIMS} onSelect={(v) => setDim(v as Dim)} /></div>
      {data.rows.length === 0 ? <EmptyState title="No runs yet" hint="Cost appears here once a run has been ingested." /> : (
        <Table
          caption={`Cost by ${label}`}
          columns={[label, "Runs", "Measured", "Partial", "Unmeasured", "Tokens in", "Tokens out", "Spend"]}
          rows={data.rows.map((r) => [
            r[dim] ?? "unknown", r.runs,
            r.measured_runs ? usd(r.measured_usd) : "not measured",
            r.partial_runs ? `${usd(r.partial_usd)} (partial)` : "none",
            r.unmeasured_runs ? `${r.unmeasured_runs} not measured` : "none",
            tok(r.input_tokens), tok(r.output_tokens),
            <Bar key="bar" row={r} max={max} />,
          ])}
        />
      )}
    </div>
  );
}

export const page = { id: "cost", path: "/cost", title: "Cost and usage", component: CostPage };
