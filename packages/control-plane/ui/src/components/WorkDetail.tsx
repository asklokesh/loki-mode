// The detail pane: what a run promised, what it proved, why it carries its label, what it changed and cost, and the actions that apply to it.
import { useEffect, useState } from "react";
import { deleteRun, getRunDetail, postAnswer, stopRun, type RunDetail, type RunRow } from "../api";
import { ago, duration, isRunning, money, repoName, runKey, runTitle, STAGES, stageNow, tone, verdictOf, type Bucket } from "../lib/model";
import { Chip, Dot } from "./WorkList";
import { Icon } from "./Icon";

const LINE_TONE = { met: "ok", unmet: "warn", waiting: "idle" } as const;
const LINE_WORD = { met: "PROVEN", unmet: "UNMET", waiting: "PENDING" } as const;
const lineWord = (s: keyof typeof LINE_WORD, running: boolean): string => (s === "waiting" && !running ? "NOT CHECKED" : LINE_WORD[s]);
const usd = (n: number | null | undefined): string => (typeof n === "number" ? `$${n.toFixed(2)}` : "unpriced");

export function WorkDetail({ row, source, run, tick, bucket, onDismiss, onGone, onBack, backLabel, backHref }: {
  row: RunRow | null; source: string; run: string; tick: number; bucket: Bucket | null; onDismiss: (k: string) => void; onGone: () => void; onBack: () => void; backLabel: string; backHref: string;
}) {
  const [d, setD] = useState<RunDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setD(null); setErr(null); }, [source, run]);
  useEffect(() => {
    let live = true;
    getRunDetail(source, run).then((x) => { if (live) { setD(x); setErr(null); } }).catch((e: Error) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [source, run, tick]);

  const r: RunDetail | RunRow | null = d ?? row;
  const back = <a className="back" href={backHref} onClick={(e) => { e.preventDefault(); onBack(); }}><Icon id="back" />{backLabel}</a>;
  if (!r) return <section className="detail" aria-live="polite"><div className="dwrap">{back}{err ? <div className="err">{err}</div> : <div className="empty">Loading</div>}</div></section>;

  const running = isRunning(r);
  const stages = d?.stages ?? [];
  const at = stageNow(stages, r.current_stage);
  const halted = !running && tone(r) !== "ok";
  const acc = d?.acceptance ?? [];
  const proven = acc.filter((a) => a.status === "met").length;
  const notProven = (d?.not_proven ?? []).filter((n) => !acc.some((a) => a.line === n));
  const why: { k: string; t: string }[] = [...(d?.stop_reason ? [{ k: "STOP", t: d.stop_reason }] : []), ...(r.integrity_reasons ?? []).map((t) => ({ k: "INTEGRITY", t }))];
  const files = r.diff_stat?.files ?? [];

  return (
    <section className="detail" aria-live="polite">
      <div className="dwrap">
        {back}
        <div className="dh">
          <Chip r={r} />
          <h2>{runTitle(r)}</h2>
          <div className="meta">
            <span>{repoName(r)}</span>{r.issue_ref ? <span>{r.issue_ref}</span> : null}<span>{ago(r.started_at ?? r.last_event_at)}</span>
            {running && typeof r.elapsed_s === "number" ? <span>{duration(r.elapsed_s)} elapsed</span> : null}
            {r.pr_url ? <a href={r.pr_url} target="_blank" rel="noopener noreferrer">{r.pr_draft ? "draft pull request" : "pull request"}</a> : null}
          </div>
        </div>
        <div className="stages" aria-label="Stages">
          {STAGES.map((s, i) => <div key={s} className={`stg ${running ? (i < at ? "done" : i === at ? "now" : "") : i < at || (!halted && i === at) ? "done" : i === at ? "halt" : ""}`}><b />{s}</div>)}
        </div>
        {err ? <div className="err">{err}</div> : null}
        <Actions r={r} d={d} running={running} bucket={bucket} reason={reasonLine(r, d, acc.length + notProven.length, proven)} onDismiss={onDismiss} onGone={onGone} />

        {acc.length + notProven.length > 0 ? (
          <div className="blk">
            <h4>What it promised <span>{proven} of {acc.length + notProven.length} proven</span></h4>
            <div className="lines">
              {acc.map((a, i) => (
                <div className="ln" key={i}>
                  <span className={`st ${LINE_TONE[a.status]}`}>{a.status === "met" ? <Icon id="done" /> : a.status === "unmet" ? <Icon id="pause" /> : null}</span>
                  <span>{a.line}</span><span className="ev">{lineWord(a.status, running)}</span>
                  {a.reason ? <span className="why">{a.reason}</span> : null}
                </div>
              ))}
              {notProven.map((n, i) => (
                <div className="ln" key={`np${i}`}><span className="st idle" /><span>{n}</span><span className="ev">NOT PROVEN</span></div>
              ))}
            </div>
          </div>
        ) : null}

        {why.length > 0 ? (
          <div className="blk"><h4>Why this label</h4>{why.map((w, i) => <div className="find" key={i}><span className="k LIMIT">{w.k}</span><span>{w.t}</span></div>)}</div>
        ) : null}

        <div className="blk">
          <h4>Change and cost</h4>
          <div className="grid2">
            {files.length > 0 && r.diff_stat ? (
              <div className="card"><small>{files.length} files</small>
                <div className="big"><span style={{ color: "var(--ok)" }}>+{r.diff_stat.added}</span> <span style={{ color: "var(--bad)" }}>-{r.diff_stat.removed}</span></div>
                <div className="files" style={{ marginTop: 8 }}>{files.map((f) => <div key={f.path}><span title={f.path}>{f.path}</span><span><span className="a">+{f.added ?? "?"}</span> <span className="d">-{f.removed ?? "?"}</span></span></div>)}</div>
              </div>
            ) : null}
            <div className="card"><small>{running ? "Spent so far" : "Spent"}</small><div className="big">{money(r)}</div>
              {r.cost_usd === null && r.total_sessions > 0 ? <small style={{ marginTop: 6 }}>{r.measured_sessions} of {r.total_sessions} sessions priced</small> : null}
              <dl className="kv" style={{ marginTop: 12 }}>
                {r.model ? <><dt>Model</dt><dd>{r.model}</dd></> : null}
                {r.provider ? <><dt>Provider</dt><dd>{r.provider}</dd></> : null}
                {d?.receipt?.sha256 ? <><dt>Receipt</dt><dd className="mono">sha256:{d.receipt.sha256.slice(0, 8)}...{d.receipt.sha256.slice(-4)} {d.receipt.signed ? "signed" : "not signed"}</dd></> : null}
                {!running && typeof r.wall_s === "number" ? <><dt>Time</dt><dd>{duration(r.wall_s)}</dd></> : null}
              </dl>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Actions({ r, d, running, bucket, reason, onDismiss, onGone }: { reason: string | null; r: RunRow; d: RunDetail | null; running: boolean; bucket: Bucket | null; onDismiss: (k: string) => void; onGone: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ t: string; bad: boolean } | null>(null);
  const [confirm, setConfirm] = useState<"delete" | "stop" | null>(null);
  useEffect(() => { setText(""); setMsg(null); setConfirm(null); }, [r.source_id, r.run_id]);
  const key = runKey(r);
  const act = async (f: () => Promise<unknown>, ok: string): Promise<void> => {
    setBusy(true);
    try { await f(); setMsg({ t: ok, bad: false }); } catch (e) { setMsg({ t: (e as Error).message, bad: true }); } finally { setBusy(false); setConfirm(null); }
  };
  const q = d?.blocked_question;
  return (
    <div className={`ask${tone(r) === "warn" || q ? " warn" : ""}`}>
      {q ? (
        <>
          <h3>Loki has a question</h3><p className="pre-wrap">{q}</p>
          <label className="sr" htmlFor="answer">Your answer</label>
          <textarea id="answer" value={text} onChange={(e) => setText(e.target.value)} placeholder="Type your answer" />
        </>
      ) : <><h3>{running ? "In progress" : bucket === "needs" ? "Waiting on you" : "Actions"}</h3>{reason ? <p>{reason}</p> : null}</>}
      <div className="acts">
        {q ? <button className="btn pri" disabled={busy || !text.trim()} onClick={() => void act(async () => { await postAnswer(r.source_id, r.run_id, text.trim()); setText(""); }, "Answer sent. The run resumes when it reads it.")}>Answer</button> : null}
        {running ? (confirm === "stop"
          ? <><button className="btn bad" disabled={busy} onClick={() => void act(() => stopRun(r.source_id, r.run_id), "Stop requested.")}>Stop this run</button><button className="btn" onClick={() => setConfirm(null)}>Keep running</button></>
          : <button className="btn" onClick={() => setConfirm("stop")}><Icon id="pause" />Stop</button>) : null}
        {r.pr_url ? <a className="btn pri" href={r.pr_url} target="_blank" rel="noopener noreferrer"><Icon id="ext" />Open pull request</a> : null}
        {bucket === "needs" && !q ? <button className="btn" onClick={() => onDismiss(key)}>Mark as seen</button> : null}
        {!running ? (confirm === "delete"
          ? <><button className="btn bad" disabled={busy} onClick={() => void (async () => { setBusy(true); try { await deleteRun(r.source_id, r.run_id); onGone(); } catch (e) { setMsg({ t: (e as Error).message, bad: true }); setConfirm(null); } finally { setBusy(false); } })()}>Delete for good</button><button className="btn" onClick={() => setConfirm(null)}>Cancel</button></>
          : <button className="btn" onClick={() => setConfirm("delete")}>Delete run</button>) : null}
      </div>
      {!r.pr_url && !running ? <p className="msg">Merging stays on GitHub. This run has no pull request link.</p> : null}
      {msg ? <p className={`msg${msg.bad ? " bad" : ""}`} role="status">{msg.t}</p> : null}
    </div>
  );
}

/** One plain sentence on why the run is where it is, from the data the run carries; null when there is nothing to say. */
export function reasonLine(r: RunRow, d: RunDetail | null, total: number, proven: number): string | null {
  if (d?.blocked_question) return null;
  if (isRunning(r)) return r.current_stage ? `Working in the ${r.current_stage.replace(/_/g, " ")} stage.` : null;
  const v = String(verdictOf(r) ?? "").trim();
  const parts = [v ? `Loki labelled this ${v}.` : "", d?.stop_reason ?? "", total > 0 ? `${proven} of ${total} lines proven.` : ""].filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}
