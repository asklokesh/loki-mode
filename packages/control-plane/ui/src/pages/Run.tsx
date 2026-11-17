// One run: its label, the stages, the acceptance lines with the count of checks Loki ran, and the pull request.
import { ExternalLink, Send } from "lucide-react";
import { useState } from "react";
import { getRunV2, postAnswer, type RunDetailV2, type Workspace } from "../api";
import { AcceptanceTable, RunBadge, StageBar } from "../components/parts";
import { usePolled } from "../lib/data";
import { duration, isWorking, label, money, repoOf, runTitle } from "../lib/format";
import { href } from "../lib/router";

export function Run({ ws, source, run }: { ws: Workspace; source: string; run: string }) {
  const [live, setLive] = useState(true);
  const { value: r, error, reload } = usePolled<RunDetailV2>(
    () => getRunV2(source, run).then((d) => { setLive(isWorking(d)); return d; }),
    `${source}/${run}`, live,
  );
  const [answer, setAnswer] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [sendErr, setSendErr] = useState<string | null>(null);
  if (!r) return <div className="page"><div className="empty">{error ?? "Loading"}</div></div>;
  const repo = repoOf(r);
  const send = (): void => {
    postAnswer(source, run, answer)
      .then((x) => { setSent(x.resume); setAnswer(""); setSendErr(null); reload(); })
      .catch((e: Error) => setSendErr(e.message));
  };
  return (
    <div className="page">
      <div className="crumbs"><a href={href.account()}>{ws.account.name}</a> / <a href={href.repo(repo)}>{repo}</a></div>
      <div className="head">
        <div style={{ minWidth: 0 }}>
          <h1>{runTitle(r)}</h1>
          <p className="muted">
            {r.issue_ref ?? r.task_source ?? "task"}  ·  {r.model ?? "model unknown"}  ·  {money(r)}  ·  {duration(r.status === "running" ? r.elapsed_s : r.wall_s)}
          </p>
        </div>
        <div className="inline">
          <RunBadge run={r} />
          {r.pr_url ? <a className="btn" href={r.pr_url} target="_blank" rel="noreferrer"><ExternalLink size={16} /> {r.pr_draft ? "Draft pull request" : "Pull request"}</a> : null}
        </div>
      </div>
      <div className="card"><StageBar stages={r.stages} /></div>
      {r.blocked_question ? (
        <div className="card">
          <h2>Loki has a question</h2>
          <p>{r.blocked_question}</p>
          <div className="inline">
            <input className="field" style={{ flex: 1, minWidth: 240 }} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Your answer" />
            <button className="btn primary" onClick={send} disabled={!answer.trim()}><Send size={16} /> Send</button>
          </div>
          {sent ? <div className="muted" style={{ marginTop: 10 }}>Saved. To continue, run: <span className="mono">{sent}</span></div> : null}
          {sendErr ? <div className="err" style={{ marginTop: 10 }}>{sendErr}</div> : null}
        </div>
      ) : null}
      {(r.acceptance ?? []).length > 0 ? <div className="card">
        <h2>Acceptance</h2>
        <AcceptanceTable rows={r.acceptance ?? []} source={r.acceptance_source} />
        {r.proof ? (
          <div className="muted" style={{ fontSize: 13, marginTop: 12 }}>
            Loki ran the proof itself (round {r.proof.round}): {r.proof.proved} check{r.proof.proved === 1 ? "" : "s"} passed, {r.proof.failed} failed, in {duration(r.proof.seconds)}.
          </div>
        ) : null}
      </div> : null}
      {r.stop_reason || r.not_proven.length > 0 ? (
        <div className="card">
          <h2>{label(r).tone === "ok" ? "Notes from the run" : "What is left for you"}</h2>
          {r.stop_reason ? <p style={{ marginTop: 0 }}>{r.stop_reason}</p> : null}
          {r.not_proven.length > 0 ? <ul className="plain">{r.not_proven.slice(0, 8).map((n, i) => <li key={i}>{n}</li>)}{r.not_proven.length > 8 ? <li className="muted">and {r.not_proven.length - 8} more in the receipt</li> : null}</ul> : null}
        </div>
      ) : null}
      {r.diff_stat ? (
        <div className="card">
          <h2>Changes</h2>
          <div className="muted" style={{ marginBottom: 8 }}>{r.diff_stat.files.length} file{r.diff_stat.files.length === 1 ? "" : "s"}, +{r.diff_stat.added} -{r.diff_stat.removed}</div>
          <div className="rows">
            {r.diff_stat.files.slice(0, 60).map((f) => (
              <div key={f.path} className="inline mono" style={{ justifyContent: "space-between", padding: "4px 0" }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{f.path}</span>
                <span className="muted">+{f.added ?? "?"} -{f.removed ?? "?"}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {r.receipt ? (
        <div className="card">
          <h2>Receipt</h2>
          <div className="mono muted">{r.receipt.signed ? "signed" : "not signed"}  ·  {r.receipt.sha256 ?? "no hash"}</div>
        </div>
      ) : null}
    </div>
  );
}
