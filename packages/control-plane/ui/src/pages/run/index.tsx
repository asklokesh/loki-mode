// Run page (CP-REDESIGN): header, a terminal-style panel (stages left, human timeline right), then changed files, evidence, NOT PROVEN, the PR and raw JSON.
// Every value comes from the runs API, the events log and run artifacts; an unknown value reads "unmeasured". Nothing is filler.
import { ExternalLink, GitPullRequest, MessageCircleQuestion, RotateCcw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { fmtUsd } from "../../format";
import { getRun, postAnswer, type RunDetailResponse } from "../../api";
import { Badge, Button, Card, EmptyState, Spinner, Textarea } from "../../design/primitives";
import { displayOutcome, stripAnsi, type OutcomeTone } from "../../display";
import { postControl } from "../run-controls";
import { postRun } from "../compose/api";
import { verifyRun, type VerifyResult } from "../receipts/api";
import { fetchArtifact, fetchEvents, followStream, type RunEvent } from "./stream";
import { buildTimeline } from "./timeline";
import { changedFilesFor, clock, describeLine, elapsedLabel, notProvenItem, stageProgress, UNMEASURED } from "./model";
import { evidenceFacts, factText, OWN_RULES_TEXT, rawWhy, runOutcome, whyForRun, type RunDetail } from "./facts";

export const NOT_MEASURED = UNMEASURED;
const LOG_CAP = 2000;

const TONE: Record<OutcomeTone, "success" | "warning" | "error" | "neutral"> = { good: "success", warn: "warning", bad: "error", neutral: "neutral" };
/** A verdict badge that prints the one display label, never the enum. */
function OutcomeBadge({ verdict, label, tone, testid }: { verdict?: string | null; label?: string; tone?: OutcomeTone; testid?: string }) {
  const o = label ? { label, tone: tone ?? "neutral" } : displayOutcome(verdict);
  return <Badge tone={TONE[o.tone]} pulse={o.label === "Running"} data-testid={testid} style={{ textTransform: "none", letterSpacing: 0 }}>{o.label}</Badge>;
}

export function costLabel(r: Pick<RunDetailResponse, "cost_usd" | "partial_usd" | "measured_sessions" | "total_sessions">): string {
  if (r.cost_usd !== null && r.cost_usd !== undefined) return fmtUsd(r.cost_usd);
  if (r.partial_usd) return `at least ${fmtUsd(r.partial_usd)} (${r.measured_sessions} of ${r.total_sessions} sessions measured)`;
  return NOT_MEASURED;
}

export function eventLine(e: RunEvent): string {
  const d = e.data;
  const detail = d == null ? "" : typeof d === "string" ? d : JSON.stringify(d);
  return [e.type, e.stage, detail.length > 160 ? `${detail.slice(0, 160)}...` : detail].filter(Boolean).join(" ");
}

/** The run's events: one paged read, then the live stream with resume. */
function useEvents(source: string, run: string): RunEvent[] {
  const [lines, setLines] = useState<RunEvent[]>([]);
  const last = useRef(-1);
  useEffect(() => {
    const ac = new AbortController();
    last.current = -1;
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
  return lines;
}

function useArtifact(source: string, run: string, name: string): string | null | undefined {
  const [text, setText] = useState<string | null | undefined>(undefined);
  useEffect(() => { let live = true; void fetchArtifact(source, run, name).then((t) => { if (live) setText(t); }); return () => { live = false; }; }, [source, run, name]);
  return text;
}

const OUTCOME_COLOR: Record<string, string> = { completed: "var(--cp-term-green)", running: "var(--cp-term-purple)", failed: "var(--cp-term-red)", skipped: "var(--cp-term-amber)" };
const stageColor = (status: string): string => OUTCOME_COLOR[status === "started" ? "running" : status] ?? "var(--cp-term-dim)";

function Dot({ color, pulse }: { color: string; pulse?: boolean }) {
  return <span aria-hidden="true" className={pulse ? "cp-pulse" : undefined} style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }} />;
}

function Stages({ d }: { d: RunDetailResponse }) {
  return (
    <aside className="cp-term-side" data-testid="run-stages" aria-label="Stages">
      <div style={{ color: "var(--cp-term-dim)", marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.12em", fontSize: 10 }}>Stages</div>
      {d.stages.length === 0 ? <div style={{ color: "var(--cp-term-muted)" }}>no stages recorded yet</div> : null}
      {d.stages.map((s, i) => (
        <div key={`${s.stage}-${i}`} data-testid="run-stage" data-status={s.status} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", color: s.status === "started" ? "var(--cp-term-lilac)" : "var(--cp-term-text)" }}>
          <Dot color={stageColor(s.status)} pulse={s.status === "started"} />
          <span className="cp-trunc" style={{ flex: 1 }}>{s.stage}</span>
          {s.reason ? <span data-testid="run-stage-reason" className="cp-trunc" style={{ maxWidth: 80, color: "var(--cp-term-muted)" }} title={s.reason}>{s.reason}</span> : s.status === "skipped" ? <span data-testid="run-stage-reason" style={{ color: "var(--cp-term-muted)" }}>no reason recorded</span> : null}
        </div>
      ))}
    </aside>
  );
}

function Timeline({ events, awaiting }: { events: RunEvent[]; awaiting: boolean }) {
  const tl = buildTimeline(events);
  if (tl.length === 0) return <div data-testid="run-timeline" style={{ color: "var(--cp-term-muted)", fontSize: 12 }}>{awaiting ? "Waiting for the first event" : "No events recorded for this run."}</div>;
  return (
    <ol data-testid="run-timeline" aria-live="polite" style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {tl.map((l) => {
        const isStage = l.kind === "stage";
        return (
          <li key={l.key} className="cp-tl-row" data-testid="timeline-line" data-outcome={l.outcome}>
            <span data-testid="tl-time" style={{ fontFamily: "var(--cp-font-mono)", color: "var(--cp-term-dim)" }}>{clock(l.ts) ?? UNMEASURED}</span>
            <span style={{ display: "flex", alignItems: "flex-start", gap: 6, fontFamily: "var(--cp-font-mono)", color: OUTCOME_COLOR[l.outcome] ?? "var(--cp-term-lilac)" }}>
              <span style={{ marginTop: 6 }}><Dot color={OUTCOME_COLOR[l.outcome] ?? "var(--cp-term-purple)"} pulse={l.outcome === "running"} /></span>
              <strong data-testid="tl-label" className="cp-trunc" style={{ fontWeight: 500 }}>{l.label}</strong>
            </span>
            <span data-testid="tl-desc" style={{ color: "var(--cp-term-text)" }}>{describeLine(l)}</span>
            {isStage ? (
              <span className="cp-tl-meta">
                <span data-testid="tl-duration">{typeof l.duration_s === "number" ? elapsedLabel(l.duration_s) : l.outcome === "running" ? "running" : UNMEASURED}</span>
                <span data-testid="tl-model">{l.model ?? UNMEASURED}</span>
                <span data-testid="tl-cost">{l.cost_usd === null ? UNMEASURED : fmtUsd(l.cost_usd)}</span>
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

const card: CSSProperties = { display: "flex", flexDirection: "column", gap: 10 };
function Section({ title, meta, children, testid }: { title: string; meta?: ReactNode; children: ReactNode; testid?: string }) {
  return (
    <Card data-testid={testid} style={card}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h2 className="cp-display" style={{ margin: 0, fontSize: 18 }}>{title}</h2>
        {meta ? <span style={{ color: "var(--cp-text-muted)", fontSize: "var(--cp-text-base)" }}>{meta}</span> : null}
      </div>
      {children}
    </Card>
  );
}

function ChangedFiles({ d, patch }: { d: RunDetailResponse; patch: string | null | undefined }) {
  const got = changedFilesFor(patch, d.diff_stat);
  const names = d.files_touched ?? [];
  const files = got?.files ?? null;
  const added = files?.reduce((n, f) => n + (f.added ?? 0), 0) ?? 0;
  const removed = files?.reduce((n, f) => n + (f.removed ?? 0), 0) ?? 0;
  const KIND = { added: ["+", "var(--cp-success-ink)"], deleted: ["-", "var(--cp-error-ink)"], modified: ["~", "var(--cp-warning-ink)"] } as const;
  const count = (n: number | null, sign: string) => (n === null ? "binary" : `${sign}${n}`);
  return (
    <Section title="Changed files" testid="run-diff" meta={files && files.length ? `${files.length} files, +${added} -${removed}${got?.source === "git" ? " (from the receipt's commit range)" : ""}` : names.length ? `${names.length} files touched` : undefined}>
      {files && files.length ? (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, fontFamily: "var(--cp-font-mono)", fontSize: "var(--cp-text-base)" }}>
          {files.map((f) => (
            <li key={f.path} data-testid="changed-file" style={{ display: "flex", gap: 10, padding: "3px 0" }}>
              <span style={{ color: KIND[f.kind][1], width: 12 }}>{KIND[f.kind][0]}</span>
              <span className="cp-trunc" style={{ flex: 1 }} title={f.path}>{f.path}</span>
              <span style={{ color: "var(--cp-success-ink)" }}>{count(f.added, "+")}</span>
              <span style={{ color: "var(--cp-error-ink)" }}>{f.removed === null ? "" : count(f.removed, "-")}</span>
            </li>
          ))}
        </ul>
      ) : names.length ? (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, fontFamily: "var(--cp-font-mono)", fontSize: "var(--cp-text-base)" }}>
          {names.map((n) => <li key={n} data-testid="changed-file" className="cp-trunc" title={n}>{n} <span style={{ color: "var(--cp-text-muted)" }}>(line counts {UNMEASURED})</span></li>)}
        </ul>
      ) : <span data-testid="changed-files-unmeasured">{patch === undefined ? <Spinner label="Loading diff" /> : `Changed files ${UNMEASURED}: no diff or commit range could be read for this run.`}</span>}
    </Section>
  );
}

function Row({ k, children, testid }: { k: string; children: ReactNode; testid: string }) {
  return (
    <div data-testid={testid} style={{ display: "flex", gap: 12, alignItems: "baseline", padding: "3px 0", borderBottom: "1px solid var(--cp-border)" }}>
      <span style={{ width: 120, flexShrink: 0, color: "var(--cp-text-muted)" }}>{k}</span>
      <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{children}</span>
    </div>
  );
}

function Evidence({ d, source, run, receipt, receiptJson, events }: { d: RunDetailResponse; source: string; run: string; receipt: string | null | undefined; receiptJson: string | null | undefined; events: RunEvent[] }) {
  const [v, setV] = useState<{ busy: boolean; res?: VerifyResult; error?: string }>({ busy: false });
  const [showRaw, setShowRaw] = useState(false);
  const sha = d.receipt?.sha256 ?? null;
  const { facts, state } = evidenceFacts(receiptJson, events);
  const go = async () => {
    setV({ busy: true });
    try { setV({ busy: false, res: await verifyRun(source, run) }); } catch (e) { setV({ busy: false, error: (e as Error).message }); }
  };
  const base = facts.base ?? (state === "read" ? null : d.diff_stat?.base ?? null), head = facts.head ?? (state === "read" ? null : d.diff_stat?.head ?? null);
  const shown = (v: string | null, n: number): string => (v ? v.slice(0, n) : factText(null, state));
  const rv = facts.verdict ?? d.receipt?.verdict ?? null;
  const sig = !d.receipt ? UNMEASURED : !d.receipt.signed ? "unsigned" : d.sig_checked ? "signed, signature checked" : "signed, signature not checked";
  const ck = facts.checks;
  return (
    <Section title="Evidence and receipt" testid="run-receipt" meta={sha ? `sha256 ${sha.slice(0, 16)}` : "no receipt"}>
      <div data-testid="receipt-rows" style={{ display: "flex", flexDirection: "column", fontSize: "var(--cp-text-base)" }}>
        <Row k="Verdict" testid="rr-verdict">{rv ? `receipt says ${displayOutcome(rv).label}` : factText(null, state)}</Row>
        <Row k="Diff hash" testid="rr-diff"><code title={facts.diffSha ?? undefined}>{shown(facts.diffSha, 16)}</code></Row>
        <Row k="Base" testid="rr-base"><code title={base ?? undefined}>{shown(base, 12)}</code></Row>
        <Row k="Head" testid="rr-head"><code title={head ?? undefined}>{shown(head, 12)}</code></Row>
        <Row k="Signature" testid="rr-sig">{sig}</Row>
        <Row k="Checks run" testid="rr-checks">{ck ? (ck.total === 0 ? "none recorded" : `${ck.total} run: ${ck.pass} passed, ${ck.fail} failed${ck.notRun ? `, ${ck.notRun} not run` : ""}`) : factText(null, state)}</Row>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Button variant="secondary" size="sm" data-testid="run-verify" disabled={!sha || v.busy} onClick={() => void go()}><ShieldCheck size={13} aria-hidden="true" /> {v.busy ? "Verifying" : "Verify"}</Button>
        <Button variant="ghost" size="sm" data-testid="receipt-raw-toggle" aria-pressed={showRaw} onClick={() => setShowRaw((x) => !x)}>{showRaw ? "Hide raw" : "Show raw"}</Button>
        {!sha ? <span style={{ color: "var(--cp-text-muted)" }}>No receipt to verify {UNMEASURED}.</span> : null}
        {v.res ? <span data-testid="run-verify-result" role="status"><OutcomeBadge verdict={v.res.verdict} /> {stripAnsi(v.res.reasons[0] ?? "")}</span> : null}
        {v.error ? <span role="alert" data-testid="run-verify-error" style={{ color: "var(--cp-error-ink)" }}>{v.error}</span> : null}
      </div>
      {showRaw ? (receipt === undefined ? <Spinner label="Loading receipt" /> : receipt === null ? <div data-testid="receipt-raw">Receipt text not available for this run.</div> : (
        <pre data-testid="receipt-raw" style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "var(--cp-font-mono)", fontSize: "var(--cp-text-sm)", maxHeight: 280, overflow: "auto", color: "var(--cp-text-2)" }}>{receipt}</pre>
      )) : null}
    </Section>
  );
}

function NotProven({ d }: { d: RunDetailResponse }) {
  return (
    <Section title="NOT PROVEN" testid="run-not-proven" meta={d.not_proven.length ? `${d.not_proven.length} item${d.not_proven.length === 1 ? "" : "s"}` : undefined}>
      {d.not_proven.length ? (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          {d.not_proven.map((x, i) => {
            const it = notProvenItem(x);
            return (
              <li key={i} data-testid="not-proven-item" style={{ display: "flex", gap: 10, alignItems: "flex-start", justifyContent: "space-between" }}>
                <span style={{ minWidth: 0 }}>{it.text}</span>
                {it.owner ? <Badge tone="info" data-testid="not-proven-owner" style={{ flexShrink: 0, textTransform: "none" }}>owner: {it.owner}</Badge> : null}
              </li>
            );
          })}
        </ul>
      ) : <span>{d.verdict ? "Nothing listed as not proven." : "Not known until the run finishes."}</span>}
    </Section>
  );
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
    <Section title="Needs your answer" testid="run-reply-card" meta={<MessageCircleQuestion size={16} aria-hidden="true" />}>
      <div>{question}</div>
      <div data-testid="run-reply" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <Textarea aria-label="Your reply" rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)} disabled={state.busy || state.sent} />
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Button onClick={send} disabled={!answer.trim() || state.busy || state.sent}>Send reply</Button>
          {state.sent ? <span role="status">Reply saved. Resume the run to continue.</span> : null}
          {state.error ? <span role="alert" style={{ color: "var(--cp-error-ink)" }}>{state.error}</span> : null}
        </div>
      </div>
    </Section>
  );
}

function PullRequest({ d }: { d: RunDetailResponse }) {
  let body: ReactNode;
  if (d.pr_url) body = /^https?:\/\//.test(d.pr_url) ? <a href={d.pr_url} target="_blank" rel="noreferrer" style={{ color: "var(--cp-accent-ink)", wordBreak: "break-all" }}>{d.pr_url} <ExternalLink size={12} aria-hidden="true" /></a> : <span>{d.pr_url}</span>;
  else if (!d.verdict) body = <span>No PR yet: the run is still in progress.</span>;
  else if (displayOutcome(d.verdict).tone === "good") body = <span>No PR opened {UNMEASURED}: the run recorded no PR address.</span>;
  else body = <span>No PR opened: the run ended as {displayOutcome(d.verdict).label.toLowerCase()}, and a PR opens only after the run verifies.</span>;
  return <Section title="Pull request" testid="run-pr" meta={d.pr_draft ? "draft" : undefined}><div style={{ display: "flex", gap: 8, alignItems: "center" }}><GitPullRequest size={14} aria-hidden="true" />{body}</div></Section>;
}

export function RunThread({ source, run, slot, renderSlot }: { source: string; run: string; slot?: ReactNode; renderSlot?: (d: RunDetailResponse, reload: () => void) => ReactNode }) {
  const [d, setD] = useState<RunDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);
  const [whyRaw, setWhyRaw] = useState(false);
  const [ownRetry, setOwnRetry] = useState<{ busy: boolean; msg?: string; error?: boolean }>({ busy: false });
  const [retry, setRetry] = useState<{ busy: boolean; msg?: string; error?: boolean }>({ busy: false });
  const events = useEvents(source, run);
  const patch = useArtifact(source, run, "diff.patch");
  const receipt = useArtifact(source, run, "receipt.md");
  const receiptJson = useArtifact(source, run, "receipt.json");
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

  const title = d.title ?? d.issue_ref ?? d.origin_repo ?? `Title ${UNMEASURED}`;
  const blocked = !!d.blocked_question;
  const running = d.status === "running" || (d.verdict === null && !d.ended_at);
  const prog = stageProgress(d.stages);
  const why = running ? null : whyForRun(d);
  const whyRawText = why ? rawWhy(events) : null;
  const ownRules = !running && d.own_rules_block === true;
  const canRetry = !running && !!d.issue_ref;
  const doOwnRetry = async () => {
    setOwnRetry({ busy: true });
    try { await postControl(source, run, "retry"); setOwnRetry({ busy: false, msg: "Retry started as a new run." }); load(); }
    catch (e) { setOwnRetry({ busy: false, msg: (e as Error).message, error: true }); }
  };
  const doRetry = async () => {
    setRetry({ busy: true });
    try { await postRun({ target: d.issue_ref! }); setRetry({ busy: false, msg: "Started a new run." }); }
    catch (e) { setRetry({ busy: false, msg: (e as Error).message, error: true }); }
  };
  return (
    <section data-testid="run-thread" style={{ maxWidth: 1100, margin: "0 auto", padding: "8px 0 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <header style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
        <div style={{ flex: "1 1 320px", minWidth: 0 }}>
          <div className="cp-eyebrow">{d.origin_repo ?? `repo ${UNMEASURED}`}{d.issue_ref && d.title ? ` / ${d.issue_ref}` : ""}</div>
          <h1 data-testid="run-title" className="cp-display" style={{ margin: "4px 0 0", fontSize: 30, overflowWrap: "anywhere" }}>{title}</h1>
        </div>
        {blocked ? <OutcomeBadge verdict="BLOCKED" testid="run-outcome" /> : d.verdict ? <OutcomeBadge label={runOutcome(d).label} tone={runOutcome(d).tone} testid="run-outcome" /> : <OutcomeBadge verdict={null} testid="run-outcome" />}
        <span data-testid="run-elapsed" style={{ fontFamily: "var(--cp-font-mono)", fontSize: "var(--cp-text-base)" }}>{elapsedLabel(d.elapsed_s ?? d.wall_s)}</span>
        <span data-testid="run-cost" style={{ fontFamily: "var(--cp-font-mono)", fontSize: "var(--cp-text-base)" }}>{costLabel(d)}</span>
        <span data-testid="run-header-slot" style={{ display: "inline-flex", gap: 8 }}>{slot}{renderSlot ? renderSlot(ownRules ? { ...d, blocked_question: null } : d, load) : null}</span>
        {renderSlot ? null : <Button variant={ownRules ? "primary" : "secondary"} size="sm" data-testid="run-retry" disabled={!canRetry || retry.busy} title={running ? "The run is still in progress" : d.issue_ref ? "Start this issue again" : `No issue reference recorded ${UNMEASURED}`} onClick={() => void doRetry()}><RotateCcw size={13} aria-hidden="true" /> Retry</Button>}
        {retry.msg ? <span role={retry.error ? "alert" : "status"} data-testid="run-retry-msg" style={{ color: retry.error ? "var(--cp-error-ink)" : "var(--cp-text-2)", fontSize: "var(--cp-text-base)" }}>{retry.msg}</span> : null}
      </header>
      {ownRules ? (
        <Section title="Loki's own rules stopped this run" testid="run-own-rules">
          <p data-testid="run-own-rules-text" style={{ margin: 0 }}>{OWN_RULES_TEXT}</p>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Button data-testid="run-own-rules-retry" disabled={ownRetry.busy} onClick={() => void doOwnRetry()}><RotateCcw size={13} aria-hidden="true" /> Retry</Button>
            {ownRetry.msg ? <span role={ownRetry.error ? "alert" : "status"} style={{ color: ownRetry.error ? "var(--cp-error-ink)" : "var(--cp-text-2)" }}>{ownRetry.msg}</span> : null}
          </div>
        </Section>
      ) : null}
      {why && !ownRules ? (
        <div style={{ margin: "-8px 0 0" }}>
          <p data-testid="run-why" style={{ margin: 0, fontSize: "var(--cp-text-md)", color: "var(--cp-text-2)", overflowWrap: "anywhere" }}><strong style={{ color: "var(--cp-text)" }}>Why:</strong> {why}</p>
          {whyRawText ? <Button variant="ghost" size="sm" data-testid="run-why-raw-toggle" aria-pressed={whyRaw} onClick={() => setWhyRaw((x) => !x)}>{whyRaw ? "Hide raw" : "Show raw"}</Button> : null}
          {whyRaw && whyRawText ? <pre data-testid="run-why-raw" style={{ margin: "6px 0 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "var(--cp-font-mono)", fontSize: "var(--cp-text-sm)", maxHeight: 280, overflow: "auto", color: "var(--cp-text-2)" }}>{whyRawText}</pre> : null}
        </div>
      ) : null}

      {d.blocked_question && !ownRules ? <ReplyPrompt source={source} run={run} question={stripAnsi(d.blocked_question)} onSent={load} /> : null}

      <div data-testid="run-summary" style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 440px), 1fr))", alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          <ChangedFiles d={d} patch={patch} />
          <Evidence d={d} source={source} run={run} receipt={receipt} receiptJson={receiptJson} events={events} />
        </div>
        <div data-testid="run-aside" style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          <NotProven d={d} />
          <PullRequest d={d} />
        </div>
      </div>

      <div className="cp-term" data-testid="run-panel">
        <div className="cp-term-bar">
          <span style={{ display: "inline-flex", gap: 6 }} aria-hidden="true"><Dot color="#FF5F57" /><Dot color="#FEBC2E" /><Dot color="#28C840" /></span>
          <span className="cp-trunc">Control Plane / {d.model ?? `model ${UNMEASURED}`}</span>
          <span>{d.provider ?? `provider ${UNMEASURED}`}</span>
        </div>
        <div className="cp-term-body">
          <Stages d={d} />
          <div className="cp-term-main"><Timeline events={events} awaiting={running} /></div>
        </div>
        <div className="cp-term-foot">
          <span data-testid="run-progress">{prog.m ? `stage ${prog.n} / ${prog.m}` : `stage ${UNMEASURED}`}</span>
          {running ? <span data-testid="run-live" style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--cp-term-green)" }}><Dot color="var(--cp-term-green)" pulse /> live</span> : <span data-testid="run-ended">{d.ended_at ? "run ended" : `end time ${UNMEASURED}`}</span>}
        </div>
      </div>

      <div>
        <Button variant="ghost" size="sm" data-testid="run-raw-toggle" aria-pressed={raw} onClick={() => setRaw((x) => !x)}>{raw ? "Hide raw" : "Show raw"}</Button>
        {raw ? (
          <div data-testid="run-log" style={{ marginTop: 8 }}>
            <pre data-testid="run-raw-json" style={{ margin: 0, padding: 12, borderRadius: 12, background: "var(--cp-term-bg)", color: "var(--cp-term-text)", fontFamily: "var(--cp-font-mono)", fontSize: 11, maxHeight: 360, overflow: "auto", whiteSpace: "pre-wrap" }}>{JSON.stringify(d, null, 2)}</pre>
            <div role="log" style={{ marginTop: 8, maxHeight: 280, overflow: "auto", fontFamily: "var(--cp-font-mono)", fontSize: 11, color: "var(--cp-text-2)" }}>
              {events.length === 0 ? <div>No events yet.</div> : events.map((e) => <div key={e.seq}>{`${e.seq}  ${eventLine(e)}`}</div>)}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** Reads /runs/:source/:run (or /run/:source/:run) from the address when no props are given. */
function fromLocation(): { source: string; run: string } | null {
  const m = /\/runs?\/([^/]+)\/([^/?#]+)/.exec(globalThis.location?.pathname ?? "") ?? /#\/runs?\/([^/]+)\/([^/?#]+)/.exec(globalThis.location?.hash ?? "");
  return m ? { source: decodeURIComponent(m[1]!), run: decodeURIComponent(m[2]!) } : null;
}

export function RunPage({ source, run, slot, renderSlot }: { source?: string; run?: string; slot?: ReactNode; renderSlot?: (d: RunDetailResponse, reload: () => void) => ReactNode }) {
  const loc = source && run ? { source, run } : fromLocation();
  return loc ? <RunThread source={loc.source} run={loc.run} slot={slot} renderSlot={renderSlot} /> : <EmptyState title="No run selected" hint="Open a run from Home or Runs." />;
}

export const page = { id: "run", path: "/runs/:source/:run", title: "Run", component: RunPage };
