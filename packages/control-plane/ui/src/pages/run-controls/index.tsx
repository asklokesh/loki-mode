// Run controls (CPE-10): Stop (with a confirm step), Retry and Resume for the run header slot. The server's refusal text is shown as returned.
import { useState } from "react";
import { authToken } from "../../api";
import { Button } from "../../design/primitives";

export type ControlKind = "stop" | "retry" | "resume";

const base = (): string => (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE ?? "";

/** POST a control action; throws an Error carrying the server's own message (409 busy, 501 retry unavailable, pid refused). */
export async function postControl(source: string, run: string, kind: ControlKind): Promise<void> {
  const t = authToken();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (t) headers.authorization = `Bearer ${t}`;
  const res = await fetch(`${base()}/v1/runs/${encodeURIComponent(source)}/${encodeURIComponent(run)}/${kind}`, { method: "POST", headers, body: "{}" });
  const j = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
}

const PENDING: Record<ControlKind, string> = { stop: "Stopping...", retry: "Retrying...", resume: "Resuming..." };
const DONE: Record<ControlKind, string> = { stop: "Stop signal sent.", retry: "Retry started as a new run.", resume: "Resume started." };

export function RunControls({ source, run, status, onChanged }: { source: string; run: string; status: string; onChanged?: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState<ControlKind | null>(null);
  const [stopped, setStopped] = useState(false);
  const [resumed, setResumed] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const s = status.trim().toUpperCase();
  // Optimistic view: a pending or accepted stop reads as stopping, a pending or accepted resume reads as running. A failure restores the prop status.
  const stopping = pending === "stop" || stopped;
  const running = !stopping && (pending === "resume" || resumed || s === "RUNNING");
  const blocked = s === "BLOCKED" && !running && !stopping;

  const act = async (kind: ControlKind) => {
    if (pending) return;
    setConfirming(false);
    setNote(null);
    setPending(kind);
    try {
      await postControl(source, run, kind);
      if (kind === "stop") setStopped(true);
      if (kind === "resume") setResumed(true);
      setNote({ tone: "ok", text: DONE[kind] });
      onChanged?.();
    } catch (e) {
      setNote({ tone: "error", text: (e as Error).message });
    } finally {
      setPending(null);
    }
  };

  return (
    <div data-testid="run-controls" data-state={stopping ? "stopping" : running ? "running" : s.toLowerCase()} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      {running && !pending && !confirming ? <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>Stop</Button> : null}
      {confirming ? (
        <span data-testid="stop-confirm" role="group" aria-label="Confirm stop" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span>Stop this run?</span>
          <Button variant="danger" size="sm" onClick={() => void act("stop")}>Confirm stop</Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>Cancel</Button>
        </span>
      ) : null}
      {blocked && !pending ? <Button size="sm" onClick={() => void act("resume")}>Resume</Button> : null}
      {!running && !stopping && !pending && s !== "" ? <Button variant="secondary" size="sm" onClick={() => void act("retry")}>Retry</Button> : null}
      {pending ? <span role="status">{PENDING[pending]}</span> : null}
      {!pending && note ? <span role={note.tone === "error" ? "alert" : "status"} style={note.tone === "error" ? { color: "var(--cp-error)" } : undefined}>{note.text}</span> : null}
    </div>
  );
}
