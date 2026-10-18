// One loader for the issue-centric pages: every run (paged), refreshed on the runs-list SSE.
import { useCallback, useEffect, useState } from "react";
import { authToken, watchRuns, type RunRow, type RunsResponse } from "../../api";

const base = (): string => (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE ?? "";
const MAX_PAGES = 10;

export async function fetchAllRuns(): Promise<RunRow[]> {
  const out: RunRow[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const t = authToken();
    const q = new URLSearchParams({ limit: "200" });
    if (cursor) q.set("cursor", cursor);
    const res = await fetch(`${base()}/v1/runs?${q}`, { headers: t ? { authorization: `Bearer ${t}` } : {} });
    if (!res.ok) throw new Error(`/v1/runs: HTTP ${res.status}`);
    const j = (await res.json()) as RunsResponse;
    out.push(...j.runs);
    cursor = j.next_cursor;
    if (!cursor) break;
  }
  return out;
}

export function useAllRuns(live = true): { runs: RunRow[] | null; error: string | null } {
  const [s, set] = useState<{ runs: RunRow[] | null; error: string | null }>({ runs: null, error: null });
  const load = useCallback(() => {
    fetchAllRuns().then((runs) => set({ runs, error: null }), (e: Error) => set((p) => ({ runs: p.runs, error: e.message })));
  }, []);
  useEffect(() => {
    load();
    return live ? watchRuns(load) : undefined;
  }, [load, live]);
  return s;
}
