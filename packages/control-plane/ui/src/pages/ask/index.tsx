// Ask Loki: a thread view with streamed answers and follow-ups. History lives in the sidebar.
// Loki may offer "Start a run on X#N?"; the button only opens the New run confirm dialog, it never starts a run.
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Button, EmptyState, Spinner } from "../../design/primitives";
import { openNewRun } from "../compose/store";
import { AskError, getThread, offersIn, postAsk, refreshAsk, streamMessage, useAsk, type AskEvent, type AskMessage, type AskThread } from "./api";

const TERMINAL = ["done", "complete", "completed", "error", "failed", "cancelled", "canceled"];
const muted: CSSProperties = { color: "var(--cp-text-muted)", fontSize: "var(--cp-text-sm)" };
const goto = (id: string) => { location.hash = `#/ask/${encodeURIComponent(id)}`; };

export function Offers({ text }: { text: string }) {
  const refs = offersIn(text);
  if (refs.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
      {refs.map((r) => <Button key={r} variant="secondary" size="sm" data-testid="offer-run" onClick={() => openNewRun(r)}>Start a run on {r}?</Button>)}
    </div>
  );
}

export function MessageView({ m, tool }: { m: AskMessage; tool?: string | null }) {
  const user = m.role === "user";
  return (
    <div data-testid={user ? "ask-user" : "ask-assistant"} data-status={m.status}
      style={{ alignSelf: user ? "flex-end" : "stretch", maxWidth: user ? "80%" : "100%", padding: user ? "10px 14px" : "4px 0", borderRadius: "var(--cp-radius-lg)", background: user ? "var(--cp-bg-3)" : "transparent", color: "var(--cp-text)", fontSize: "var(--cp-text-md)", lineHeight: 1.6, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
      {m.text}
      {!user && tool ? <div data-testid="ask-tool" style={muted}>Using {tool}</div> : null}
      {m.error ? <div role="alert" data-testid="ask-message-error" style={{ color: "var(--cp-error)", marginTop: 6 }}>{m.error}</div> : null}
      {!user && !TERMINAL.includes(m.status) && m.text === "" && !tool ? <Spinner label="Loki is answering" /> : null}
      {!user ? <Offers text={m.text} /> : null}
    </div>
  );
}

export function Composer({ busy, onSend, placeholder }: { busy: boolean; onSend: (q: string) => void; placeholder: string }) {
  const [q, setQ] = useState("");
  const send = () => { const s = q.trim(); if (!s || busy) return; onSend(s); setQ(""); };
  return (
    <form onSubmit={(e) => { e.preventDefault(); send(); }} style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
      <textarea aria-label="Ask Loki" data-testid="ask-input" rows={2} value={q} placeholder={placeholder} maxLength={4000} disabled={busy}
        onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
        style={{ flex: 1, resize: "vertical", padding: "10px 12px", borderRadius: "var(--cp-radius-md)", border: "1px solid var(--cp-border)", background: "var(--cp-bg)", color: "var(--cp-text)", font: "inherit", fontSize: "var(--cp-text-md)" }} />
      <Button type="submit" data-testid="ask-send" disabled={busy || q.trim() === ""}>Ask</Button>
    </form>
  );
}

const failText = (e: unknown): string => (e instanceof AskError && e.status === 404 ? "Ask Loki is not available on this control service." : e instanceof Error ? e.message : "could not reach the control service");

function NotEnabled() {
  return <EmptyState title="Ask Loki is off" hint="This control service was started without LOKI_CP_ASK, so there is nothing to ask. Set LOKI_CP_ASK=1 and restart it." />;
}

export function AskThreadView({ id }: { id: string }) {
  const [data, setData] = useState<AskThread | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tool, setTool] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const streaming = useRef(new Set<string>());
  const alive = useRef(true);
  const bottom = useRef<HTMLDivElement>(null);

  const patch = useCallback((mid: string, f: (m: AskMessage) => AskMessage) => {
    setData((d) => (d ? { ...d, messages: d.messages.map((m) => (m.id === mid ? f(m) : m)) } : d));
  }, []);

  const follow = useCallback((mid: string) => {
    if (streaming.current.has(mid)) return;
    streaming.current.add(mid);
    setBusy(true);
    const on = (e: AskEvent) => {
      if (!alive.current) return;
      if (e.type === "delta") patch(mid, (m) => ({ ...m, status: "streaming", text: m.text + e.text }));
      else if (e.type === "tool_use") setTool((t) => ({ ...t, [mid]: e.name }));
      else if (e.type === "result") patch(mid, (m) => (e.isError ? { ...m, error: e.text } : m.text === "" ? { ...m, text: e.text } : m));
      else if (e.type === "error") patch(mid, (m) => ({ ...m, status: "error", error: e.message }));
      else if (e.type === "done") patch(mid, (m) => ({ ...m, status: m.status === "error" ? "error" : e.status || "done" }));
    };
    streamMessage(mid, on).catch((e: unknown) => alive.current && patch(mid, (m) => ({ ...m, status: "error", error: failText(e) })))
      .finally(() => {
        streaming.current.delete(mid);
        if (!alive.current) return;
        setTool((t) => { const { [mid]: _, ...rest } = t; return rest; });
        setBusy(streaming.current.size > 0);
        void refreshAsk();
      });
  }, [patch]);

  const load = useCallback(() => {
    getThread(id).then((t) => {
      if (!alive.current) return;
      setData(t);
      setError(null);
      for (const m of t.messages) if (m.role === "assistant" && !TERMINAL.includes(m.status)) follow(m.id);
    }, (e: unknown) => alive.current && setError(failText(e)));
  }, [id, follow]);

  useEffect(() => { alive.current = true; setData(null); setError(null); load(); return () => { alive.current = false; }; }, [load]);
  useEffect(() => { bottom.current?.scrollIntoView?.({ block: "end" }); }, [data?.messages.length, data?.messages.at(-1)?.text]);

  const send = (question: string) => {
    setError(null);
    postAsk({ question, thread_id: id }).then(() => load(), (e: unknown) => setError(failText(e)));
  };

  if (error && !data) return <EmptyState title="Could not open this thread" hint={error} />;
  if (!data) return <Spinner label="Loading thread" />;
  return (
    <section data-testid="ask-thread" style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 760, margin: "0 auto" }}>
      <h1 style={{ fontFamily: "var(--cp-font-serif)", fontWeight: 400, fontSize: "var(--cp-text-2xl)", margin: 0 }}>{data.thread.title}</h1>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {data.messages.map((m) => <MessageView key={m.id} m={m} tool={tool[m.id]} />)}
        <div ref={bottom} />
      </div>
      {error ? <p role="alert" data-testid="ask-error" style={{ margin: 0, color: "var(--cp-error)" }}>{error}</p> : null}
      <Composer busy={busy} onSend={send} placeholder="Ask a follow-up" />
    </section>
  );
}

export function AskNew() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = (question: string) => {
    setBusy(true);
    setError(null);
    postAsk({ question }).then((r) => { void refreshAsk(); goto(r.thread_id); }, (e: unknown) => { setError(failText(e)); setBusy(false); });
  };
  return (
    <section data-testid="ask-new" style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 760, margin: "12vh auto 0" }}>
      <h1 style={{ fontFamily: "var(--cp-font-serif)", fontWeight: 400, fontSize: "var(--cp-text-3xl, 2rem)", margin: 0 }}>Ask Loki</h1>
      <p style={{ ...muted, margin: 0 }}>Ask about your runs, repos and issues. Loki answers from what it can read and never starts a run without your confirmation.</p>
      {error ? <p role="alert" data-testid="ask-error" style={{ margin: 0, color: "var(--cp-error)" }}>{error}</p> : null}
      <Composer busy={busy} onSend={send} placeholder="What do you want to know?" />
    </section>
  );
}

export function AskPage({ id }: { id?: string }) {
  const ask = useAsk();
  if (!ask.checked) return <Spinner label="Checking Ask Loki" />;
  if (!ask.enabled) return ask.error ? <EmptyState title="Could not reach Ask Loki" hint={ask.error} /> : <NotEnabled />;
  return id ? <AskThreadView key={id} id={id} /> : <AskNew />;
}

export const askPage = { id: "ask", path: "/ask", title: "Ask Loki", component: () => <AskPage /> };
export const askThreadPage = { id: "ask-thread", path: "/ask/:id", title: "Ask Loki thread", component: ({ params }: { params: Record<string, string> }) => <AskPage id={params.id} /> };
