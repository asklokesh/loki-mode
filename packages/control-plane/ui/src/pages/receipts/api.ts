// Receipts page data: the run list comes from the shared api, verify and key from the CPE-16 routes.
import { authToken } from "../../api";
import { isVerified } from "../../design/primitives";

export interface VerifyResult { run: string; verdict: "VERIFIED" | "NOT_VERIFIED" | "UNSIGNED" | "TAMPERED" | "UNCHECKED"; integrity?: string; outcome?: string; reasons: string[]; receipt_sha256: string | null; verified_at: string }
export interface PublicKey { kty: string; crv: string; x: string; kid: string; alg: string; use: string }

const base = (): string => (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE ?? "";
const headers = (extra: Record<string, string> = {}): Record<string, string> => {
  const t = authToken();
  return t ? { ...extra, authorization: `Bearer ${t}` } : extra;
};

export async function verifyRun(source: string, run: string): Promise<VerifyResult> {
  const res = await fetch(`${base()}/v1/runs/${encodeURIComponent(source)}/${encodeURIComponent(run)}/verify`, { method: "POST", headers: headers({ "content-type": "application/json" }), body: "{}" });
  const j = (await res.json().catch(() => ({}))) as Partial<VerifyResult> & { error?: string };
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j as VerifyResult;
}

/** null when the server has no signing key yet (404); any other failure throws. */
export async function getPublicKey(): Promise<PublicKey | null> {
  const res = await fetch(`${base()}/v1/keys`, { headers: headers() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`/v1/keys: HTTP ${res.status}`);
  return (await res.json()) as PublicKey;
}

/** Verified rate per UTC day over finished runs (verdict set). Days with no finished run are absent, never zero. */
export function verifiedTrend(rows: Array<{ started_at: string | null; verdict: string | null; tampered?: boolean }>): Array<{ day: string; rate: number; total: number }> {
  const by = new Map<string, { v: number; n: number }>();
  for (const r of rows) {
    if (!r.verdict || !r.started_at) continue;
    const day = r.started_at.slice(0, 10), e = by.get(day) ?? { v: 0, n: 0 };
    e.n++;
    if (isVerified(r)) e.v++;
    by.set(day, e);
  }
  return [...by.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, e]) => ({ day, rate: e.v / e.n, total: e.n }));
}
