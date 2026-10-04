// Pull requests and Repos: two plain lists derived from the same runs the Runs table uses. Empty fields render nothing.
import { useMemo, type CSSProperties } from "react";
import type { RunRow } from "../../api";
import { Card, EmptyState, Spinner } from "../../design/primitives";
import { useAllRuns } from "./data";
import { costOf, groupByIssue, runHref, verdictOf, whenOf, type IssueGroup } from "./issues";
import { OutcomeChip } from "./OutcomeChip";
import { PrLink } from "./index";

const cell: CSSProperties = { padding: "12px 14px", verticalAlign: "top" };
const head: CSSProperties = { ...cell, textAlign: "left", fontSize: "var(--cp-text-sm)", fontWeight: 500, color: "var(--cp-text-muted)", borderBottom: "1px solid var(--cp-border)" };
const muted: CSSProperties = { color: "var(--cp-text-muted)", fontSize: "var(--cp-text-sm)" };
const h1: CSSProperties = { fontFamily: "var(--cp-font-serif)", fontWeight: 400, fontSize: "var(--cp-text-2xl)", margin: 0 };

export function PullRequestsView({ runs, now = Date.now() }: { runs: RunRow[]; now?: number }) {
  const rows = useMemo(() => groupByIssue(runs).filter((g) => g.attempts.some((a) => a.pr_url)).map((g) => ({ g, r: g.attempts.find((a) => a.pr_url)! })), [runs]);
  return (
    <section data-testid="prs-page" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <h1 style={h1}>Pull requests</h1>
      {rows.length === 0 ? <EmptyState title="No pull requests yet" hint="A run that opens a PR lists it here." /> : (
        <Card style={{ padding: 0, overflow: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--cp-text-base)" }}>
            <thead><tr>{["Issue", "Repo", "Outcome", "PR", "When"].map((h) => <th key={h} scope="col" style={head}>{h}</th>)}</tr></thead>
            <tbody>
              {rows.map(({ g, r }) => (
                <tr key={g.key} data-testid="pr-row" style={{ borderTop: "1px solid var(--cp-border-light)" }}>
                  <td style={cell}><a href={runHref(r)} style={{ color: "var(--cp-text)", textDecoration: "none" }}>{g.title}</a></td>
                  <td style={{ ...cell, ...muted }}>{g.repo}</td>
                  <td style={cell}><OutcomeChip verdict={verdictOf(r)} /></td>
                  <td style={cell}><PrLink run={r} /></td>
                  <td style={{ ...cell, ...muted }}>{whenOf(r, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </section>
  );
}

export function PullRequestsPage() {
  const { runs, error } = useAllRuns();
  if (runs === null) return error ? <EmptyState title="Could not load pull requests" hint={error} /> : <Spinner label="Loading pull requests" />;
  return <PullRequestsView runs={runs} />;
}

export interface RepoRow { repo: string; issues: number; runs: number; latest: IssueGroup["latest"]; cost: number | null }

export function repoRows(runs: RunRow[]): RepoRow[] {
  const m = new Map<string, RunRow[]>();
  for (const r of runs) if (r.origin_repo) m.set(r.origin_repo, [...(m.get(r.origin_repo) ?? []), r]);
  return [...m].map(([repo, rs]) => {
    const priced = rs.filter((r) => typeof r.cost_usd === "number");
    const groups = groupByIssue(rs);
    return { repo, issues: groups.length, runs: rs.length, latest: groups[0]!.latest, cost: priced.length ? priced.reduce((a, r) => a + (r.cost_usd ?? 0), 0) : null };
  }).sort((a, b) => Date.parse(b.latest.started_at ?? "") - Date.parse(a.latest.started_at ?? ""));
}

export function ReposView({ runs, now = Date.now() }: { runs: RunRow[]; now?: number }) {
  const rows = useMemo(() => repoRows(runs), [runs]);
  return (
    <section data-testid="repos-page" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <h1 style={h1}>Repos</h1>
      {rows.length === 0 ? <EmptyState title="No repos yet" hint="Repos appear once a run has recorded its origin." /> : (
        <Card style={{ padding: 0, overflow: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--cp-text-base)" }}>
            <thead><tr>{["Repo", "Issues", "Runs", "Latest outcome", "Cost", "Last run"].map((h) => <th key={h} scope="col" style={head}>{h}</th>)}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.repo} data-testid="repo-row" style={{ borderTop: "1px solid var(--cp-border-light)" }}>
                  <td style={cell}>{r.repo}</td>
                  <td style={cell}>{r.issues}</td>
                  <td style={cell}>{r.runs}</td>
                  <td style={cell}><OutcomeChip verdict={verdictOf(r.latest)} /></td>
                  <td style={cell}>{costOf({ ...r.latest, cost_usd: r.cost, partial_usd: 0 })}</td>
                  <td style={{ ...cell, ...muted }}>{whenOf(r.latest, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </section>
  );
}

export function ReposPage() {
  const { runs, error } = useAllRuns();
  if (runs === null) return error ? <EmptyState title="Could not load repos" hint={error} /> : <Spinner label="Loading repos" />;
  return <ReposView runs={runs} />;
}

export const prsPage = { id: "pulls", path: "/pulls", title: "Pull requests", component: PullRequestsPage };
export const reposPage = { id: "repos", path: "/repos", title: "Repos", component: ReposPage };
