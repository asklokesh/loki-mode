// New run picker. A run starts only from: a registered repo, then one of its open issues (or a typed task), then an explicit confirm.
// Free text alone never starts anything: Enter in the task box only moves to the confirm step.
import { useEffect, useRef, useState } from "react";
import { Button, Dialog, Input, Spinner } from "../../design/primitives";
import { fetchIssues, fetchRepos, postRun, StartError, type RepoIssue } from "./api";
import { closeNewRun, useNewRun } from "./store";

const ISSUE_URL = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9._-]+)\/issues\/([1-9][0-9]*)\/?$/;
const REF = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9._-]+)#([1-9][0-9]*)$/;

/** The server refuses ':' in a target, so a GitHub issue URL is sent in its owner/repo#N form. Everything else is sent as typed. */
export function normalizeTarget(raw: string): string {
  const s = raw.trim();
  const m = ISSUE_URL.exec(s);
  return m ? `${m[1]}/${m[2]}#${m[3]}` : s;
}

export function errorText(e: unknown): string {
  if (e instanceof StartError) {
    if (e.status === 400) return `The server refused this run: ${e.message}`;
    if (e.status === 403) return `Not allowed: ${e.message}. Starting runs works only from the machine running the control service.`;
    if (e.status === 404) return `The control service does not offer this: ${e.message}`;
    if (e.status === 409) return `${e.message}. Wait for it to finish, or pick another repo.`;
    return e.message;
  }
  return e instanceof Error ? e.message : "could not reach the control service";
}

const label = { display: "flex", flexDirection: "column", gap: 4, fontSize: "var(--cp-text-sm)", color: "var(--cp-text-muted)" } as const;
const field = { padding: "8px 10px", borderRadius: "var(--cp-radius-md)", border: "1px solid var(--cp-border)", background: "var(--cp-bg)", color: "var(--cp-text)", font: "inherit", fontSize: "var(--cp-text-md)" } as const;

type Issues = { state: "idle" } | { state: "loading" } | { state: "ok"; list: RepoIssue[] } | { state: "error"; message: string };

export function NewRunPicker({ preset, onDone }: { preset: string | null; onDone: () => void }) {
  const [repos, setRepos] = useState<string[] | null>(null);
  const [reposError, setReposError] = useState<string | null>(null);
  const [repo, setRepo] = useState("");
  const [issues, setIssues] = useState<Issues>({ state: "idle" });
  const [issue, setIssue] = useState<RepoIssue | null>(null);
  const [task, setTask] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(false);
  const offered = preset ? REF.exec(preset) : null;

  useEffect(() => {
    let live = true;
    fetchRepos().then((r) => {
      if (!live) return;
      setRepos(r);
      if (offered) {
        if (r.includes(offered[2]!)) { setRepo(offered[2]!); setConfirm(true); }
        else setError(`${offered[1]}/${offered[2]} is not a registered repo, so a run cannot start from here.`);
      }
    }, (e: Error) => live && setReposError(e.message));
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!repo || offered) return;
    let live = true;
    setIssues({ state: "loading" });
    setIssue(null);
    fetchIssues(repo).then((list) => live && setIssues({ state: "ok", list }), (e: unknown) => live && setIssues({ state: "error", message: errorText(e) }));
    return () => { live = false; };
  }, [repo]); // eslint-disable-line react-hooks/exhaustive-deps

  const target = offered ? preset! : issue ? normalizeTarget(issue.url) : task.trim();
  const ready = repo !== "" && target !== "";
  const what = offered || issue ? target : `"${target}"`;

  const start = async () => {
    if (inflight.current || !ready) return;
    inflight.current = true;
    setBusy(true);
    setError(null);
    try {
      await postRun({ target, repo });
      onDone();
      location.hash = "#/runs";
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    } finally { inflight.current = false; }
  };

  if (reposError) return <p role="alert" data-testid="picker-error" style={{ color: "var(--cp-error)" }}>Could not load registered repos: {reposError}</p>;
  if (repos === null) return <Spinner label="Loading repos" />;
  if (repos.length === 0) return <p data-testid="picker-no-repos" style={{ color: "var(--cp-text-muted)" }}>No registered repos. Run loki in a repo once so it appears here.</p>;

  if (confirm) {
    return (
      <div data-testid="confirm-step" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <p data-testid="confirm-text" style={{ margin: 0, fontSize: "var(--cp-text-md)" }}>Start a run on <strong>{what}</strong> in <strong>{repo}</strong>?</p>
        {error ? <p role="alert" data-testid="picker-error" style={{ margin: 0, color: "var(--cp-error)" }}>{error}</p> : null}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button variant="ghost" onClick={offered ? onDone : () => setConfirm(false)}>{offered ? "Cancel" : "Back"}</Button>
          <Button data-testid="confirm-start" disabled={busy || !ready} onClick={() => void start()}>Start run</Button>
        </div>
      </div>
    );
  }

  return (
    <form data-testid="picker" style={{ display: "flex", flexDirection: "column", gap: 16 }} onSubmit={(e) => { e.preventDefault(); if (ready) setConfirm(true); }}>
      <label style={label}>Repo
        <select aria-label="Repo" data-testid="picker-repo" value={repo} onChange={(e) => setRepo(e.target.value)} onInput={(e) => setRepo((e.target as HTMLSelectElement).value)} style={field}>
          <option value="">Choose a registered repo</option>
          {repos.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </label>
      {repo ? (
        <div style={label}>Open issues
          {issues.state === "loading" ? <Spinner label="Loading issues" /> : null}
          {issues.state === "error" ? <p role="alert" data-testid="issues-error" style={{ margin: 0, color: "var(--cp-error)" }}>Could not load issues: {issues.message}</p> : null}
          {issues.state === "ok" && issues.list.length === 0 ? <p data-testid="issues-empty" style={{ margin: 0 }}>No open issues in this repo.</p> : null}
          {issues.state === "ok" && issues.list.length > 0 ? (
            <ul role="listbox" aria-label="Open issues" style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: 220, overflowY: "auto", border: "1px solid var(--cp-border)", borderRadius: "var(--cp-radius-md)" }}>
              {issues.list.map((i) => (
                <li key={i.number} role="option" aria-selected={issue?.number === i.number} data-testid="issue-option" onClick={() => { setIssue(i); setTask(""); }}
                  style={{ padding: "8px 10px", cursor: "pointer", color: "var(--cp-text)", background: issue?.number === i.number ? "var(--cp-accent-glow)" : "transparent", fontSize: "var(--cp-text-md)" }}>
                  <span style={{ color: "var(--cp-text-muted)" }}>#{i.number}</span> {i.title}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {repo ? (
        <label style={label}>Or describe a task
          <Input aria-label="Task" data-testid="picker-task" value={task} maxLength={500} placeholder="A short task for this repo" onChange={(e) => { setTask(e.target.value); if (e.target.value) setIssue(null); }} />
        </label>
      ) : null}
      {error ? <p role="alert" data-testid="picker-error" style={{ margin: 0, color: "var(--cp-error)" }}>{error}</p> : null}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
        <Button type="submit" data-testid="picker-continue" disabled={!ready}>Review</Button>
      </div>
    </form>
  );
}

/** Mounted once in the shell; open state lives in ./store. */
export function NewRunDialog() {
  const { open, preset } = useNewRun();
  return (
    <Dialog open={open} title="New run" onClose={closeNewRun}>
      <NewRunPicker key={preset ?? "pick"} preset={preset} onDone={closeNewRun} />
    </Dialog>
  );
}
