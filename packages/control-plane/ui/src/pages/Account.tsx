// The account level: everything Loki is doing across every org and project, and where orgs and projects are added.
import { Plus } from "lucide-react";
import { useState } from "react";
import { saveWorkspace, type RunRow, type Workspace } from "../api";
import { RunList, Stats, tally } from "../components/parts";
import { isWorking, repoOf } from "../lib/format";
import { href } from "../lib/router";

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "item";
const unique = (id: string, taken: string[]): string => { let x = id, n = 2; while (taken.includes(x)) x = `${id.slice(0, 36)}-${n++}`; return x; };

export function Account({ ws, runs, onSaved }: { ws: Workspace; runs: RunRow[]; onSaved: (w: Workspace) => void }) {
  const [name, setName] = useState(""), [org, setOrg] = useState(ws.orgs[0]?.id ?? ""), [newOrg, setNewOrg] = useState(""), [error, setError] = useState<string | null>(null);
  const save = (next: Pick<Workspace, "account" | "orgs">): void => { saveWorkspace(next).then((w) => { onSaved(w); setError(null); }).catch((e: Error) => setError(e.message)); };
  const addProject = (): void => {
    const n = name.trim(); if (!n) return;
    save({ account: ws.account, orgs: ws.orgs.map((o) => (o.id === org ? { ...o, projects: [...o.projects, { id: unique(slug(n), o.projects.map((p) => p.id)), name: n, repos: [] }] } : o)) });
    setName("");
  };
  const addOrg = (): void => {
    const n = newOrg.trim(); if (!n) return;
    save({ account: ws.account, orgs: [...ws.orgs, { id: unique(slug(n), ws.orgs.map((o) => o.id)), name: n, projects: [] }] });
    setNewOrg("");
  };
  const working = runs.filter((r) => isWorking(r));
  return (
    <div className="page">
      <div className="head">
        <div>
          <h1>{ws.account.name}</h1>
          <p className="muted">Everything Loki is working on, across your orgs and projects.</p>
        </div>
      </div>
      <Stats runs={runs} />
      {working.length > 0 ? (
        <div className="card">
          <h2>Working now</h2>
          <RunList runs={working} empty="" />
        </div>
      ) : null}
      {ws.orgs.map((o) => (
        <div key={o.id}>
          <h2>{o.name}</h2>
          <div className="grid">
            {o.projects.map((p) => {
              const t = tally(runs.filter((r) => p.repos.includes(repoOf(r))));
              return (
                <a key={p.id} className="tile" href={href.project(o.id, p.id)}>
                  <div className="t">{p.name}</div>
                  <div className="muted" style={{ fontSize: 13 }}>
                    {p.repos.length} repo{p.repos.length === 1 ? "" : "s"}  ·  {t.safe} safe to merge  ·  {t.needs} need you
                  </div>
                </a>
              );
            })}
            {o.projects.length === 0 ? <div className="muted">No projects yet. Add one below.</div> : null}
          </div>
        </div>
      ))}
      <div className="card">
        <h2>Add a project or an org</h2>
        {error ? <div className="err" style={{ marginBottom: 12 }}>{error}</div> : null}
        <div className="inline" style={{ marginBottom: 10 }}>
          <input className="field" style={{ maxWidth: 280 }} placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addProject(); }} />
          <select className="field" style={{ maxWidth: 200 }} value={org} onChange={(e) => setOrg(e.target.value)}>
            {ws.orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          <button className="btn primary" onClick={addProject} disabled={!name.trim()}><Plus size={16} /> Add project</button>
        </div>
        <div className="inline">
          <input className="field" style={{ maxWidth: 280 }} placeholder="Org name" value={newOrg} onChange={(e) => setNewOrg(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addOrg(); }} />
          <button className="btn" onClick={addOrg} disabled={!newOrg.trim()}><Plus size={16} /> Add org</button>
        </div>
      </div>
      <div className="card">
        <h2>Latest runs</h2>
        <RunList runs={runs.slice(0, 12)} empty="No runs yet. In any repository, type: loki start owner/repo#123" />
      </div>
    </div>
  );
}
