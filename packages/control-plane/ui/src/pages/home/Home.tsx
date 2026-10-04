// Overview: four honest KPI tiles, the NEEDS YOU inbox, and one row per issue (Latest by issue).
// No composer: starting a run is the New run picker. A field with no data renders nothing.
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { getDoctor, type DoctorCheck, type RunRow } from "../../api";
import { fmtUsd } from "../../format";
import { Badge, Button, Card, EmptyState, KpiTile, Spinner } from "../../design/primitives";
import { EmptyState as FirstRun } from "../../Shell"; // no runs at all: import and CLI first-run state
import { openNewRun } from "../compose/store";
import { PrLink } from "../runs";
import { useAllRuns } from "../runs/data";
import { groupByIssue, inboxOf, kpisOf, runHref, verdictOf, whenOf, type IssueGroup, type Kpis } from "../runs/issues";
import { OutcomeChip } from "../runs/OutcomeChip";

export const LATEST_ROWS = 12;
const muted: CSSProperties = { color: "var(--cp-text-muted)", fontSize: "var(--cp-text-sm)" };
const h2: CSSProperties = { fontFamily: "var(--cp-font-serif)", fontWeight: 400, fontSize: "var(--cp-text-xl)", margin: 0 };

export function kpiTiles(k: Kpis): { id: string; label: string; value: string; trend?: string }[] {
  const share = k.verifiedShare === null ? "No finished runs" : `${Math.round(k.verifiedShare * 100)}%`;
  return [
    { id: "kpi-runs", label: "Runs this week", value: String(k.runsWeek) },
    { id: "kpi-verified", label: "Verified share", value: share, trend: k.finishedWeek ? `${k.verifiedWeek} of ${k.finishedWeek} finished` : undefined },
    { id: "kpi-cost", label: "Cost this week", value: k.costWeek === null ? "No priced runs" : `${fmtUsd(k.costWeek)}${k.costPartial ? "+" : ""}` },
    { id: "kpi-needs", label: "Needs you", value: String(k.needsYou) },
  ];
}

function InboxGroup({ title, items, now, testid }: { title: string; items: IssueGroup[]; now: number; testid: string }) {
  if (items.length === 0) return null;
  return (
    <div data-testid={testid}>
      <div style={{ ...muted, fontWeight: 500, padding: "10px 16px 4px" }}>{title} ({items.length})</div>
      {items.map((g) => (
        <div key={g.key} data-testid="inbox-row" style={{ display: "flex", gap: 12, alignItems: "center", padding: "10px 16px", borderTop: "1px solid var(--cp-border-light)" }}>
          <a href={runHref(g.latest)} style={{ flex: 1, minWidth: 0, color: "var(--cp-text)", textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.title}</a>
          {g.repo ? <span style={muted}>{g.repo}</span> : null}
          <PrLink run={g.latest} />
          <span style={muted}>{whenOf(g.latest, now)}</span>
        </div>
      ))}
    </div>
  );
}

export function NeedsYou({ groups, now }: { groups: IssueGroup[]; now: number }) {
  const inbox = useMemo(() => inboxOf(groups, now), [groups, now]);
  const empty = inbox.blocked.length + inbox.partial.length + inbox.prs.length === 0;
  return (
    <section data-testid="needs-you" aria-label="Needs you" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h2 style={h2}>Needs you</h2>
      <Card style={{ padding: 0 }}>
        {empty ? <p data-testid="needs-you-empty" style={{ ...muted, margin: 0, padding: 16 }}>Nothing is waiting on you.</p> : (
          <>
            <InboxGroup testid="inbox-blocked" title="Runs waiting for your answer" items={inbox.blocked} now={now} />
            <InboxGroup testid="inbox-partial" title="Partly verified, review" items={inbox.partial} now={now} />
            <InboxGroup testid="inbox-prs" title="Pull requests to review" items={inbox.prs} now={now} />
          </>
        )}
      </Card>
    </section>
  );
}

export function LatestByIssue({ groups, now }: { groups: IssueGroup[]; now: number }) {
  const rows = groups.slice(0, LATEST_ROWS);
  return (
    <section data-testid="latest-by-issue" aria-label="Latest by issue" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <h2 style={{ ...h2, marginRight: "auto" }}>Latest by issue</h2>
        {groups.length > rows.length ? <a href="#/runs" style={{ color: "var(--cp-accent)", fontSize: "var(--cp-text-sm)" }}>All runs</a> : null}
      </div>
      {rows.length === 0 ? <FirstRun /> : (
        <Card style={{ padding: 0 }}>
          {rows.map((g, i) => (
            <div key={g.key} data-testid="latest-row" style={{ display: "flex", gap: 12, alignItems: "center", padding: "12px 16px", borderTop: i ? "1px solid var(--cp-border-light)" : undefined }}>
              <a href={runHref(g.latest)} style={{ flex: 1, minWidth: 0, color: "var(--cp-text)", textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.title}</a>
              {g.repo ? <span style={muted}>{g.repo}</span> : null}
              <OutcomeChip verdict={verdictOf(g.latest)} />
              <span style={{ ...muted, minWidth: 64, textAlign: "right" }}>{whenOf(g.latest, now)}</span>
            </div>
          ))}
        </Card>
      )}
    </section>
  );
}

/** null = still loading (renders nothing), {error} = the route failed, {checks} = real `loki doctor` results. */
export type DoctorState = { checks: DoctorCheck[] } | { error: string } | null;

const DOCTOR_TONE = { pass: "success", warn: "warning", fail: "error" } as const;
const DOCTOR_LABEL = { pass: "Pass", warn: "Warning", fail: "Failing" } as const;

export function GettingStarted({ doctor, noRuns }: { doctor: DoctorState; noRuns: boolean }) {
  if (!doctor) return null;
  const failing = "checks" in doctor && doctor.checks.some((c) => c.status !== "pass");
  if (!("error" in doctor) && !failing && !noRuns) return null;
  return (
    <section data-testid="getting-started" aria-label="Getting started" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h2 style={h2}>Getting started</h2>
      <Card style={{ padding: 0 }}>
        {"error" in doctor ? (
          <p data-testid="getting-started-error" role="alert" style={{ ...muted, margin: 0, padding: 16 }}>Could not run the setup checks: {doctor.error}</p>
        ) : doctor.checks.map((c, i) => (
          <div key={c.name} data-testid="doctor-check" data-status={c.status} style={{ display: "flex", gap: 12, alignItems: "center", padding: "10px 16px", borderTop: i ? "1px solid var(--cp-border-light)" : undefined }}>
            <Badge tone={DOCTOR_TONE[c.status]}>{DOCTOR_LABEL[c.status]}</Badge>
            <span style={{ flex: 1, minWidth: 0 }}>{c.name}</span>
            <span style={muted}>{c.detail}</span>
          </div>
        ))}
      </Card>
    </section>
  );
}

export function HomeView({ runs, now = Date.now(), doctor = null }: { runs: RunRow[]; now?: number; doctor?: DoctorState }) {
  const groups = useMemo(() => groupByIssue(runs), [runs]);
  const tiles = useMemo(() => kpiTiles(kpisOf(runs, groups, now)), [runs, groups, now]);
  return (
    <div data-testid="overview" style={{ display: "flex", flexDirection: "column", gap: 32, maxWidth: 960 }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1 style={{ fontFamily: "var(--cp-font-serif)", fontWeight: 400, fontSize: "var(--cp-text-2xl)", margin: 0, marginRight: "auto" }}>Overview</h1>
        <Button data-testid="new-run-button" onClick={() => openNewRun()}>New run</Button>
      </header>
      <div data-testid="kpis" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 }}>
        {tiles.map((t) => <div key={t.id} data-testid={t.id}><KpiTile label={t.label} value={t.value} trend={t.trend} /></div>)}
      </div>
      <GettingStarted doctor={doctor} noRuns={runs.length === 0} />
      <NeedsYou groups={groups} now={now} />
      <LatestByIssue groups={groups} now={now} />
    </div>
  );
}

export function Home(): ReactNode {
  const { runs, error } = useAllRuns();
  const [doctor, setDoctor] = useState<DoctorState>(null);
  useEffect(() => {
    let live = true;
    getDoctor().then((d) => live && setDoctor(d), (e: Error) => live && setDoctor({ error: e.message }));
    return () => { live = false; };
  }, []);
  if (runs === null) return error ? <EmptyState title="Could not load runs" hint={error} /> : <Spinner label="Loading overview" />;
  return <HomeView runs={runs} doctor={doctor} />;
}
