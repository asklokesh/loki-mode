// New work: the target (owner/repo#N, an issue link, a PRD path or a one-line brief), the repository, and the options `loki start` takes as flags (provider, model, spend cap).
// It posts to the existing POST /v1/start route; the run then appears through the event stream.
import { useEffect, useRef, useState } from "react";
import { getProviders, startRun, type ProviderRow } from "../api";
import { Icon } from "./Icon";

const ISSUE_URL = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)\/?$/;
/** A GitHub issue URL becomes the owner/repo#N form the server accepts; anything else is sent as typed. */
export const normalizeTarget = (s: string): string => { const m = ISSUE_URL.exec(s.trim()); return m ? `${m[1]}#${m[2]}` : s.trim(); };

export function NewWork({ open, onClose, repos, defaultRepo, onStarted }: { open: boolean; onClose: () => void; repos: string[]; defaultRepo: string | null; onStarted: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [target, setTarget] = useState("");
  const [repo, setRepo] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [budget, setBudget] = useState("");
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  useEffect(() => { getProviders().then((p) => setProviders(p.providers.filter((x) => x.installed))).catch(() => setProviders([])); }, []);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) { setErr(null); setOk(null); setRepo((r) => r || defaultRepo || repos[0] || ""); d.showModal?.(); }
    if (!open && d.open) d.close();
  }, [open, defaultRepo, repos]);
  const submit = async (): Promise<void> => {
    setBusy(true); setErr(null); setOk(null);
    try {
      const r = await startRun(normalizeTarget(target), { repo, ...(provider ? { provider } : {}), ...(model.trim() ? { model: model.trim() } : {}), ...(budget.trim() ? { budget: budget.trim() } : {}) });
      setOk(`Started (pid ${r.pid}). It will appear in Running shortly.`); setTarget(""); onStarted();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <dialog ref={ref} aria-labelledby="dlgT" onClose={onClose} onCancel={onClose}>
      <form className="dlg" method="dialog" onSubmit={(e) => { e.preventDefault(); if (target.trim() && repo) void submit(); }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 id="dlgT">New work</h3>
          <button type="button" className="iconbtn" aria-label="Close" onClick={onClose}><Icon id="x" /></button>
        </div>
        <label className="sr" htmlFor="nw-target">What to build</label>
        <textarea id="nw-target" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="An issue (owner/repo#123 or its link), a PRD path, or describe the change in one line" />
        <div className="fields">
          <label>Repository
            <select value={repo} onChange={(e) => setRepo(e.target.value)}>{repos.length === 0 ? <option value="">No repository seen</option> : repos.map((r) => <option key={r} value={r}>{r}</option>)}</select>
          </label>
          <label>Provider
            <select value={provider} onChange={(e) => setProvider(e.target.value)}><option value="">Default</option>{providers.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}</select>
          </label>
          <label>Model<input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Default" /></label>
          <label>Spend cap (USD)<input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="none" /></label>
        </div>
        <div className="acts" style={{ marginTop: 0 }}>
          <button type="submit" className="btn pri" disabled={busy || !target.trim() || !repo}>{busy ? "Starting" : "Start"}</button>
        </div>
        {err ? <p className="msg bad" role="alert">{err}</p> : null}
        {ok ? <p className="msg" role="status">{ok}</p> : null}
      </form>
    </dialog>
  );
}
