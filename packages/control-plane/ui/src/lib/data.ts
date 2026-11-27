// One place that loads the runs and the repositories and refreshes them when the server's event stream says a run changed. No timers.
import { useCallback, useEffect, useRef, useState } from "react";
import { getRunDetail, getWorkspace, listAllRuns, watchRuns, type RunRow } from "../api";
import { isRunning, runKey, repoName } from "./model";

export interface Data { runs: RunRow[]; repos: string[]; blocked: ReadonlySet<string>; error: string | null; loading: boolean; tick: number; reload: () => void }

export function useData(): Data {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [repos, setRepos] = useState<string[]>([]);
  const [blocked, setBlocked] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const busy = useRef(false), again = useRef(false);
  const reload = useCallback((): void => {
    if (busy.current) { again.current = true; return; }
    busy.current = true;
    void (async () => {
      try {
        const [r, w] = await Promise.all([listAllRuns(), getWorkspace().catch(() => ({ repos: [] as string[] }))]);
        // A running run holds a question for the person only in its detail; look at the few that are running.
        const live = r.runs.filter(isRunning).slice(0, 20);
        const asks = await Promise.all(live.map((x) => getRunDetail(x.source_id, x.run_id).then((d) => (d.blocked_question ? runKey(x) : null)).catch(() => null)));
        setRuns(r.runs); setRepos(w.repos); setBlocked(new Set(asks.filter((k): k is string => k !== null))); setError(null); setTick((t) => t + 1);
      } catch (e) { setError((e as Error).message); }
      finally { busy.current = false; setLoading(false); if (again.current) { again.current = false; reload(); } }
    })();
  }, []);
  useEffect(() => { reload(); return watchRuns(reload); }, [reload]);
  return { runs, repos, blocked, error, loading, tick, reload };
}

/** Repositories the runs name, for the sidebar filter; when no run names one, the checkouts the workspace knows. */
export function repoList(repos: string[], runs: RunRow[]): string[] {
  const s = new Set<string>();
  for (const r of runs) { const n = repoName(r); if (n !== "unknown") s.add(n); }
  return [...(s.size ? s : new Set(repos))].sort();
}
/** Repositories a new run can start in: the checkouts the workspace knows plus those the runs name. */
export const startableRepos = (repos: string[], runs: RunRow[]): string[] => [...new Set([...repos, ...runs.map(repoName).filter((n) => n !== "unknown")])].sort();

/** A set of run keys kept in localStorage (the runs the person dismissed from Needs you). Storage can be missing or blocked: then it lives for the page only. */
export function useSeen(): [ReadonlySet<string>, (k: string) => void] {
  const KEY = "loki-control-seen";
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => { try { return new Set<string>(JSON.parse(localStorage.getItem(KEY) ?? "[]") as string[]); } catch { return new Set(); } });
  const add = useCallback((k: string): void => {
    setSeen((p) => { const n = new Set(p); n.add(k); try { localStorage.setItem(KEY, JSON.stringify([...n].slice(-500))); } catch { /* storage blocked */ } return n; });
  }, []);
  return [seen, add];
}

export type Theme = "light" | "dark" | null;
export function useTheme(): [Theme, () => void] {
  const KEY = "loki-control-theme";
  const [t, setT] = useState<Theme>(() => { try { const v = localStorage.getItem(KEY); return v === "light" || v === "dark" ? v : null; } catch { return null; } });
  useEffect(() => { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }, [t]);
  const toggle = useCallback((): void => {
    setT((p) => {
      const dark = p ? p === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
      const n: Theme = dark ? "light" : "dark";
      try { localStorage.setItem(KEY, n); } catch { /* storage blocked */ }
      return n;
    });
  }, []);
  return [t, toggle];
}
