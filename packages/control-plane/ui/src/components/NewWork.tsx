// New work: the target (owner/repo#N, an issue link or a one-line brief), the repository, and the options `loki start` takes as flags (provider, a model per role, spend cap).
// Start posts to POST /v1/start (the run then appears through the event stream); Check first posts the same request to POST /v1/start/check, which runs `loki start --dry-run`.
import { useEffect, useRef, useState } from "react";
import { checkRun, getProviders, startRun, type ProviderRow, type RoleModels } from "../api";
import { Icon } from "./Icon";

const ISSUE_URL = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)\/?$/;
/** A GitHub issue URL becomes the owner/repo#N form the server accepts; anything else is sent as typed. */
export const normalizeTarget = (s: string): string => { const m = ISSUE_URL.exec(s.trim()); return m ? `${m[1]}#${m[2]}` : s.trim(); };

const ISSUE_REF = /^[^/\s]+\/[^/\s#]+#\d+$/;
/** The five roles `loki start` takes a model for (--plan-model ... --advisor-model), in the order a run uses them. */
export const ROLES: { key: keyof RoleModels; label: string }[] = [{ key: "plan", label: "Plan" }, { key: "dev", label: "Build" }, { key: "test", label: "Tests" }, { key: "review", label: "Review" }, { key: "advisor", label: "Advisor" }];
const TIERS = ["haiku", "sonnet", "opus"];
/** Only the roles that were set; an empty object is left out of the request so Loki keeps its own choice. */
export const pickRoles = (r: RoleModels): RoleModels => Object.fromEntries(Object.entries(r).filter(([, v]) => typeof v === "string" && v.trim() !== "").map(([k, v]) => [k, (v as string).trim()])) as RoleModels;

export function NewWork({ open, onClose, repos, defaultRepo, onStarted }: { open: boolean; onClose: () => void; repos: string[]; defaultRepo: string | null; onStarted: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [target, setTarget] = useState("");
  const [repo, setRepo] = useState("");
  const [provider, setProvider] = useState("");
  const [roles, setRoles] = useState<RoleModels>({});
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<{ ok: boolean; output: string; issue: boolean } | null>(null);
  const [budget, setBudget] = useState("");
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  useEffect(() => { getProviders().then((p) => setProviders(p.providers.filter((x) => x.installed))).catch(() => setProviders([])); }, []);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) { setErr(null); setOk(null); setCheck(null); setRepo((r) => r || defaultRepo || repos[0] || ""); d.showModal?.(); }
    if (!open && d.open) d.close();
  }, [open, defaultRepo, repos]);
  const options = () => { const r = pickRoles(roles); return { repo, ...(provider ? { provider } : {}), ...(Object.keys(r).length ? { roles: r } : {}), ...(budget.trim() ? { budget: budget.trim() } : {}) }; };
  const runCheckFirst = async (): Promise<void> => {
    setChecking(true); setErr(null); setOk(null); setCheck(null);
    try {
      const t = normalizeTarget(target), r = await checkRun(t, options());
      setCheck({ ok: r.ok, output: r.output, issue: ISSUE_REF.test(t) });
    } catch (e) { setErr((e as Error).message); } finally { setChecking(false); }
  };
  const submit = async (): Promise<void> => {
    setBusy(true); setErr(null); setOk(null); setCheck(null);
    try {
      const r = await startRun(normalizeTarget(target), options());
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
        <textarea id="nw-target" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="An issue (owner/repo#123 or its link), or describe the change in one line" />
        <div className="fields">
          <label>Repository
            <select value={repo} onChange={(e) => setRepo(e.target.value)}>{repos.length === 0 ? <option value="">No repository seen</option> : repos.map((r) => <option key={r} value={r}>{r}</option>)}</select>
          </label>
          <label>Provider
            <select value={provider} onChange={(e) => setProvider(e.target.value)}><option value="">Default</option>{providers.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}</select>
          </label>
          <label>Spend cap (USD)<input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="none" /></label>
        </div>
        <div className="fields">
          {ROLES.map((r) => (
            <label key={r.key}>{r.label} model
              {provider === "opencode"
                ? <input value={roles[r.key] ?? ""} onChange={(e) => setRoles({ ...roles, [r.key]: e.target.value })} placeholder="Default" />
                : <select value={roles[r.key] ?? ""} onChange={(e) => setRoles({ ...roles, [r.key]: e.target.value })}><option value="">Default</option>{TIERS.map((t) => <option key={t} value={t}>{t}</option>)}</select>}
            </label>
          ))}
        </div>
        <div className="acts" style={{ marginTop: 0 }}>
          <button type="button" className="btn" disabled={busy || checking || !target.trim() || !repo} onClick={() => void runCheckFirst()}>{checking ? "Checking" : "Check first"}</button>
          <button type="submit" className="btn pri" disabled={busy || checking || !target.trim() || !repo}>{busy ? "Starting" : "Start"}</button>
        </div>
        {check ? (
          <div role="status">
            <p className={check.ok ? "msg" : "msg bad"}>{check.ok ? "Check passed. Nothing was run and no tokens were spent." : "Check failed. Nothing was started."}</p>
            <pre className="checkout">{check.output || "(no output)"}</pre>
            {check.issue ? <p className="msg">For an issue this confirms the route only. The models are validated when you start.</p> : null}
          </div>
        ) : null}
        {err ? <p className="msg bad" role="alert">{err}</p> : null}
        {ok ? <p className="msg" role="status">{ok}</p> : null}
      </form>
    </dialog>
  );
}
