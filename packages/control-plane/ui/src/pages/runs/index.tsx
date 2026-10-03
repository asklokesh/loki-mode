// CPE-11: the runs table. Dense list of every run with filters, sortable columns, a per-repo rollup and live refresh.
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { authToken, listRuns, type RunRow } from "../../api";
import { Badge, Card, Chip, EmptyState, Input, Spinner, VerdictBadge } from "../../design/primitives";
import { NO_FILTERS, applyFilters, distinct, repoOf, rollupByRepo, sortRows, sourceOf, statusOf, type Filters, type SortKey } from "./logic";

export type Subscribe = (onChange: () => void) => () => void;

/** Subscribe to GET /v1/stream (CPE-05). fetch, not EventSource, so the bearer token can be sent. Reconnects after a drop. */
export const subscribeRunsStream: Subscribe = (onChange) => {
  const ctl = new AbortController();
  const base = (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE ?? "";
  (async () => {
    while (!ctl.signal.aborted) {
      try {
        const t = authToken();
        const res = await fetch(`${base}/v1/stream`, { headers: t ? { authorization: `Bearer ${t}` } : {}, signal: ctl.signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const rd = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await rd.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (/^event: run$/m.test(frame)) onChange();
          }
        }
      } catch { /* retry below */ }
      if (!ctl.signal.aborted) await new Promise((r) => setTimeout(r, 3000));
    }
  })();
  return () => ctl.abort();
};

const fmtUsd = (n: number | null): string => (n === null ? "unpriced" : `$${n.toFixed(2)}`);
const fmtDur = (s: number | null | undefined): string => {
  if (s === null || s === undefined) return "not measured";
  if (s < 60) return `${Math.round(s)}s`;
  return s < 3600 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
const fmtStart = (iso: string | null): string => (iso ? iso.replace("T", " ").slice(0, 16) : "not measured");

const COLS: Array<{ key: SortKey; label: string }> = [
  { key: "started", label: "Started" }, { key: "repo", label: "Repo" }, { key: "source", label: "Source" },
  { key: "status", label: "Status" }, { key: "verdict", label: "Verdict" }, { key: "cost", label: "Cost" }, { key: "elapsed", label: "Elapsed" },
];

const cell: CSSProperties = { padding: "6px 12px", whiteSpace: "nowrap" };
const head: CSSProperties = { ...cell, textAlign: "left", fontSize: "var(--cp-text-sm)", textTransform: "uppercase", color: "var(--cp-text-2)", background: "var(--cp-bg-3)" };

function Select({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <span data-testid={`filter-${label.toLowerCase()}`} data-value={value}>
      <Chip label={label} value={value || "all"} options={[{ value: "", label: "All" }, ...options.map((o) => ({ value: o, label: o }))]} onSelect={onChange} />
    </span>
  );
}

export function RunsPage({ subscribe = subscribeRunsStream }: { subscribe?: Subscribe | null }) {
  const [rows, setRows] = useState<RunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "started", dir: "desc" });
  const [grouped, setGrouped] = useState(false);

  const load = useCallback(() => {
    listRuns({}).then((r) => { setRows(r.runs); setError(null); }, (e: Error) => setError(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => (subscribe ? subscribe(load) : undefined), [subscribe, load]);

  const all = useMemo(() => rows ?? [], [rows]);
  const shown = useMemo(() => sortRows(applyFilters(all, f), sort.key, sort.dir), [all, f, sort]);
  const rollup = useMemo(() => rollupByRepo(shown), [shown]);
  const set = (k: keyof Filters) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  const filtered = JSON.stringify(f) !== JSON.stringify(NO_FILTERS);

  if (error && rows === null) return <EmptyState title="Could not load runs" hint={error} />;
  if (rows === null) return <Spinner label="Loading runs" />;

  return (
    <div data-testid="runs-page" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <Input aria-label="Search runs" placeholder="Search runs" value={f.q} onChange={(e) => set("q")(e.target.value)} style={{ maxWidth: 240 }} />
        <Select label="Status" value={f.status} options={["running", "completed"]} onChange={set("status")} />
        <Select label="Verdict" value={f.verdict} options={distinct(all.map((r) => r.verdict ?? "none"))} onChange={set("verdict")} />
        <Select label="Repo" value={f.repo} options={distinct(all.map(repoOf))} onChange={set("repo")} />
        <Select label="Source" value={f.source} options={distinct(all.map(sourceOf))} onChange={set("source")} />
        <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: "var(--cp-text-base)", color: "var(--cp-text-2)" }}>
          <input type="checkbox" data-testid="group-toggle" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} />
          Group by repo
        </label>
        <span data-testid="runs-count" style={{ marginLeft: "auto", fontSize: "var(--cp-text-base)", color: "var(--cp-text-2)" }}>{shown.length} of {all.length} runs</span>
      </div>

      {grouped && shown.length ? (
        <Card style={{ padding: 0, overflow: "auto" }}>
          <table data-testid="rollup" style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--cp-text-base)" }}>
            <thead><tr>{["Repo", "Runs", "Running", "Verified", "Cost"].map((h) => <th key={h} scope="col" style={head}>{h}</th>)}</tr></thead>
            <tbody>
              {rollup.map((g) => (
                <tr key={g.repo} data-testid="rollup-row" data-repo={g.repo} style={{ borderTop: "1px solid var(--cp-border-light)" }}>
                  <td style={cell}><button type="button" onClick={() => set("repo")(g.repo)} style={{ background: "none", border: 0, color: "var(--cp-accent)", cursor: "pointer", padding: 0, font: "inherit" }}>{g.repo}</button></td>
                  <td style={cell}>{g.runs}</td>
                  <td style={cell}>{g.running}</td>
                  <td style={cell}>{g.verified} of {g.runs}</td>
                  <td style={cell}>{fmtUsd(g.cost)}{g.cost !== null && g.unpriced ? ` (+${g.unpriced} unpriced)` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      {shown.length === 0 ? (
        <EmptyState title={filtered ? "No runs match these filters" : "No runs yet"} hint={filtered ? "Clear a filter or the search to see more." : "Start a run and it will appear here."} />
      ) : (
        <Card style={{ padding: 0, overflow: "auto" }}>
          <table data-testid="runs-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--cp-text-base)" }}>
            <thead>
              <tr>
                {COLS.map((c) => (
                  <th key={c.key} scope="col" aria-sort={sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} style={head}>
                    <button type="button" data-testid={`sort-${c.key}`} onClick={() => setSort((p) => ({ key: c.key, dir: p.key === c.key && p.dir === "desc" ? "asc" : "desc" }))} style={{ background: "none", border: 0, cursor: "pointer", font: "inherit", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "inherit", padding: 0 }}>
                      {c.label}{sort.key === c.key ? (sort.dir === "asc" ? " (asc)" : " (desc)") : ""}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={`${r.source_id}:${r.run_id}`} data-testid="run-row" data-run={r.run_id} style={{ borderTop: "1px solid var(--cp-border-light)" }}>
                  <td style={cell}><a href={`#/runs/${encodeURIComponent(r.source_id)}/${encodeURIComponent(r.run_id)}`} style={{ color: "var(--cp-accent)", textDecoration: "none" }}>{fmtStart(r.started_at)}</a></td>
                  <td style={cell}>{r.origin_repo ?? <span style={{ color: "var(--cp-text-2)" }}>no repo</span>}{r.issue_ref ? <span style={{ color: "var(--cp-text-2)" }}> {r.issue_ref}</span> : null}</td>
                  <td style={cell}>{sourceOf(r)}</td>
                  <td style={cell}><Badge tone={statusOf(r) === "running" ? "info" : "neutral"} pulse={statusOf(r) === "running"}>{statusOf(r)}</Badge></td>
                  <td style={cell}>{r.verdict ? <VerdictBadge verdict={r.verdict} /> : <span style={{ color: "var(--cp-text-2)" }}>none yet</span>}</td>
                  <td style={cell}>{fmtUsd(r.cost_usd)}</td>
                  <td style={cell}>{fmtDur(r.elapsed_s ?? r.wall_s)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

export const page = { id: "runs", path: "/runs", title: "Runs", component: RunsPage, inSettings: false };
