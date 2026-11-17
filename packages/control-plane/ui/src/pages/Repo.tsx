// The repository level: start work, see its runs, and read or edit what Loki and Claude Code know about it.
import { Play, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { getKnowledge, saveInstructions, startRun, type RepoKnowledge, type RunRow, type Workspace } from "../api";
import { RunList, Stats } from "../components/parts";
import { repoOf } from "../lib/format";
import { href } from "../lib/router";

type Tab = "runs" | "instructions" | "knowledge";

export function Repo({ ws, runs, repo, onStarted }: { ws: Workspace; runs: RunRow[]; repo: string; onStarted: () => void }) {
  const [tab, setTab] = useState<Tab>("runs");
  const [target, setTarget] = useState("");
  const [know, setKnow] = useState<RepoKnowledge | null>(null);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mine = runs.filter((r) => repoOf(r) === repo);
  const home = ws.orgs.flatMap((o) => o.projects.map((p) => ({ o, p }))).find((x) => x.p.repos.includes(repo));

  useEffect(() => {
    setKnow(null); setNote(null); setError(null);
    getKnowledge(repo)
      .then((k) => { setKnow(k); setDraft(k.instructions.find((i) => i.path === "CLAUDE.md")?.text ?? ""); })
      .catch((e: Error) => setError(e.message));
  }, [repo]);

  const start = (): void => {
    const t = target.trim(); if (!t) return;
    setBusy(true);
    startRun(t, repo)
      .then(() => { setTarget(""); setNote("Started. It appears under Runs in a few seconds."); setError(null); onStarted(); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const save = (): void => {
    setBusy(true);
    saveInstructions(repo, draft)
      .then((k) => { setKnow(k); setNote("Saved to CLAUDE.md in the repository."); setError(null); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const saved = know?.instructions.find((i) => i.path === "CLAUDE.md");
  const others = know?.instructions.filter((i) => i.path !== "CLAUDE.md") ?? [];

  return (
    <div className="page">
      <div className="crumbs">
        <a href={href.account()}>{ws.account.name}</a>
        {home ? <> / {home.o.name} / <a href={href.project(home.o.id, home.p.id)}>{home.p.name}</a></> : null}
      </div>
      <div className="head">
        <div>
          <h1>{repo}</h1>
          <p className="muted">Give Loki an issue or a task. It opens a pull request and labels it.</p>
        </div>
      </div>
      <div className="card">
        <div className="inline">
          <input className="field" style={{ flex: 1, minWidth: 240 }} placeholder="owner/repo#123, or a task in plain words" value={target} onChange={(e) => setTarget(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") start(); }} />
          <button className="btn primary" onClick={start} disabled={busy || !target.trim()}><Play size={16} /> Start</button>
        </div>
        {note ? <div className="muted" style={{ marginTop: 10, fontSize: 14 }}>{note}</div> : null}
        {error ? <div className="err" style={{ marginTop: 10 }}>{error}</div> : null}
      </div>
      <Stats runs={mine} />
      <div className="tabs">
        {(["runs", "instructions", "knowledge"] as Tab[]).map((t) => (
          <button key={t} className={`tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>
            {t === "runs" ? `Runs (${mine.length})` : t === "instructions" ? "Instructions" : `Knowledge (${know?.notes.length ?? 0})`}
          </button>
        ))}
      </div>
      {tab === "runs" ? (
        <div className="card"><RunList runs={mine} showRepo={false} empty="No runs in this repository yet." /></div>
      ) : null}
      {tab === "instructions" ? (
        <div className="card">
          <h2>CLAUDE.md</h2>
          <p className="muted" style={{ marginTop: -6 }}>What every run in this repository is told first. It is the file Claude Code reads, so it also applies when you work here without Loki.</p>
          {!know ? <div className="empty">{error ? "Loki has not seen this repository on this machine." : "Loading"}</div> : (
            <>
              <textarea className="field" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="How to build and test, conventions to follow, things never to touch." />
              <div className="inline" style={{ marginTop: 12 }}>
                <button className="btn primary" onClick={save} disabled={busy || draft === (saved?.text ?? "") || saved?.truncated === true}><Save size={16} /> Save</button>
                {saved?.truncated ? <span className="muted">This file is too large to edit here.</span> : null}
              </div>
              {others.map((i) => (
                <div key={i.path} style={{ marginTop: 18 }}>
                  <div className="mono">{i.path}</div>
                  <pre className="note">{i.text}</pre>
                </div>
              ))}
            </>
          )}
        </div>
      ) : null}
      {tab === "knowledge" ? (
        <div className="card">
          <h2>What Loki has written down here</h2>
          {!know || know.notes.length === 0 ? (
            <div className="empty">Nothing yet. Notes appear in .loki/memory, .loki/learnings and .claude/rules as Loki works in this repository.</div>
          ) : know.notes.map((n) => (
            <div key={n.path} style={{ marginBottom: 16 }}>
              <div className="inline" style={{ justifyContent: "space-between" }}>
                <span className="mono">{n.path}</span>
                <span className="muted" style={{ fontSize: 13 }}>{n.bytes} bytes</span>
              </div>
              <pre className="note">{n.preview}</pre>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
