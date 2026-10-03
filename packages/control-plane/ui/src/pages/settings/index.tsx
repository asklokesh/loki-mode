// CPE-14: Settings forms, one card per loki.yaml schema section (schemas/loki-yaml.schema.json). Credentials are env var NAMES only.
import { useEffect, useId, useState } from "react";
import { Badge, Button, Card, EmptyState, Input, Spinner, Textarea } from "../../design/primitives";
import { ConfigError, loadConfig, saveConfig, type ConfigObject, type ConfigState } from "./config-api";

const t = (n: string) => `var(--cp-${n})`;

type Kind = "text" | "select" | "number" | "lines" | "json" | "env";
interface Field { path: string[]; label: string; kind: Kind; options?: string[]; hint?: string }
interface Section { id: string; title: string; hint: string; fields: Field[] }

export const SECTIONS: Section[] = [
  { id: "provider", title: "Provider", hint: "Default provider. A CLI flag or LOKI_PROVIDER overrides it.", fields: [{ path: ["provider"], label: "Provider", kind: "select", options: ["claude", "codex", "cline", "aider", "opencode"] }] },
  { id: "models", title: "Models", hint: "Model names passed to the provider.", fields: [
    { path: ["models", "default"], label: "Default model", kind: "text" }, { path: ["models", "cheap"], label: "Cheap model", kind: "text" }] },
  { id: "git", title: "Git", hint: "Name of the environment variable that holds your GitHub token. The token itself is never stored here.", fields: [
    { path: ["git", "token_env"], label: "Token variable name", kind: "env", hint: "For example GITHUB_TOKEN" }] },
  { id: "repos", title: "Repos", hint: "owner/repo, one per line. The UI offers these and headless runs may target them.", fields: [{ path: ["repos"], label: "Repos", kind: "lines" }] },
  { id: "concurrency", title: "Concurrency", hint: "Backlog runs in parallel, 1 to 32 (default 2).", fields: [{ path: ["concurrency"], label: "Parallel runs", kind: "number" }] },
  { id: "budgets", title: "Budgets", hint: "USD caps. Leave blank for no cap.", fields: [
    { path: ["budgets", "per_run_usd"], label: "Per run (USD)", kind: "number" }, { path: ["budgets", "per_day_usd"], label: "Per day (USD)", kind: "number" }] },
  { id: "knowledge_sources", title: "Knowledge sources", hint: "Local paths of knowledge to give runs, one per line.", fields: [{ path: ["knowledge_sources"], label: "Paths", kind: "lines" }] },
  { id: "workspaces", title: "Workspaces", hint: "Named groups of repos for cross-repo runs. Edited as JSON; the server validates it against the schema.", fields: [{ path: ["workspaces"], label: "Workspaces (JSON)", kind: "json" }] },
  { id: "notifications", title: "Notifications", hint: "Name of the environment variable that holds the Slack webhook URL. The URL itself is never stored here.", fields: [
    { path: ["notifications", "slack_webhook_env"], label: "Webhook variable name", kind: "env", hint: "For example SLACK_WEBHOOK_URL" }] },
];

const isObj = (v: unknown): v is ConfigObject => typeof v === "object" && v !== null && !Array.isArray(v);
const getAt = (c: ConfigObject, p: string[]): unknown => p.reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), c);

function setAt(c: ConfigObject, p: string[], v: unknown): ConfigObject {
  const out: ConfigObject = { ...c };
  const [k, ...rest] = p;
  if (k === undefined) return out;
  if (rest.length === 0) { if (v === undefined) delete out[k]; else out[k] = v; return out; }
  const child = setAt(isObj(out[k]) ? (out[k] as ConfigObject) : {}, rest, v);
  if (Object.keys(child).length === 0) delete out[k]; else out[k] = child;
  return out;
}

function show(f: Field, v: unknown): string {
  if (v === undefined || v === null) return "";
  if (f.kind === "lines") return Array.isArray(v) ? v.join("\n") : "";
  if (f.kind === "json") return JSON.stringify(v, null, 2);
  return String(v);
}

/** Text to value. Blank means unset. Returns an error string for input that cannot be parsed. */
function parse(f: Field, s: string): { value?: unknown; error?: string } {
  const text = s.trim();
  if (text === "") return { value: undefined };
  if (f.kind === "number") { const n = Number(text); return Number.isFinite(n) ? { value: n } : { error: `${f.label} must be a number` }; }
  if (f.kind === "lines") return { value: text.split("\n").map((l) => l.trim()).filter(Boolean) };
  if (f.kind === "json") {
    try { const j: unknown = JSON.parse(text); return isObj(j) ? { value: j } : { error: `${f.label} must be a JSON object` }; } catch { return { error: `${f.label} is not valid JSON` }; }
  }
  return { value: text };
}

function SectionCard({ section, state, onSave }: { section: Section; state: ConfigState; onSave: (next: ConfigObject) => Promise<void> }) {
  const base = section.fields.map((f) => show(f, getAt(state.config, f.path)));
  const [draft, setDraft] = useState<string[]>(base);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const id = useId();
  const baseKey = JSON.stringify(base);
  useEffect(() => { setDraft(base); setProblems([]); }, [baseKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = draft.some((d, i) => d !== base[i]);

  const submit = async () => {
    const bad: string[] = [];
    let next = state.config;
    section.fields.forEach((f, i) => {
      const r = parse(f, draft[i] ?? "");
      if (r.error) bad.push(r.error); else next = setAt(next, f.path, r.value);
    });
    if (bad.length) { setProblems(bad); return; }
    setBusy(true); setProblems([]); setSaved(false);
    try { await onSave(next); setSaved(true); }
    catch (e) { setProblems(e instanceof ConfigError ? [e.message, ...e.details] : [(e as Error).message]); }
    finally { setBusy(false); }
  };

  return (
    <Card data-testid={`settings-${section.id}`} aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} style={{ margin: 0, fontFamily: t("font-serif"), fontWeight: 400, fontSize: t("text-xl") }}>{section.title}</h2>
      <p style={{ margin: "4px 0 12px", color: t("text-2"), fontSize: t("text-md") }}>{section.hint}</p>
      <div style={{ display: "grid", gap: 12 }}>
        {section.fields.map((f, i) => {
          const fid = `${id}-${i}`;
          const set = (v: string) => { setSaved(false); setDraft((d) => d.map((x, j) => (j === i ? v : x))); };
          const common = { id: fid, value: draft[i] ?? "", "data-field": f.path.join(".") };
          return (
            <div key={f.path.join(".")}>
              <label htmlFor={fid} style={{ display: "block", fontSize: t("text-md"), marginBottom: 4 }}>{f.label}</label>
              {f.kind === "select" ? (
                <select {...common} onChange={(e) => set(e.target.value)} style={{ padding: "8px 10px", borderRadius: t("radius-md"), border: `1px solid ${t("border")}`, background: t("bg"), color: t("text"), font: "inherit" }}>
                  <option value="">Not set</option>
                  {f.options!.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : f.kind === "lines" || f.kind === "json" ? (
                <Textarea {...common} rows={f.kind === "json" ? 8 : 4} spellCheck={false} onChange={(e) => set(e.target.value)} style={f.kind === "json" ? { fontFamily: t("font-mono") } : undefined} />
              ) : (
                <Input {...common} type={f.kind === "number" ? "number" : "text"} step={f.kind === "number" ? "any" : undefined} autoComplete="off" spellCheck={false} placeholder={f.kind === "env" ? "ENV_VAR_NAME" : undefined} onChange={(e) => set(e.target.value)} style={f.kind === "env" ? { fontFamily: t("font-mono") } : undefined} />
              )}
              {f.hint ? <div style={{ color: t("text-3"), fontSize: t("text-base"), marginTop: 4 }}>{f.hint}</div> : null}
            </div>
          );
        })}
      </div>
      {problems.length ? (
        <ul role="alert" data-testid="settings-problems" style={{ margin: "12px 0 0", paddingLeft: 18, color: t("error"), fontSize: t("text-md") }}>
          {problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      ) : null}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
        <Button disabled={!dirty || busy} onClick={submit}>{busy ? "Saving" : "Save"}</Button>
        {saved && !dirty ? <Badge tone="success">Saved</Badge> : null}
      </div>
    </Card>
  );
}

export function ConfigSettings() {
  const [state, setState] = useState<ConfigState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () => { setError(null); loadConfig().then(setState, (e: Error) => setError(e.message)); };
  useEffect(reload, []);

  if (error) return <EmptyState title="Configuration unavailable" hint={error} action={<Button variant="secondary" onClick={reload}>Retry</Button>} />;
  if (!state) return <Spinner label="Loading configuration" />;

  const save = async (next: ConfigObject) => {
    try {
      const r = await saveConfig(next, state.etag);
      setState({ exists: true, etag: r.etag, config: r.config, errors: [] });
    } catch (e) {
      if (e instanceof ConfigError && e.status === 409) throw new ConfigError("loki.yaml changed on disk since it was loaded. Reload to see the latest, then apply your edit again.", 409, []);
      throw e;
    }
  };

  return (
    <div data-testid="config-settings" style={{ display: "grid", gap: 16, maxWidth: 720 }}>
      <div>
        <h1 style={{ margin: 0, fontFamily: t("font-serif"), fontWeight: 400, fontSize: t("text-2xl") }}>Configuration</h1>
        <p style={{ margin: "4px 0 0", color: t("text-2"), fontSize: t("text-md") }}>
          {state.exists ? "Edits loki.yaml in this repo. Comments are kept." : "No loki.yaml in this repo yet. Saving a section creates it."}
          {" "}Credentials are environment variable names, never values.
        </p>
      </div>
      {state.errors.length ? (
        <Card data-testid="config-file-errors" role="alert" style={{ borderColor: t("error") }}>
          <strong>The current loki.yaml has problems</strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>
        </Card>
      ) : null}
      {SECTIONS.map((s) => <SectionCard key={s.id} section={s} state={state} onSave={save} />)}
      <div><Button variant="ghost" size="sm" onClick={reload}>Reload from disk</Button></div>
    </div>
  );
}

export const page = { id: "settings-config", path: "/settings/config", title: "Configuration", component: ConfigSettings, inSettings: true };
