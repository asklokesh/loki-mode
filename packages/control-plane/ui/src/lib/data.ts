// One place that loads what every page needs (the workspace and the runs) and keeps it fresh from the server's event stream.
import { useCallback, useEffect, useRef, useState } from "react";
import { getWorkspace, listRuns, watchRuns, type RunRow, type Workspace } from "../api";

export interface Data { ws: Workspace | null; runs: RunRow[]; error: string | null; loading: boolean; reload: () => void; setWs: (w: Workspace) => void }

export function useData(): Data {
  const [ws, setWs] = useState<Workspace | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const busy = useRef(false);
  const reload = useCallback((): void => {
    if (busy.current) return;
    busy.current = true;
    Promise.all([getWorkspace(), listRuns()])
      .then(([w, r]) => { setWs(w); setRuns(r.runs); setError(null); })
      .catch((e: Error) => setError(e.message))
      .finally(() => { busy.current = false; setLoading(false); });
  }, []);
  useEffect(() => {
    reload();
    const stop = watchRuns(reload);
    const t = setInterval(reload, 15000);
    return () => { stop(); clearInterval(t); };
  }, [reload]);
  return { ws, runs, error, loading, reload, setWs };
}

/** A value that reloads on a timer while `live` is true (a run still working), and once when its key changes. */
export function usePolled<T>(load: () => Promise<T>, key: string, live: boolean, ms = 3000): { value: T | null; error: string | null; reload: () => void } {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fn = useRef(load);
  fn.current = load;
  const reload = useCallback((): void => {
    fn.current().then((v) => { setValue(v); setError(null); }).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => { setValue(null); reload(); }, [key, reload]);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(reload, ms);
    return () => clearInterval(t);
  }, [live, ms, reload]);
  return { value, error, reload };
}
