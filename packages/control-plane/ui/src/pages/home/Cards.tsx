// Session card grid under the composer: a pinned NEEDS INPUT section for BLOCKED runs (answered inline through the existing answer route),
// then Recent and Groups tabs with search and filter. All text comes from GET /v1/runs, /v1/notifications and the run detail; gaps read "unmeasured".
import { useEffect, useMemo, useState } from "react";
import { getRun, postAnswer, type RunRow } from "../../api";
import { Badge, Button, Card, GroupHead, VerdictBadge } from "../../design/primitives";
import { groupRuns } from "../../shell/grouping";
import { EmptyState } from "../../Shell";
import { useSessions } from "../../shell/AppShell";
import { UNMEASURED } from "../run/model";
import { get, type BlockedItem } from "./Home";
import { FILTERS, cardRepo, cardTitle, groupByRepo, matches, outcome, runKey, timeAgo, type Filter } from "./cardtext";

const href = (r: Pick<RunRow, "source_id" | "run_id">) => `#/runs/${encodeURIComponent(r.source_id)}/${encodeURIComponent(r.run_id)}`;
const CLAMP2 = { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", whiteSpace: "pre-line" } as const;

function receiptBadge(r: RunRow) {
  if (r.verdict === null) return null;
  if (r.attested === true) return <Badge tone={r.sig_checked === false ? "warning" : "success"} data-testid="badge-receipt">{r.sig_checked === false ? "Receipt unchecked" : "Receipt signed"}</Badge>;
  if (r.attested === false) return <Badge tone="warning" data-testid="badge-receipt">No attested receipt</Badge>;
  return <span data-testid="badge-receipt" style={{ fontSize: "var(--cp-text-sm)", color: "var(--cp-text-muted)" }}>receipt {UNMEASURED}</span>;
}

export function SessionCard({ run, now, question }: { run: RunRow; now: number; question?: string | null }) {
  const [l1, l2] = outcome(run, question);
  return (
    <a data-testid="session-card" href={href(run)} style={{ textDecoration: "none", color: "inherit", display: "block", minWidth: 0 }}>
      <Card interactive style={{ display: "flex", flexDirection: "column", gap: 8, height: "100%" }}>
        <div data-testid="card-title" title={cardTitle(run)} style={{ fontWeight: 600, fontSize: "var(--cp-text-md)", ...CLAMP2, whiteSpace: "normal", overflowWrap: "anywhere" }}>{cardTitle(run)}</div>
        <div data-testid="card-outcome" style={{ ...CLAMP2, fontSize: "var(--cp-text-base)", color: "var(--cp-text-2)", lineHeight: 1.4 }}>{l1}{"\n"}{l2}</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {question !== undefined ? <VerdictBadge verdict="BLOCKED" /> : <VerdictBadge run={run} />}
          {run.pr_url ? <Badge tone="info" data-testid="badge-pr">{run.pr_draft ? "Draft PR" : "PR"}</Badge> : null}
          {receiptBadge(run)}
        </div>
        <div style={{ display: "flex", gap: 8, color: "var(--cp-text-muted)", fontSize: "var(--cp-text-sm)", marginTop: "auto", minWidth: 0 }}>
          <span title={cardRepo(run)} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{cardRepo(run)}</span>
          <span style={{ flexShrink: 0 }}>{timeAgo(run.last_event_at ?? run.started_at, now)}</span>
        </div>
      </Card>
    </a>
  );
}

function NeedsInputCard({ run, now }: { run: RunRow; now: number }) {
  const [q, setQ] = useState<string | null | undefined>(undefined);
  const [text, setText] = useState("");
  const [state, setState] = useState<{ busy?: boolean; sent?: boolean; error?: string }>({});
  useEffect(() => {
    let live = true;
    getRun(run.source_id, run.run_id).then((d) => live && setQ(d.blocked_question ?? null), () => live && setQ(null));
    return () => { live = false; };
  }, [run.source_id, run.run_id]);
  const send = async () => {
    if (!text.trim() || state.busy) return;
    setState({ busy: true });
    try { await postAnswer(run.source_id, run.run_id, text.trim()); setState({ sent: true }); }
    catch (e) { setState({ error: (e as Error).message }); }
  };
  return (
    <div data-testid="needs-input-card" style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <SessionCard run={run} now={now} question={q === undefined ? null : q} />
      {q === null ? null : (
        <div style={{ display: "flex", gap: 6 }}>
          {state.sent ? (
            <span role="status" data-testid="answer-sent" style={{ fontSize: "var(--cp-text-base)", color: "var(--cp-text-2)" }}>Answer saved. Open the run to resume it.</span>
          ) : (
            <>
              <input data-testid="answer-input" aria-label={`Answer for ${cardTitle(run)}`} value={text} disabled={state.busy} placeholder="Type your answer" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void send(); }}
                style={{ flex: 1, minWidth: 0, border: "1px solid var(--cp-border)", borderRadius: 999, background: "var(--cp-card)", color: "var(--cp-text)", padding: "6px 12px", font: "inherit", fontSize: "var(--cp-text-base)" }} />
              <Button size="sm" data-testid="answer-send" disabled={!text.trim() || state.busy} onClick={() => void send()}>Answer</Button>
            </>
          )}
          {state.error ? <span role="alert" data-testid="answer-error" style={{ color: "var(--cp-error-ink)", fontSize: "var(--cp-text-sm)" }}>{state.error}</span> : null}
        </div>
      )}
    </div>
  );
}

const GRID = { display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" } as const;

type Tab = "recent" | "groups";

export function CardsView({ runs, blocked, now }: { runs: RunRow[]; blocked: BlockedItem[]; now: number }) {
  const [tab, setTab] = useState<Tab>("recent");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const blockedKeys = new Set(blocked.map((b) => `${b.source_id}/${b.run_id}`));
  const needs = runs.filter((r) => blockedKeys.has(runKey(r)));
  const rest = useMemo(() => runs.filter((r) => !blockedKeys.has(runKey(r)) && matches(r, q, filter)), [runs, blocked, q, filter]);
  return (
    <section data-testid="cards" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {needs.length > 0 ? (
        <div data-testid="needs-input">
          <div className="cp-eyebrow" style={{ marginBottom: 8 }}>NEEDS INPUT ({needs.length})</div>
          <div style={GRID}>{needs.map((r) => <NeedsInputCard key={runKey(r)} run={r} now={now} />)}</div>
        </div>
      ) : null}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <div role="tablist" aria-label="Sessions view" style={{ display: "inline-flex", gap: 4 }}>
          {(["recent", "groups"] as const).map((t) => (
            <Button key={t} role="tab" aria-selected={tab === t} data-testid={`tab-${t}`} size="sm" variant={tab === t ? "primary" : "ghost"} onClick={() => setTab(t)}>{t === "recent" ? "Recent" : "Groups"}</Button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <input data-testid="card-search" type="search" aria-label="Search sessions" placeholder="Search sessions" value={q} onChange={(e) => setQ(e.target.value)}
          style={{ border: "1px solid var(--cp-border)", borderRadius: 999, background: "var(--cp-card)", color: "var(--cp-text)", padding: "6px 12px", font: "inherit", fontSize: "var(--cp-text-base)", minWidth: 160 }} />
        <div role="group" aria-label="Filter by verdict" data-testid="card-filter" style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
          {FILTERS.map((f) => <Button key={f.value} size="sm" variant={filter === f.value ? "primary" : "ghost"} aria-pressed={filter === f.value} data-testid={`filter-${f.value}`} onClick={() => setFilter(f.value)}>{f.label}</Button>)}
        </div>
      </div>
      {rest.length === 0 ? (
        <p data-testid="cards-empty" style={{ color: "var(--cp-text-2)" }}>{runs.length === 0 ? "No sessions yet." : "No sessions match."}</p>
      ) : tab === "recent" ? (
        groupRuns(rest, now).map((g) => (
          <div key={g.name} data-testid="card-group" aria-label={g.name}>
            <GroupHead>{g.name}</GroupHead>
            <div style={GRID}>{g.runs.map((r) => <SessionCard key={runKey(r)} run={r} now={now} />)}</div>
          </div>
        ))
      ) : (
        groupByRepo(rest).map((g) => (
          <div key={g.repo} data-testid="card-group" aria-label={g.repo}>
            <GroupHead>{g.repo}</GroupHead>
            <div style={GRID}>{g.runs.map((r) => <SessionCard key={runKey(r)} run={r} now={now} />)}</div>
          </div>
        ))
      )}
    </section>
  );
}

export function Cards() {
  const { runs, error } = useSessions();
  const [blocked, setBlocked] = useState<BlockedItem[]>([]);
  useEffect(() => {
    let live = true;
    get<{ notifications: BlockedItem[] }>("/v1/notifications?kind=blocked&limit=50").then((n) => live && setBlocked(n.notifications), () => {});
    return () => { live = false; };
  }, [runs]);
  if (!runs) return error ? <p role="alert" data-testid="cards-error">Could not load sessions: {error}</p> : null;
  if (runs.length === 0) return <EmptyState />; // the existing import-this-folder state
  return <CardsView runs={runs} blocked={blocked} now={Date.now()} />;
}
