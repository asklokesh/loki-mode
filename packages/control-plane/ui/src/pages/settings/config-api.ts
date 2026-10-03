// CPE-14: client for GET and PUT /v1/config. The server owns validation; this only carries the ETag and the error detail back.
import { authToken } from "../../api";

export type ConfigObject = Record<string, unknown>;
export interface ConfigState { exists: boolean; etag: string; config: ConfigObject; errors: string[] }

const base = (): string => (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE ?? "";
const headers = (extra: Record<string, string> = {}): Record<string, string> => {
  const t = authToken();
  return t ? { ...extra, authorization: `Bearer ${t}` } : extra;
};

export class ConfigError extends Error {
  constructor(message: string, readonly status: number, readonly details: string[]) { super(message); }
}

export async function loadConfig(): Promise<ConfigState> {
  const res = await fetch(`${base()}/v1/config`, { headers: headers() });
  const j = (await res.json().catch(() => ({}))) as Partial<ConfigState> & { error?: string };
  if (!res.ok) throw new ConfigError(j.error ?? `HTTP ${res.status}`, res.status, []);
  return { exists: !!j.exists, etag: j.etag ?? "", config: (j.config ?? {}) as ConfigObject, errors: j.errors ?? [] };
}

export async function saveConfig(config: ConfigObject, etag: string): Promise<{ etag: string; config: ConfigObject }> {
  const res = await fetch(`${base()}/v1/config`, { method: "PUT", headers: headers({ "content-type": "application/json", "if-match": etag }), body: JSON.stringify({ config }) });
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; etag?: string; config?: ConfigObject; error?: string; errors?: string[]; paths?: string[] };
  if (!res.ok) throw new ConfigError(j.error ?? `HTTP ${res.status}`, res.status, j.errors ?? (j.paths ? j.paths.map((p) => `${p}: looks like a secret`) : []));
  return { etag: j.etag ?? etag, config: j.config ?? config };
}
