// The project level: the repositories of one project, their runs, and adding or removing a repository.
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { saveWorkspace, type RunRow, type Workspace } from "../api";
import { RunList, Stats, tally } from "../components/parts";
import { repoOf } from "../lib/format";
import { href } from "../lib/router";

export function Project({ ws, runs, orgId, projectId, onSaved }: { ws: Workspace; runs: RunRow[]; orgId: string; projectId: string; onSaved: (w: Workspace) => void }) {
  const org = ws.orgs.find((o) => o.id === orgId), project = org?.projects.find((p) => p.id === projectId);
  const [pick, setPick] = useState(""), [error, setError] = useState<string | null>(null);
  if (!org || !project) return <div className="page"><div className="empty">This project does not exist. <a href={href.account()}>Back to the account</a></div></div>;
  const setRepos = (repos: string[]): void => {
    saveWorkspace({ account: ws.account, orgs: ws.orgs.map((o) => (o.id === orgId ? { ...o, projects: o.projects.map((p) => (p.id === projectId ? { ...p, repos } : p)) } : o)) })
      .then((w) => { onSaved(w); setError(null); }).catch((e: Error) => setError(e.message));
  };
  const mine = runs.filter((r) => project.repos.includes(repoOf(r)));
  const addable = ws.repos.filter((r) => !project.repos.includes(r));
  return (
    <div className="page">
      <div className="crumbs"><a href={href.account()}>{ws.account.name}</a> / {org.name}</div>
      <div className="head">
        <div>
          <h1>{project.name}</h1>
          <p className="muted">{project.repos.length} repositor{project.repos.length === 1 ? "y" : "ies"} in this project.</p>
        </div>
      </div>
      <Stats runs={mine} />
      <div>
        <h2>Repositories</h2>
        <div className="grid">
          {project.repos.map((r) => {
            const t = tally(runs.filter((x) => repoOf(x) === r));
            return (
              <div key={r} className="tile" style={{ position: "relative" }}>
                <a href={href.repo(r)}>
                  <div className="t">{r}</div>
                  <div className="muted" style={{ fontSize: 13 }}>{t.total} run{t.total === 1 ? "" : "s"}  ·  {t.safe} safe to merge  ·  {t.working} working</div>
                </a>
                <button className="btn" title="Remove from this project (the repository itself is not touched)" style={{ position: "absolute", top: 10, right: 10, padding: 4, border: 0 }} onClick={() => setRepos(project.repos.filter((x) => x !== r))}><X size={14} /></button>
              </div>
            );
          })}
          {project.repos.length === 0 ? <div className="muted">No repositories yet.</div> : null}
        </div>
      </div>
      <div className="card">
        <h2>Add a repository</h2>
        {error ? <div className="err" style={{ marginBottom: 12 }}>{error}</div> : null}
        {addable.length === 0 ? (
          <div className="muted">Every repository Loki has seen on this machine is already here. A repository appears after its first run: in it, type loki start with an issue or a task.</div>
        ) : (
          <div className="inline">
            <select className="field" style={{ maxWidth: 320 }} value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Choose a repository</option>
              {addable.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <button className="btn primary" disabled={!pick} onClick={() => { setRepos([...project.repos, pick]); setPick(""); }}><Plus size={16} /> Add</button>
          </div>
        )}
      </div>
      <div className="card">
        <h2>Runs in this project</h2>
        <RunList runs={mine.slice(0, 30)} empty="No runs in this project yet." />
      </div>
    </div>
  );
}
