// CPE-25: Merge queue. Wraps `loki merge` through the control service; the CLI stays the source of truth.
import { useCallback, useEffect, useState } from "react";
import { authToken } from "../../api";
import { Badge, Button, Card, EmptyState, Input, Spinner } from "../../design/primitives";

const base = (): string => (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE ?? "";
const headers = (json: boolean): Record<string, string> => {
  const t = authToken();
  return { ...(json ? { "content-type": "application/json" } : {}), ...(t ? { authorization: `Bearer ${t}` } : {}) };
};

interface RunResult { ok: boolean; ran: boolean; dryRun: boolean; exit: number | null; lines: string[]; error?: string }

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base()}${path}`, init);
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}

export function MergePage() {
  const [queue, setQueue] = useState<number[] | null>(null);
  const [qErr, setQErr] = useState<string | null>(null);
  const [pr, setPr] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [plan, setPlan] = useState<RunResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await call<{ measured: boolean; queue: number[]; error?: string }>("/v1/merge/queue", { headers: headers(false) });
      if (r.measured) { setQueue(r.queue); setQErr(null); } else { setQueue(null); setQErr(r.error ?? "not measured"); }
    } catch (e) { setQueue(null); setQErr(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const valid = /^[0-9]{1,7}$/.test(pr.trim());
  const add = async () => {
    setBusy(true); setMsg(null);
    try {
      await call("/v1/merge/queue", { method: "POST", headers: headers(true), body: JSON.stringify({ prs: [pr.trim()] }) });
      setMsg({ tone: "success", text: `Queued PR #${pr.trim()}` }); setPr(""); await load();
    } catch (e) { setMsg({ tone: "error", text: e instanceof Error ? e.message : String(e) }); }
    setBusy(false);
  };
  const run = async (dryRun: boolean) => {
    setBusy(true); setMsg(null); setConfirming(false);
    try {
      const r = await call<RunResult>("/v1/merge/run", { method: "POST", headers: headers(true), body: JSON.stringify({ dryRun }) });
      if (dryRun) { setPlan(r); setResult(null); } else { setResult(r); setPlan(null); }
      await load();
    } catch (e) { setMsg({ tone: "error", text: e instanceof Error ? e.message : String(e) }); }
    setBusy(false);
  };

  const empty = queue !== null && queue.length === 0;
  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 720 }}>
      <h1 style={{ margin: 0, fontSize: "var(--cp-text-xl, 20px)" }}>Merge queue</h1>
      <Card>
        <div style={{ display: "grid", gap: 8 }}>
          <strong>Queue</strong>
          {qErr ? <EmptyState title="Queue not measured" hint={qErr} />
            : queue === null ? <Spinner label="Reading the queue" />
              : empty ? <small>The merge queue is empty.</small>
                : <ol aria-label="Queued pull requests" style={{ margin: 0, paddingLeft: 20 }}>{queue.map((n) => <li key={n}>PR #{n}</li>)}</ol>}
          <div style={{ display: "flex", gap: 8 }}>
            <Input aria-label="PR number" inputMode="numeric" placeholder="PR number" value={pr} onChange={(e) => setPr(e.target.value.replace(/[^0-9]/g, "").slice(0, 7))} />
            <Button variant="secondary" disabled={!valid || busy} onClick={add}>Add</Button>
          </div>
        </div>
      </Card>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Button variant="secondary" disabled={busy || empty || queue === null} onClick={() => run(true)}>Preview</Button>
        {!confirming
          ? <Button disabled={busy || empty || queue === null} onClick={() => setConfirming(true)}>Merge queue</Button>
          : (
            <span role="alertdialog" aria-label="Confirm merge" style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
              <small>Squash-merge each PR whose checks are green, one at a time. This cannot be undone.</small>
              <Button variant="danger" disabled={busy} onClick={() => run(false)}>Confirm merge</Button>
              <Button variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
            </span>
          )}
        {busy ? <Spinner label="Working" /> : null}
      </div>
      {msg ? <Badge tone={msg.tone}>{msg.text}</Badge> : null}
      {plan ? <Card><strong>Plan (dry run, nothing changed)</strong><pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{plan.lines.join("\n") || "not measured"}</pre></Card> : null}
      {result ? (
        <Card>
          <strong>Merge result</strong> <Badge tone={result.ok ? "success" : "warning"}>{result.ok ? "all merged" : "some PRs left in queue"}</Badge>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{result.lines.join("\n")}</pre>
        </Card>
      ) : null}
    </div>
  );
}

export const page = { id: "merge", path: "/merge", title: "Merge queue", component: MergePage };
