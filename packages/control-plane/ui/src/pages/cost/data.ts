// CPE-13 data: GET /v1/stats/cost. measured = all sessions priced; partial = only some; unmeasured = none (never summed as 0).
import { authToken } from "../../api";

export type Dim = "day" | "model" | "repo" | "provider";
export interface CostRow {
  day?: string; model?: string; repo?: string; provider?: string;
  runs: number; measured_runs: number; partial_runs: number; unmeasured_runs: number;
  measured_usd: number; partial_usd: number; input_tokens: number; output_tokens: number;
  token_sessions?: number; token_sessions_total?: number; // present only when some session carried no usage
}
export interface CostResponse {
  group: Dim[]; since: string | null; rows: CostRow[];
  totals: Omit<CostRow, Dim>;
  budget: { api_key_default_cap_usd: number; subscription_cap: null; api_key_runs: number; subscription_runs: number };
}

export async function getCost(group: Dim): Promise<CostResponse> {
  const base = (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE ?? "";
  const t = authToken();
  const res = await fetch(`${base}/v1/stats/cost?group=${group}`, { headers: t ? { authorization: `Bearer ${t}` } : {} });
  if (!res.ok) throw new Error(`/v1/stats/cost: HTTP ${res.status}`);
  return (await res.json()) as CostResponse;
}
