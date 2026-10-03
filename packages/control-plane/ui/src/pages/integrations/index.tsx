// CPE-20: Integrations. Real presence probes from GET /v1/integrations. Connect writes only an env var NAME through the CPE-14
// config flow (GET for the etag, PUT with If-Match); no second writer, no secret value anywhere.
import { useCallback, useEffect, useState } from "react";
import { authToken } from "../../api";
import { Badge, Button, Card, EmptyState, Input, Spinner } from "../../design/primitives";
import { ConfigError, loadConfig, saveConfig, type ConfigObject } from "../settings/config-api";

export interface IntegrationRow {
  id: string; label: string; status: "connected" | "not_connected" | "not_measured"; method: string;
  env_name: string | null; env_set: boolean; config_path: string | null; detail: string;
}

const base = (): string => (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE ?? "";
async function fetchIntegrations(): Promise<IntegrationRow[]> {
  const tok = authToken();
  const res = await fetch(`${base()}/v1/integrations`, { headers: tok ? { authorization: `Bearer ${tok}` } : {} });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()) as { integrations: IntegrationRow[] }).integrations;
}

const isObj = (v: unknown): v is ConfigObject => typeof v === "object" && v !== null && !Array.isArray(v);
function withPath(c: ConfigObject, path: string[], v: string): ConfigObject {
  const [k, ...rest] = path;
  if (k === undefined) return c;
  return { ...c, [k]: rest.length ? withPath(isObj(c[k]) ? (c[k] as ConfigObject) : {}, rest, v) : v };
}

const TONE = { connected: "success", not_connected: "neutral", not_measured: "neutral" } as const;
const LABEL = { connected: "connected", not_connected: "not connected", not_measured: "not measured" } as const;

function Row({ row, onChanged }: { row: IntegrationRow; onChanged: () => void }) {
  const [name, setName] = useState(row.env_name ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const valid = /^[A-Z_][A-Z0-9_]*$/.test(name);
  const connect = async () => {
    if (!row.config_path || !valid) return;
    setBusy(true); setMsg(null);
    try {
      const cur = await loadConfig();
      await saveConfig(withPath(cur.config, row.config_path.split("."), name), cur.etag);
      setMsg(`Saved ${name} to loki.yaml`);
      onChanged();
    } catch (e) { setMsg(e instanceof ConfigError ? [e.message, ...e.details].join(": ") : (e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <Card data-testid={`integration-${row.id}`}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
        <strong>{row.label}</strong>
        <Badge tone={TONE[row.status]}>{LABEL[row.status]}</Badge>
      </div>
      <p style={{ margin: "4px 0 8px", color: "var(--cp-text-2)", fontSize: "var(--cp-text-md)" }}>{row.detail}</p>
      {row.config_path ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Input aria-label={`${row.label} variable name`} value={name} placeholder="ENV_VAR_NAME" autoComplete="off" spellCheck={false}
            onChange={(e) => { setName(e.target.value.trim()); setMsg(null); }} style={{ fontFamily: "var(--cp-font-mono)" }} />
          <Button onClick={connect} disabled={busy || !valid || name === row.env_name}>{busy ? "Saving" : "Connect"}</Button>
        </div>
      ) : (
        <small style={{ color: "var(--cp-text-3)" }}>{row.id === "mcp" ? "Managed in .mcp.json." : "loki.yaml has no setting for this service yet."}</small>
      )}
      {row.config_path && name && !valid ? <small role="alert">Use an environment variable name such as GITHUB_TOKEN, never the secret itself.</small> : null}
      {msg ? <small role="status" style={{ display: "block", marginTop: 4 }}>{msg}</small> : null}
    </Card>
  );
}

export function IntegrationsPage() {
  const [rows, setRows] = useState<IntegrationRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => { fetchIntegrations().then(setRows).catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e))); }, []);
  useEffect(load, [load]);
  if (err) return <EmptyState title="Could not load integrations" hint={err} />;
  if (!rows) return <Spinner label="Probing integrations" />;
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <h1 style={{ margin: 0, fontSize: "var(--cp-text-xl, 20px)" }}>Integrations</h1>
      <small style={{ color: "var(--cp-text-3)" }}>Status shows whether an environment variable is set or a CLI is signed in, never its value. Connect stores the variable name in loki.yaml.</small>
      {rows.map((r) => <Row key={r.id} row={r} onChanged={load} />)}
    </div>
  );
}

export const page = { id: "integrations", path: "/integrations", title: "Integrations", component: IntegrationsPage, inSettings: true };
