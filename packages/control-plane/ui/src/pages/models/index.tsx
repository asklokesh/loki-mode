// CPE-15: Models and providers. Detected CLIs, auth presence (a yes/no from env var NAMES, never a value) and the model catalog.
import { useEffect, useState } from "react";
import { authToken } from "../../api";
import { Badge, Card, EmptyState, Spinner, StatusDot, Table } from "../../design/primitives";

export interface ProviderRow {
  id: string;
  deprecated: boolean;
  installed: boolean;
  version: string | null;
  probe: "ok" | "timeout" | "error" | "not_found";
  auth_env_names: string[];
  auth_env_set: string[];
  auth_present: boolean;
  tiers: Record<string, string | null>;
  models: Array<{ id: string; alias: string | null; tier: string | null }>;
}
export interface ProvidersResponse { providers: ProviderRow[]; catalog_updated: string | null; probe_timeout_ms: number }

async function fetchProviders(): Promise<ProvidersResponse> {
  const base = (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE ?? "";
  const tok = authToken();
  const res = await fetch(`${base}/v1/providers`, { headers: tok ? { authorization: `Bearer ${tok}` } : {} });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ProvidersResponse;
}

const cliCell = (p: ProviderRow) =>
  p.probe === "timeout" ? "installed, version probe timed out"
    : p.installed ? (p.version ? `installed, ${p.version}` : "installed, version not reported")
      : "not installed";

export function ModelsPage() {
  const [data, setData] = useState<ProvidersResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetchProviders().then((d) => live && setData(d)).catch((e: unknown) => live && setErr(e instanceof Error ? e.message : String(e)));
    return () => { live = false; };
  }, []);

  if (err) return <EmptyState title="Could not load providers" hint={err} />;
  if (!data) return <Spinner label="Detecting provider CLIs" />;

  const rows = data.providers.map((p) => [
    <span key="n" style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
      <StatusDot state={p.installed ? "active" : "idle"} label={p.installed ? "installed" : "not installed"} />
      <strong>{p.id}</strong>
      {p.deprecated ? <Badge tone="warning">deprecated</Badge> : null}
    </span>,
    cliCell(p),
    p.auth_present ? <Badge key="a" tone="success">auth present</Badge> : <Badge key="a" tone="neutral">no auth env set</Badge>,
    p.auth_env_names.length ? `${p.auth_env_set.length ? p.auth_env_set.join(", ") : "none"} (of ${p.auth_env_names.join(", ")})` : "not measured",
    p.tiers.planning ?? "not measured",
    p.tiers.development ?? "not measured",
    p.tiers.fast ?? "not measured",
  ]);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <h1 style={{ margin: 0, fontSize: "var(--cp-text-xl, 20px)" }}>Models and providers</h1>
      <Table caption="Provider CLIs" columns={["Provider", "CLI", "Auth", "Env vars set", "Planning", "Development", "Fast"]} rows={rows} />
      <Card compact>
        <small>
          Auth shows only whether an environment variable is set, never its value. Model tiers come from the catalog
          {data.catalog_updated ? ` (updated ${data.catalog_updated})` : ""}. Version probes stop after {data.probe_timeout_ms} ms.
        </small>
      </Card>
    </div>
  );
}

export const page = { id: "models", path: "/models", title: "Models and providers", component: ModelsPage, inSettings: true };
