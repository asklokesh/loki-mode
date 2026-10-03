// CPE-19: Workspaces. Lists loki.yaml workspaces, per-repo latest run, and runs a workspace through POST /v1/runs.
// Workspaces holding shell commands (repo setup, integration.command) are read-only here: edit them in loki.yaml.
import { useEffect, useState } from "react";
import { authToken, listRuns, type RunRow } from "../../api";
import { Badge, Button, Card, EmptyState, Input, Spinner, Table, VerdictBadge } from "../../design/primitives";
import { buildViews, type WsView } from "./logic";

const base = () => (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE ?? "";
const headers = (): Record<string, string> => { const t = authToken(); return t ? { "content-type": "application/json", authorization: `Bearer ${t}` } : { "content-type": "application/json" }; };

async function loadConfig(): Promise<{ config: unknown; errors: string[] }> {
  const t = authToken();
  const res = await fetch(`${base()}/v1/config`, { headers: t ? { authorization: `Bearer ${t}` } : {} });
  if (!res.ok) throw new Error(`/v1/config: HTTP ${res.status}`);
  const j = (await res.json()) as { config?: unknown; errors?: string[] };
  return { config: j.config ?? {}, errors: j.errors ?? [] };
}

async function runWorkspace(workspace: string, target: string): Promise<{ pid: number; command: string }> {
  const res = await fetch(`${base()}/v1/runs`, { method: "POST", headers: headers(), body: JSON.stringify({ workspace, target }) });
  const j = (await res.json().catch(() => ({}))) as { error?: string; pid?: number; command?: string };
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
  return { pid: j.pid ?? 0, command: j.command ?? "" };
}

function RunBox({ name }: { name: string }) {
  const [target, setTarget] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true); setMsg(null);
    try { const r = await runWorkspace(name, target.trim()); setMsg({ ok: true, text: `Started: ${r.command} (pid ${r.pid})` }); }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <Input aria-label={`Target for ${name}`} placeholder="owner/repo#123 or a short task" value={target} onChange={(e) => setTarget(e.target.value)} />
        <Button disabled={busy || !target.trim()} onClick={go}>Run workspace</Button>
      </div>
      {msg ? <div role={msg.ok ? "status" : "alert"}><Badge tone={msg.ok ? "success" : "error"}>{msg.ok ? "started" : "refused"}</Badge> {msg.text}</div> : null}
    </div>
  );
}

function WsCard({ w }: { w: WsView }) {
  const rows = w.repos.map((r) => [
    <strong key="n">{r.name}</strong>,
    r.path ?? "not measured",
    r.after.length ? r.after.join(", ") : "none",
    r.latest ? (r.latest.verdict ? <VerdictBadge key="v" run={r.latest} /> : <Badge key="v" tone="neutral" pulse>running</Badge>) : "not measured",
    r.latest ? String(r.runs) : "not measured",
  ]);
  return (
    <Card>
      <div style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>{w.name}</h2>
          {w.shell ? <Badge tone="warning">read-only: runs shell commands</Badge> : null}
          <span style={{ marginLeft: "auto" }}>
            {w.status ? `Group: ${w.status.verified} of ${w.status.total} verified` + (w.status.failed ? `, ${w.status.failed} not verified` : "") + (w.status.running ? `, ${w.status.running} running` : "") : "Group status: not measured"}
          </span>
        </div>
        {w.repos.length ? <Table caption={`Repos in ${w.name}`} columns={["Repo", "Path", "After", "Latest run", "Runs"]} rows={rows} /> : <div>No repos listed</div>}
        {w.shell ? <div>Edit shell commands in loki.yaml; the UI never changes them.</div> : null}
        <RunBox name={w.name} />
      </div>
    </Card>
  );
}

export function Workspaces() {
  const [views, setViews] = useState<WsView[] | null>(null);
  const [errs, setErrs] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const { config, errors } = await loadConfig();
        let runs: RunRow[] = [];
        try { runs = (await listRuns()).runs; } catch { /* runs unavailable: statuses read not measured */ }
        if (live) { setViews(buildViews(config, runs)); setErrs(errors); }
      } catch (e) { if (live) setErr(e instanceof Error ? e.message : String(e)); }
    })();
    return () => { live = false; };
  }, []);

  if (err) return <EmptyState title="Could not load workspaces" hint={err} />;
  if (!views) return <Spinner label="Loading workspaces" />;
  if (!views.length) return <EmptyState title="No workspaces" hint="Define workspaces in loki.yaml to run a group of repos together." />;
  return (
    <div style={{ display: "grid", gap: 16 }}>
      {errs.length ? <div role="alert"><Badge tone="warning">loki.yaml has problems</Badge> {errs.join("; ")}</div> : null}
      {views.map((w) => <WsCard key={w.name} w={w} />)}
    </div>
  );
}
