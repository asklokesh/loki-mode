import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, PurpleLabWebSocket } from '../api/client';
import type { SessionDetail } from '../api/client';
import type {
  Checkpoint,
  ChecklistSummary,
  GitStatus,
  StatusResponse,
} from '../types/api';
import { mapPhase, type MappedPhase } from './phases';
import { dedupeChangedFiles, isLiveBinding, type ChangedFile } from './derive';

export type { ChangedFile } from './derive';

export type ViewState =
  | 'loading'
  | 'empty'
  | 'running'
  | 'paused'
  | 'recovering'
  | 'failed'
  | 'completed'
  | 'disconnected';

/** Fields the server returns but types/api.ts historically did not declare. */
type StatusWithExit = StatusResponse & {
  exit_code?: number | null;
  last_output?: string[];
};

export interface CockpitState {
  view: ViewState;
  detail: SessionDetail | null;
  status: StatusResponse | null;
  /** True only when this session is the one currently running. */
  isLive: boolean;
  phase: MappedPhase;
  checklist: ChecklistSummary | null;
  changedFiles: ChangedFile[];
  git: GitStatus | null;
  checkpoints: Checkpoint[];
  logs: string[];
  /** Seconds. Live only; null in every historical view. */
  elapsedSeconds: number | null;
  /**
   * Seconds from mount to the first phase transition out of idle/starting,
   * observed CLIENT-SIDE. Null when this mount did not witness the transition
   * -- no endpoint serves an authoritative first-result timestamp.
   */
  timeToFirstSignal: number | null;
  /** Milliseconds since the last successful status push, when live. */
  dataAgeMs: number | null;
  /**
   * The live socket is down. Orthogonal to `view`: a paused or failed run stays
   * paused or failed while disconnected, but what is on screen may be stale.
   */
  stale: boolean;
  error: string | null;
  reload: () => void;
}

const NO_PHASE = mapPhase(null);

export function useCockpitState(sessionId: string | undefined): CockpitState {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [status, setStatus] = useState<StatusWithExit | null>(null);
  const [checklist, setChecklist] = useState<ChecklistSummary | null>(null);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [timeToFirstSignal, setTimeToFirstSignal] = useState<number | null>(null);

  // Wall-clock of the last status we received, so a frozen socket is visible
  // as data age instead of silently reading as live.
  const lastStatusAt = useRef<number | null>(null);
  const mountedAt = useRef<number>(Date.now());

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  // Initial + reload fetch. Session detail is required; everything else is
  // best-effort, because a session with no git repo or no checkpoints is a
  // legitimate state, not an error.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .getSessionDetail(sessionId)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        setLogs(d.logs ?? []);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to load session');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    api
      .getStatus()
      .then((s) => {
        if (cancelled) return;
        setStatus(s as StatusWithExit);
        lastStatusAt.current = Date.now();
      })
      .catch(() => undefined);

    api.getChecklist().then((c) => !cancelled && setChecklist(c)).catch(() => undefined);
    api.git.status(sessionId).then((g) => !cancelled && setGit(g)).catch(() => undefined);
    api
      .getCheckpoints(sessionId)
      .then((c) => !cancelled && setCheckpoints(c))
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [sessionId, reloadKey]);

  // Live socket. The server pushes state_update every 2s while running, 30s
  // while idle (server.py:6151).
  useEffect(() => {
    const ws = new PurpleLabWebSocket();
    const offState = ws.on('state_update', (data) => {
      const payload = data as {
        status?: StatusWithExit;
        logs?: { message: string }[];
      };
      if (payload?.status) {
        setStatus(payload.status);
        lastStatusAt.current = Date.now();
      }
      if (payload?.logs?.length) {
        setLogs((prev) => [...prev, ...payload.logs!.map((l) => l.message)].slice(-500));
      }
    });
    const offLog = ws.on('log', (data) => {
      const line = (data as { line?: string })?.line;
      if (line) setLogs((prev) => [...prev, line].slice(-500));
    });
    const offUp = ws.on('connected', () => setConnected(true));
    const offDown = ws.on('disconnected', () => setConnected(false));
    ws.connect();
    return () => {
      offState();
      offLog();
      offUp();
      offDown();
      ws.disconnect();
    };
  }, []);

  // Local clock so elapsed ticks between the server's 2s pushes. It is only
  // ever read while live, and every push snaps it back to server truth.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const isLive = isLiveBinding(status, detail);

  const phase = useMemo(() => {
    // A historical session has no live phase to report. Its final state comes
    // from SessionDetail.status, which is inferred from disk, not from the
    // running process.
    if (!isLive) return mapPhase(detail?.status);
    return mapPhase(status?.phase);
  }, [isLive, status?.phase, detail?.status]);

  // Time to first signal: the first transition out of not-started/understanding
  // seen by THIS mount. Deliberately not persisted -- claiming a number for a
  // run we only half-observed would be an invented fact.
  //
  // State, not a ref: the value must render the moment it is observed, and a
  // ref mutation does not re-render. It is written once and never revised.
  useEffect(() => {
    if (!isLive || timeToFirstSignal !== null) return;
    const raw = status?.phase ?? '';
    if (raw && raw !== 'idle' && raw !== 'starting' && raw !== 'BOOTSTRAP') {
      setTimeToFirstSignal(
        Math.max(0, Math.round((Date.now() - mountedAt.current) / 1000)),
      );
    }
  }, [isLive, status?.phase, timeToFirstSignal]);

  const view: ViewState = useMemo(() => {
    if (loading) return 'loading';
    if (isLive) {
      // Connection health is NOT a run state. A dropped socket must not erase
      // the fact that the run is paused or has failed -- it only means the
      // state on screen may be stale, which `stale` reports separately.
      if (status?.paused) return 'paused';
      const exit = status?.exit_code;
      if (typeof exit === 'number' && exit !== 0) return 'failed';
      if (status?.phase === 'starting') return 'recovering';
      if (!connected) return 'disconnected';
      return 'running';
    }
    const s = (detail?.status ?? '').toLowerCase();
    if (s === 'failed') return 'failed';
    if (s === 'completed') return 'completed';
    // "Empty" is a real state: a session directory with no spec and no changes
    // has genuinely nothing to review.
    const hasPrd = Boolean(detail?.prd?.trim());
    const hasChanges = (git?.files?.length ?? 0) > 0;
    const hasFiles = (detail?.files?.length ?? 0) > 0;
    if (!hasPrd && !hasChanges && !hasFiles) return 'empty';
    return 'completed';
  }, [loading, isLive, connected, status, detail, git]);

  const elapsedSeconds = useMemo(() => {
    if (!isLive || typeof status?.uptime !== 'number') return null;
    // uptime is server-computed at push time; add the local drift since.
    const drift = lastStatusAt.current ? (now - lastStatusAt.current) / 1000 : 0;
    return Math.max(0, Math.round(status.uptime + drift));
  }, [isLive, status?.uptime, now]);

  const dataAgeMs = useMemo(() => {
    if (!isLive || lastStatusAt.current === null) return null;
    return now - lastStatusAt.current;
  }, [isLive, now]);

  const changedFiles = useMemo(() => dedupeChangedFiles(git?.files), [git]);

  return {
    view,
    detail,
    status,
    isLive,
    phase: phase ?? NO_PHASE,
    checklist,
    changedFiles,
    git,
    checkpoints,
    logs,
    elapsedSeconds,
    timeToFirstSignal,
    dataAgeMs,
    stale: isLive && !connected,
    error,
    reload,
  };
}
