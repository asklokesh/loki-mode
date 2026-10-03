// Composer-first home: one centered input (task, owner/repo#N or issue URL) with repo and harness pickers.
// Only options the existing API exposes are offered: repo (GET /v1/repos), provider and model (POST /v1/runs). The API has no base-branch field and no plan-only mode, so neither is shown.
import { useEffect, useRef, useState } from "react";
import { Button, Chip, Kbd } from "../../design/primitives";
import { buildBody, errorText, MODELS, PROVIDERS, type Chips } from "../compose";
import { defaultRepoLabel, fetchRepoInfo, postRun } from "../compose/api";

const opts = (xs: readonly string[], none: string) => [{ value: "", label: none }, ...xs.map((x) => ({ value: x, label: x }))];

export function Hero({ onStarted }: { onStarted?: () => void }) {
  const [text, setText] = useState("");
  const [chips, setChips] = useState<Chips>({});
  const [repos, setRepos] = useState<string[] | null>(null);
  const [defaultRepo, setDefaultRepo] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const inflight = useRef(false);
  const set = (k: keyof Chips) => (v: string) => setChips((c) => ({ ...c, [k]: v || undefined }));

  useEffect(() => {
    let live = true;
    fetchRepoInfo().then((r) => { if (live) { setRepos(r.repos); setDefaultRepo(r.defaultRepo); } }).catch(() => live && setRepos([]));
    return () => { live = false; };
  }, []);

  const submit = async () => {
    if (inflight.current || !text.trim()) return;
    inflight.current = true;
    setPending(true);
    setNote(null);
    try {
      const body = buildBody(text, chips);
      await postRun(body);
      setText("");
      setNote({ tone: "ok", text: `Started: ${body.target}` });
      onStarted?.();
    } catch (e) {
      setNote({ tone: "error", text: errorText(e) });
    } finally { inflight.current = false; setPending(false); }
  };

  return (
    <section data-testid="hero" style={{ maxWidth: 720, margin: "0 auto", padding: "var(--cp-space-2xl) 0 var(--cp-space-xl)", textAlign: "center" }}>
      <div className="cp-eyebrow" style={{ marginBottom: 12 }}>Loki Mode</div>
      <h1 className="cp-display" style={{ fontSize: 40, margin: "0 0 24px", color: "var(--cp-text)" }}>What should Loki build?</h1>
      <div style={{ border: "1px solid var(--cp-border)", borderRadius: 24, background: "var(--cp-card)", padding: "14px 16px", textAlign: "left" }}>
        <textarea
          data-testid="hero-input"
          aria-label="Task, owner/repo#N or issue URL"
          value={text}
          rows={3}
          disabled={pending}
          placeholder="Describe a task, or paste owner/repo#123 or an issue URL"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); } }}
          style={{ width: "100%", resize: "none", border: 0, outline: "none", background: "transparent", color: "var(--cp-text)", font: "inherit", fontSize: "var(--cp-text-lg, 16px)" }}
        />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginTop: 8 }}>
          <span data-testid="pick-repo"><Chip label="repo" value={chips.repo ?? defaultRepoLabel(defaultRepo)} options={opts(repos ?? [], defaultRepo ? `${defaultRepo} (server directory)` : "server directory")} onSelect={set("repo")} /></span>
          <span data-testid="pick-provider"><Chip label="provider" value={chips.provider ?? "default"} options={opts(PROVIDERS, "default")} onSelect={set("provider")} /></span>
          <span data-testid="pick-model"><Chip label="model" value={chips.model ?? "default"} options={opts(MODELS, "default")} onSelect={set("model")} /></span>
          <span style={{ flex: 1 }} />
          <Button data-testid="hero-start" disabled={pending || !text.trim()} onClick={() => void submit()}>Start <Kbd>Enter</Kbd></Button>
        </div>
      </div>
      {note ? (
        <p role={note.tone === "error" ? "alert" : "status"} data-testid="hero-note" style={{ marginTop: 12, fontSize: "var(--cp-text-base)", color: note.tone === "error" ? "var(--cp-error)" : "var(--cp-text-2)" }}>{note.text}</p>
      ) : null}
    </section>
  );
}
