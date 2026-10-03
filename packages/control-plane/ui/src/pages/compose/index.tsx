// CPE-08: the new run composer. One input, chips for the optional run fields, Cmd+Enter to start.
import { useEffect, useRef, useState } from "react";
import { Button, Chip, EmptyState, Kbd, Message, Spinner, Toast } from "../../design/primitives";
import { fetchRepos, postRun, StartError, type RunRequest } from "./api";

// Server allowlist (spawn.ts PROVIDERS). Models and budgets are validated by pattern there; these are suggestions only.
export const PROVIDERS = ["claude", "codex", "cline", "aider", "opencode"] as const;
export const MODELS = ["opus", "sonnet", "haiku"] as const;
export const BUDGETS = ["1", "5", "10", "25", "50"] as const;

const ISSUE_URL = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9._-]+)\/issues\/([1-9][0-9]*)\/?$/;

/** The server refuses ':' in a target, so a GitHub issue URL is sent in its owner/repo#N form. Everything else is sent as typed. */
export function normalizeTarget(raw: string): string {
  const s = raw.trim();
  const m = ISSUE_URL.exec(s);
  return m ? `${m[1]}/${m[2]}#${m[3]}` : s;
}

export interface Chips { repo?: string; model?: string; provider?: string; budget?: string; workspace?: string }

/** Only chips the user set are sent. A workspace run takes no provider or budget (server rule), so those are dropped with it. */
export function buildBody(input: string, c: Chips): RunRequest {
  const body: RunRequest = { target: normalizeTarget(input) };
  if (c.repo) body.repo = c.repo;
  if (c.model) body.model = c.model;
  if (c.workspace) body.workspace = c.workspace;
  else {
    if (c.provider) body.provider = c.provider;
    if (c.budget) body.budget = c.budget;
  }
  return body;
}

export function errorText(e: unknown): string {
  if (e instanceof StartError) {
    if (e.status === 400) return `The server refused this run: ${e.message}`;
    if (e.status === 403) return `Not allowed: ${e.message}. Starting runs works only from the machine running the control service.`;
    if (e.status === 409) return `${e.message}. Wait for it to finish, or pick another repo.`;
    return e.message;
  }
  return e instanceof Error ? e.message : "could not reach the control service";
}

const opts = (xs: readonly string[], none: string) => [{ value: "", label: none }, ...xs.map((x) => ({ value: x, label: x }))];

export function Composer() {
  const [text, setText] = useState("");
  const [chips, setChips] = useState<Chips>({});
  const [repos, setRepos] = useState<string[] | null>(null);
  const [wsOpen, setWsOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const set = (k: keyof Chips) => (v: string) => setChips((c) => ({ ...c, [k]: v || undefined }));

  useEffect(() => {
    let live = true;
    fetchRepos().then((r) => live && setRepos(r)).catch(() => live && setRepos([]));
    area.current?.focus();
    return () => { live = false; };
  }, []);

  const busy = pending !== null;
  const submit = async () => {
    if (busy || !text.trim()) return;
    const body = buildBody(text, chips);
    setError(null);
    setPending(body.target);
    try {
      await postRun(body);
      location.hash = "#/runs";
    } catch (e) {
      setPending(null);
      setError(errorText(e));
    }
  };

  const workspace = !!chips.workspace;
  return (
    <section data-testid="composer" style={{ maxWidth: 760, margin: "0 auto", padding: "var(--cp-space-2xl) var(--cp-space-xl)" }}>
      {pending === null && !text ? (
        <EmptyState
          title="What should Loki build?"
          hint="Paste owner/repo#N or a GitHub issue URL, give a PRD path, or describe a task. Nothing starts until you press Cmd+Enter."
        />
      ) : null}
      {pending !== null ? (
        <div data-testid="optimistic-row">
          <Message icon={<Spinner size={14} label="Starting" />} title={pending} meta="starting, waiting for the control service" />
        </div>
      ) : null}
      <div style={{ border: "1px solid var(--cp-border)", borderRadius: "var(--cp-radius-lg)", background: "var(--cp-card)", padding: 12, marginTop: 16 }}>
        <textarea
          ref={area}
          data-testid="composer-input"
          aria-label="Task, issue or PRD path"
          value={text}
          rows={4}
          disabled={busy}
          placeholder="owner/repo#123, an issue URL, a PRD path, or a task"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); } }}
          style={{ width: "100%", resize: "vertical", border: 0, outline: "none", background: "transparent", color: "var(--cp-text)", font: "inherit", fontSize: "var(--cp-text-md)" }}
        />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginTop: 8 }}>
          <span data-testid="chip-repo"><Chip label="repo" value={chips.repo ?? "server directory"} options={opts(repos ?? [], "server directory")} onSelect={set("repo")} /></span>
          <span data-testid="chip-model"><Chip label="model" value={chips.model ?? "default"} options={opts(MODELS, "default")} onSelect={set("model")} /></span>
          <span data-testid="chip-provider"><Chip label="provider" value={workspace ? "set per repo" : chips.provider ?? "default"} options={workspace ? undefined : opts(PROVIDERS, "default")} onSelect={set("provider")} /></span>
          <span data-testid="chip-budget"><Chip label="budget" value={workspace ? "set per repo" : chips.budget ? `$${chips.budget}` : "none"} options={workspace ? undefined : opts(BUDGETS.map(String), "none").map((o) => ({ ...o, label: o.value ? `$${o.value}` : o.label }))} onSelect={set("budget")} /></span>
          <span data-testid="chip-workspace" onClick={() => setWsOpen((o) => !o)}>
            <Chip label="workspace" value={chips.workspace ?? "none"} />
          </span>
          {wsOpen ? (
            <input
              data-testid="workspace-input"
              aria-label="Workspace name from loki.yaml"
              placeholder="name from loki.yaml"
              value={chips.workspace ?? ""}
              onChange={(e) => set("workspace")(e.target.value.trim())}
              style={{ border: "1px solid var(--cp-border)", borderRadius: "var(--cp-radius-md)", background: "var(--cp-bg)", color: "var(--cp-text)", padding: "4px 8px", fontSize: "var(--cp-text-base)" }}
            />
          ) : null}
          <span style={{ flex: 1 }} />
          <Button data-testid="composer-submit" disabled={busy || !text.trim()} onClick={() => void submit()}>Start <Kbd>Cmd+Enter</Kbd></Button>
        </div>
      </div>
      {repos !== null && repos.length === 0 ? (
        <p data-testid="no-repos" style={{ color: "var(--cp-text-2)", fontSize: "var(--cp-text-base)", marginTop: 8 }}>
          No repos discovered yet. The run starts in the directory the control service was launched from.
        </p>
      ) : null}
      {error ? <div data-testid="composer-error" style={{ marginTop: 12 }}><Toast tone="error" onClose={() => setError(null)}>{error}</Toast></div> : null}
    </section>
  );
}

export const page = { id: "compose", path: "/new", title: "New run", component: Composer };
