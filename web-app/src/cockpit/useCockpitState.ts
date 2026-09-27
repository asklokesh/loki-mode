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
  | 'unknown'
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
  /** Set only when the checklist fetch itself failed; null on a genuine empty result. */
  checklistError: string | null;
  changedFiles: ChangedFile[];
  git: GitStatus | null;
  /** Set only when the git-status fetch itself failed; null on a genuine empty result. */
  gitError: string | null;
  checkpoints: Checkpoint[];
  /** Set only when the checkpoints fetch itself failed; null on a genuine empty result. */
  checkpointsError: string | null;
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

/**
 * /api/session/checklist has no per-session scoping -- it always reads the
 * globally running project. Showing it for a historical (non-live) session
 * would attribute another run's checklist to this one, so only surface it
 * while this session IS the live one.
 */
export function scopeChecklistToLive<T>(checklist: T | null, isLive: boolean): T | null {
  return isLive ? checklist : null;
}

/**
 * View state for a session that is NOT the live one (isLive === false).
 * Pure so it is directly testable without rendering the hook: see
 * useCockpitState.derive-view.test.ts.
 */
export function deriveHistoricalView(detail: {
  status?: string | null;
  prd?: string | null;
  files?: unknown[] | null;
} | null, hasChanges: boolean): ViewState {
  const s = (detail?.status ?? '').toLowerCase();
  if (s === 'failed') return 'failed';
  if (s === 'paused') return 'paused';
  if (s === 'completed') return 'completed';
  if (s === 'unknown') return 'unknown';
  // "Empty" is a real state: a session directory with no spec and no changes
  // has genuinely nothing to review.
  const hasPrd = Boolean(detail?.prd?.trim());
  const hasFiles = (detail?.files?.length ?? 0) > 0;
  if (!hasPrd && !hasChanges && !hasFiles) return 'empty';
  // The server could not determine a definitive status (e.g. an
  // unrecognized or missing status string) -- report that honestly rather
  // than assuming the run completed.
  return 'unknown';
}

/**
 * Await a fetch, splitting a genuine result from a genuine failure instead of
 * collapsing both into the same empty value. Pure/awaitable so the actual
 * catch-and-message wiring is testable without rendering the hook: see
 * useCockpitState.derive-view.test.mjs.
 */
export async function settle<T>(
  promise: Promise<T>,
  fallback: T,
  fallbackMessage: string,
): Promise<{ data: T; error: string | null }> {
  try {
    return { data: await promise, error: null };
  } catch (e) {
    return {
      data: fallback,
      error: e instanceof Error ? e.message : fallbackMessage,
    };
  }
}

/**
 * Which empty-state copy ChangeReview should show, if any. A failed fetch and
 * a genuinely clean tree both leave `files` empty, but they are not the same
 * fact and must not render the same sentence. Pure so it is directly testable:
 * see useCockpitState.derive-view.test.mjs.
 */
export function changeReviewEmptyState(
  filesLength: number,
  clean: boolean,
  gitError: string | null | undefined,
): 'error' | 'clean' | null {
  if (filesLength > 0) return null;
  if (gitError) return 'error';
  if (clean) return 'clean';
  return null;
}

export function useCockpitState(sessionId: string | undefined): CockpitState {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [status, setStatus] = useState<StatusWithExit | null>(null);
  const [checklist, setChecklist] = useState<ChecklistSummary | null>(null);
  const [checklistError, setChecklistError] = useState<string | null>(null);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [gitError, setGitError] = useState<string | null>(null);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [checkpointsError, setCheckpointsError] = useState<string | null>(null);
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

  // Initial + reload fetch. Session detail is required; the rest is
  // best-effort, but "best-effort" only excuses a genuinely empty result --
  // not a failed request. The server's git-status and checkpoints endpoints
  // both return 200 with an empty result for "no git repo" / "no checkpoints
  // dir" (web-app/server.py git_status / _list_checkpoints); they reject only
  // on a real failure (session not found, a git subprocess error, etc.), so
  // any caught rejection here IS a fetch failure, tracked separately below
  // instead of being silently swallowed into the same empty state.
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

    settle(api.getChecklist(), null, 'request failed').then(
      ({ data, error: clErr }) => {
        if (cancelled) return;
        setChecklist(data);
        setChecklistError(clErr);
      },
    );

    settle(api.git.status(sessionId), null, 'Could not load working tree status').then(
      ({ data, error: gErr }) => {
        if (cancelled) return;
        setGit(data);
        setGitError(gErr);
      },
    );
    settle(api.getCheckpoints(sessionId), [] as Checkpoint[], 'Could not load checkpoints').then(
      ({ data, error: cErr }) => {
        if (cancelled) return;
        setCheckpoints(data);
        setCheckpointsError(cErr);
      },
    );

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
    return deriveHistoricalView(detail, (git?.files?.length ?? 0) > 0);
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
    checklist: scopeChecklistToLive(checklist, isLive),
    checklistError: scopeChecklistToLive(checklistError, isLive),
    changedFiles,
    git,
    gitError,
    checkpoints,
    checkpointsError,
    logs,
    elapsedSeconds,
    timeToFirstSignal,
    dataAgeMs,
    stale: isLive && !connected,
    error,
    reload,
  };
}
