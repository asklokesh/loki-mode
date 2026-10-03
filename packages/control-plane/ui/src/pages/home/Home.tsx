// Home (CPE-12): KPI tiles, recent runs and the BLOCKED inbox, all from /v1/stats, /v1/runs and /v1/notifications. Anything the API does not carry reads "not measured".
import { useEffect, useState } from "react";
import { authToken, type RunRow } from "../../api";
import { fmtUsd } from "../../format";
import { EmptyState } from "../../Shell";
import { Badge, Card, KpiTile, Spinner, Table, VerdictBadge, VERDICT } from "../../design/primitives";

export const NOT_MEASURED = "not measured";
const DAY = 86_400_000;

export interface Stats {
  since: string | null;
  runs_total: number;
  runs_finished: number;
  runs_running: number;
  by_verdict: Record<string, number>;
  blocked_waiting: number;
  verified_rate: number | null;
  verified_unchecked?: number;
  breakdown?: { verified: number; failed: number; already_satisfied: number; other: number };
  keys_configured?: boolean;
  cost: { measured_usd: number | null; measured_runs: number; partial_usd: number | null; partial_runs: number; label: "measured" | "partial" | "not measured" };
  receipts: { total: number; signed: number };
}
export interface BlockedItem { id: string; kind: string; ts: string; source_id: string; run_id: string; title: string; link: string }

export interface HomeData { today: Stats; week: Stats; runs: RunRow[]; blocked: BlockedItem[]; blockedTotal: number }

const base = (): string => (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE ?? "";

async function get<T>(path: string): Promise<T> {
  const t = authToken();
  const res = await fetch(`${base()}${path}`, { headers: t ? { authorization: `Bearer ${t}` } : {} });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function loadHome(now: number): Promise<HomeData> {
  const d = new Date(now);
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
  const [today, week, runs, notes] = await Promise.all([
    get<Stats>(`/v1/stats?since=${encodeURIComponent(midnight)}`),
    get<Stats>(`/v1/stats?since=${encodeURIComponent(new Date(now - 7 * DAY).toISOString())}`),
    get<{ runs: RunRow[] }>("/v1/runs?limit=8"),
    get<{ notifications: BlockedItem[]; total: number }>("/v1/notifications?kind=blocked&limit=20"),
  ]);
  return { today, week, runs: runs.runs.slice(0, 8), blocked: notes.notifications, blockedTotal: notes.total };
}

const money = fmtUsd;
const runHref = (s: string, r: string): string => `/r/${encodeURIComponent(s)}/${encodeURIComponent(r)}`;

export function costTile(c: Stats["cost"]): { value: string; trend: string } {
  if (c.label === "not measured") return { value: NOT_MEASURED, trend: "no priced runs" };
  if (c.label === "measured") return { value: money(c.measured_usd ?? 0), trend: "measured" };
  const known = (c.measured_usd ?? 0) + (c.partial_usd ?? 0);
  return { value: `${money(known)}+`, trend: `partial, ${c.partial_runs} run${c.partial_runs === 1 ? "" : "s"} unpriced` };
}

function runCost(r: Pick<RunRow, "cost_usd" | "partial_usd">): string {
  if (r.cost_usd !== null && r.cost_usd !== undefined) return money(r.cost_usd);
  return r.partial_usd ? `at least ${money(r.partial_usd)}` : NOT_MEASURED;
}

export function HomeView({ data }: { data: HomeData }) {
  const { today, week, runs, blocked, blockedTotal } = data;
  const rate = week.verified_rate;
  const unchecked = week.verified_unchecked ?? 0;
  // No key configured: successes cannot be verified, so a 0% rate would mislabel them as failing. Show it as not measured.
  const rateUnmeasured = rate !== null && week.keys_configured === false && unchecked > 0;
  const b = week.breakdown;
  const split = b ? `${b.verified} verified, ${b.failed} failed, ${b.already_satisfied} already satisfied, ${b.other} other` : undefined;
  const rateTrend = rateUnmeasured ? `${unchecked} signature not checked` : split ? `${split}${unchecked ? `, ${unchecked} signature not checked` : ""}` : undefined;
  const cost = costTile(week.cost);
  if (week.runs_total === 0 && runs.length === 0 && blockedTotal === 0) {
    return <EmptyState />;
  }
  return (
    <section data-testid="home" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <h1 style={{ fontFamily: "var(--cp-font-serif)", fontSize: "var(--cp-text-2xl)", margin: 0 }}>Home</h1>
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        <div data-testid="kpi-today"><KpiTile label="Runs today" value={String(today.runs_total)} trend={today.runs_running ? `${today.runs_running} running` : undefined} /></div>
        <div data-testid="kpi-verified"><KpiTile label="Verified rate, 7 days" value={rate === null ? "--" : rateUnmeasured ? `${NOT_MEASURED}: no verification key` : `${Math.round(rate * 100)}%`} trend={rateTrend} trendTone={rate === null || rateUnmeasured ? "neutral" : rate >= 0.8 ? "success" : "warning"} /></div>
        <div data-testid="kpi-cost"><KpiTile label="Cost, 7 days" value={cost.value} trend={cost.trend} trendTone={week.cost.label === "partial" ? "warning" : "neutral"} /></div>
        <div data-testid="kpi-blocked"><KpiTile label="BLOCKED waiting" value={String(blockedTotal)} trend={blockedTotal ? "needs your answer" : undefined} trendTone="info" /></div>
      </div>

      <div>
        <h2 style={{ fontSize: "var(--cp-text-md)", margin: "0 0 8px" }}>Blocked inbox</h2>
        {blocked.length === 0 ? (
          <Card data-testid="blocked-empty" style={{ color: "var(--cp-text-2)" }}>Nothing is waiting for you.</Card>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {blocked.map((b) => (
              <a key={b.id} data-testid="blocked-item" href={runHref(b.source_id, b.run_id)} style={{ textDecoration: "none", color: "inherit" }}>
                <Card interactive compact style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
                  <span>{b.title}</span>
                  <Badge tone="info">Answer</Badge>
                </Card>
              </a>
            ))}
          </div>
        )}
      </div>

      <div>
        <h2 style={{ fontSize: "var(--cp-text-md)", margin: "0 0 8px" }}>Recent runs</h2>
        {runs.length === 0 ? (
          <Card style={{ color: "var(--cp-text-2)" }}>No runs yet.</Card>
        ) : (
          <div data-testid="recent-runs">
            <Table
              caption="Recent runs"
              columns={["Run", "Verdict", "Cost", "Model"]}
              rows={runs.map((r) => [
                <a key="l" data-testid="recent-run" href={runHref(r.source_id, r.run_id)} style={{ fontFamily: "var(--cp-font-mono)", color: "var(--cp-accent)" }}>{r.origin_repo ?? r.issue_ref ?? r.run_id}</a>,
                r.verdict ? <VerdictBadge key="v" run={r} /> : <Badge key="v" pulse>running</Badge>,
                runCost(r),
                r.model ?? NOT_MEASURED,
              ])}
            />
          </div>
        )}
      </div>
    </section>
  );
}

export function Home({ now = Date.now() }: { now?: number }) {
  const [st, set] = useState<{ data: HomeData | null; error: string | null }>({ data: null, error: null });
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let first = true;
    const load = () => loadHome(first ? now : Date.now()).then(
      (data) => { first = false; if (live) { set({ data, error: null }); timer = setTimeout(load, 10_000); } },
      (e: Error) => { if (live) { set((p) => ({ data: p.data, error: e.message })); timer = setTimeout(load, 10_000); } },
    );
    load();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, []); // now seeds only the first load
  if (!st.data) return st.error ? <p role="alert" data-testid="home-error">Could not load Home: {st.error}</p> : <Spinner label="Loading Home" />;
  return <HomeView data={st.data} />;
}
