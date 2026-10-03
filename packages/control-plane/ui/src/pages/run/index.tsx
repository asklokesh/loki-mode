// Run thread (CPE-06): a run shown as a chat-like thread. Everything is from the runs API, the events log and run artifacts; an unknown value reads "not measured".
import { ExternalLink, FileDiff, GitPullRequest, Info, MessageCircleQuestion, ScrollText, ShieldCheck } from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { fmtUsd } from "../../format";
import { getRun, postAnswer, type RunDetailResponse } from "../../api";
import { Badge, Button, Card, Drawer, EmptyState, Message, Spinner, Textarea, VerdictBadge, VERDICT } from "../../design/primitives";
import { fetchArtifact, fetchEvents, followStream, type RunEvent } from "./stream";
import { buildTimeline } from "./timeline";

export const NOT_MEASURED = "not measured";
const LOG_CAP = 2000;

export function costLabel(r: Pick<RunDetailResponse, "cost_usd" | "partial_usd" | "measured_sessions" | "total_sessions">): string {
  if (r.cost_usd !== null && r.cost_usd !== undefined) return fmtUsd(r.cost_usd);
  if (r.partial_usd) return `at least ${fmtUsd(r.partial_usd)} (${r.measured_sessions} of ${r.total_sessions} sessions measured)`;
  return NOT_MEASURED;
}

const fmtS = (s: number | null | undefined) => (typeof s !== "number" ? NOT_MEASURED : s >= 60 ? `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s` : `${s.toFixed(1)}s`);

export function eventLine(e: RunEvent): string {
  const d = e.data;
  const detail = d == null ? "" : typeof d === "string" ? d : JSON.stringify(d);
  return [e.type, e.stage, detail.length > 160 ? `${detail.slice(0, 160)}...` : detail].filter(Boolean).join(" ");
}

function RunLog({ source, run }: { source: string; run: string }) {
  const [lines, setLines] = useState<RunEvent[]>([]);
  const [raw, setRaw] = useState(false);
  const last = useRef(-1);
  useEffect(() => {
    const ac = new AbortController();
    const add = (es: RunEvent[]) => {
      const fresh = es.filter((e) => e.seq > last.current);
      if (!fresh.length) return;
      last.current = fresh[fresh.length - 1]!.seq;
      setLines((p) => [...p, ...fresh].slice(-LOG_CAP));
    };
    void (async () => {
      add(await fetchEvents(source, run));
      while (!ac.signal.aborted) {
        await followStream(source, run, () => last.current, (e) => add([e]), ac.signal);
        if (!ac.signal.aborted) await new Promise((r) => setTimeout(r, 3000));
      }
    })();
    return () => ac.abort();
  }, [source, run]);
  const tl = buildTimeline(lines);
  return (
    <div>
      <div style={{ marginBottom: 6 }}><Button variant="ghost" size="sm" data-testid="run-raw-toggle" aria-pressed={raw} onClick={() => setRaw((x) => !x)}>{raw ? "Show timeline" : "Show raw"}</Button></div>
      {raw ? (
        <div data-testid="run-log" role="log" aria-live="polite" style={{ maxHeight: 280, overflow: "auto", fontFamily: "var(--cp-font-mono)", fontSize: "var(--cp-text-sm)", color: "var(--cp-text-2)" }}>
          {lines.length === 0 ? <div>No events yet.</div> : lines.map((e) => <div key={e.seq}>{`${e.seq}  ${eventLine(e)}`}</div>)}
        </div>
      ) : (
        <ol data-testid="run-timeline" aria-live="polite" style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: 360, overflow: "auto", fontSize: "var(--cp-text-sm)" }}>
          {tl.length === 0 ? <li>No events yet.</li> : tl.map((l) => (
            <li key={l.key} data-testid="timeline-line" data-outcome={l.outcome} style={{ display: "flex", flexWrap: "wrap", gap: "2px 12px", padding: "3px 0" }}>
              <strong style={{ minWidth: 120 }}>{l.label}</strong>
              <span>{l.outcome}</span>
              {l.kind === "stage" ? <><span data-testid="tl-duration">{typeof l.duration_s === "number" ? fmtS(l.duration_s) : "--"}</span><span data-testid="tl-model">{l.model ?? "--"}</span><span data-testid="tl-cost">{l.cost_usd === null ? "--" : fmtUsd(l.cost_usd)}</span></> : null}
              {l.detail ? <span data-testid="tl-detail" style={{ color: "var(--cp-text-muted)" }}>{l.detail}</span> : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Artifact({ source, run, name, empty }: { source: string; run: string; name: string; empty: string }) {
  const [text, setText] = useState<string | null | undefined>(undefined);
  useEffect(() => { let live = true; void fetchArtifact(source, run, name).then((t) => { if (live) setText(t); }); return () => { live = false; }; }, [source, run, name]);
  if (text === undefined) return <Spinner label={`Loading ${name}`} />;
  if (text === null) return <div>{empty}</div>;
  return <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "var(--cp-font-mono)", fontSize: "var(--cp-text-sm)", maxHeight: 360, overflow: "auto" }}>{text}</pre>;
}

function ReplyPrompt({ source, run, question, onSent }: { source: string; run: string; question: string; onSent: () => void }) {
  const [answer, setAnswer] = useState("");
  const [state, setState] = useState<{ busy: boolean; error?: string; sent?: boolean }>({ busy: false });
  const send = async () => {
    setState({ busy: true });
    try { await postAnswer(source, run, answer.trim()); setState({ busy: false, sent: true }); onSent(); }
    catch (e) { setState({ busy: false, error: (e as Error).message }); }
  };
  return (
    <Message icon={<MessageCircleQuestion size={16} />} title={<><Badge tone="info">BLOCKED</Badge> {question}</>}>
      <div data-testid="run-reply" style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
        <Textarea aria-label="Your reply" rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)} disabled={state.busy || state.sent} />
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Button onClick={send} disabled={!answer.trim() || state.busy || state.sent}>Send reply</Button>
          {state.sent ? <span role="status">Reply saved. Resume the run to continue.</span> : null}
          {state.error ? <span role="alert" style={{ color: "var(--cp-error)" }}>{state.error}</span> : null}
        </div>
      </div>
    </Message>
  );
}

export function RunThread({ source, run, slot, renderSlot }: { source: string; run: string; slot?: ReactNode; renderSlot?: (d: RunDetailResponse, reload: () => void) => ReactNode }) {
  const [d, setD] = useState<RunDetailResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const load = useCallback(() => { getRun(source, run).then((x) => { setD(x); setErr(null); }, (e: Error) => setErr(e.message)); }, [source, run]);
  const inProgress = !d || d.status === "running" || d.verdict === null;
  useEffect(() => {
    load();
    if (!inProgress) return;
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [load, inProgress]);

  if (err && !d) return <EmptyState title="Run not available" hint={err} />;
  if (!d) return <Spinner label="Loading run" />;

  const title = d.issue_ref ?? d.origin_repo ?? d.run_id;
  const sha = d.receipt?.sha256 ?? null;
  const blocked = !!d.blocked_question;
  return (
    <section data-testid="run-thread" style={{ maxWidth: 860, margin: "0 auto", padding: 16 }}>
      <header style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <h1 style={{ margin: 0, fontFamily: "var(--cp-font-serif)", fontWeight: 400, fontSize: "var(--cp-text-2xl)", flex: 1, minWidth: 0 }}>{title}</h1>
        {blocked ? <VerdictBadge verdict={VERDICT.BLOCKED} /> : d.verdict ? <VerdictBadge run={d} /> : <Badge pulse>running</Badge>}
        <span data-testid="run-elapsed">{fmtS(d.elapsed_s ?? d.wall_s)}</span>
        <span data-testid="run-cost">{costLabel(d)}</span>
        <span data-testid="run-header-slot" style={{ display: "inline-flex", gap: 8 }}>{slot}{renderSlot ? renderSlot(d, load) : null}</span>
        <Button variant="ghost" size="sm" onClick={() => setDrawer(true)}><Info size={14} /> Details</Button>
      </header>

      <div data-testid="run-stages">
        {d.stages.length === 0 ? <Message icon={<ScrollText size={16} />} title="Waiting for the first stage" /> : null}
        {d.stages.map((s, i) => (
          <Message key={`${s.stage}-${i}`} icon={<ScrollText size={16} />} title={s.stage} meta={s.status === "started" ? "running" : s.status}>
            <span data-testid="run-stage" data-status={s.status} />
          </Message>
        ))}
      </div>

      {d.blocked_question ? <ReplyPrompt source={source} run={run} question={d.blocked_question} onSent={load} /> : null}

      <Message icon={<ScrollText size={16} />} title="Timeline" expandable defaultOpen><RunLog source={source} run={run} /></Message>

      <Message icon={<FileDiff size={16} />} title="Diff" meta={d.files_touched?.length ? `${d.files_touched.length} files touched` : undefined} expandable>
        <div data-testid="run-diff"><Artifact source={source} run={run} name="diff.patch" empty="Diff not available for this run." /></div>
      </Message>

      <Message icon={<ShieldCheck size={16} />} title="Evidence and receipt" meta={sha ? `sha256 ${sha.slice(0, 16)} ${d.receipt?.signed ? "signed" : "unsigned"}` : "no receipt"} expandable>
        <div data-testid="run-receipt"><Artifact source={source} run={run} name="receipt.md" empty="Receipt not available for this run." /></div>
      </Message>

      <Message icon={<ShieldCheck size={16} />} title="NOT PROVEN">
        <div data-testid="run-not-proven">
          {d.not_proven.length ? <ul style={{ margin: 0, paddingLeft: 18 }}>{d.not_proven.map((x, i) => <li key={i}>{x}</li>)}</ul> : <span>{d.verdict ? "Nothing listed as not proven." : "Not known until the run finishes."}</span>}
        </div>
      </Message>

      <Message icon={<GitPullRequest size={16} />} title="Pull request">
        <div data-testid="run-pr">
          {d.pr_url ? (/^https?:\/\//.test(d.pr_url) ? <a href={d.pr_url} target="_blank" rel="noreferrer">{d.pr_url} <ExternalLink size={12} /></a> : <span>{d.pr_url}</span>) : "No PR."}
        </div>
      </Message>

      <Drawer open={drawer} title="Run details" onClose={() => setDrawer(false)}>
        <Card data-testid="run-details">
          <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", fontSize: "var(--cp-text-sm)" }}>
            {([
              ["source", d.source_id], ["run", d.run_id], ["repo", d.origin_repo ?? NOT_MEASURED], ["provider", d.provider ?? NOT_MEASURED], ["model", d.model ?? NOT_MEASURED],
              ["started", d.started_at ?? NOT_MEASURED], ["ended", d.ended_at ?? NOT_MEASURED],
              ["input tokens", d.input_tokens ?? NOT_MEASURED], ["output tokens", d.output_tokens ?? NOT_MEASURED],
              ["sessions measured", `${d.measured_sessions} of ${d.total_sessions}`], ["events", d.last_seq],
            ] as Array<[string, string | number]>).map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd style={{ margin: 0, fontFamily: "var(--cp-font-mono)" }}>{String(v)}</dd></Fragment>)}
          </dl>
        </Card>
      </Drawer>
    </section>
  );
}

/** Reads /runs/:source/:run (or /run/:source/:run) from the address when no props are given. */
function fromLocation(): { source: string; run: string } | null {
  const m = /\/runs?\/([^/]+)\/([^/?#]+)/.exec(globalThis.location?.pathname ?? "");
  return m ? { source: decodeURIComponent(m[1]!), run: decodeURIComponent(m[2]!) } : null;
}

export function RunPage({ source, run, slot, renderSlot }: { source?: string; run?: string; slot?: ReactNode; renderSlot?: (d: RunDetailResponse, reload: () => void) => ReactNode }) {
  const loc = source && run ? { source, run } : fromLocation();
  return loc ? <RunThread source={loc.source} run={loc.run} slot={slot} renderSlot={renderSlot} /> : <EmptyState title="No run selected" hint="Open a run from Home or Runs." />;
}

export const page = { id: "run", path: "/runs/:source/:run", title: "Run", component: RunPage };
