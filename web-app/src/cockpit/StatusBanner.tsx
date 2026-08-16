import { AlertTriangle, Loader2, Pause, WifiOff, CheckCircle2 } from 'lucide-react';
import type { StatusResponse } from '../types/api';
import type { ViewState } from './useCockpitState';

interface Props {
  view: ViewState;
  status: StatusResponse | null;
  dataAgeMs: number | null;
  /** Socket down. Annotates the run state rather than replacing it. */
  stale?: boolean;
}

const TONE = {
  neutral: 'bg-hover text-secondary dark:bg-dark-hover dark:text-dark-ink',
  running: 'bg-primary/10 text-primary',
  warning: 'bg-warning/10 text-ink dark:text-dark-ink',
  danger: 'bg-danger/10 text-danger',
  success: 'bg-success/10 text-success',
} as const;

export function StatusBanner({ view, status, dataAgeMs, stale }: Props) {
  const exit = status?.exit_code;
  const staleSeconds = dataAgeMs !== null ? Math.round(dataAgeMs / 1000) : null;

  const spec: {
    tone: keyof typeof TONE;
    Icon: React.ComponentType<{ size?: number; className?: string }>;
    text: string;
    detail?: string;
    spin?: boolean;
  } | null = (() => {
    switch (view) {
      case 'running':
        return {
          tone: 'running',
          Icon: Loader2,
          spin: true,
          text: 'Running',
          detail: status?.current_task || undefined,
        };
      case 'paused':
        return { tone: 'warning', Icon: Pause, text: 'Paused', detail: 'Resume to continue.' };
      case 'recovering':
        return {
          tone: 'warning',
          Icon: Loader2,
          spin: true,
          text: 'Starting up',
          // The server's own placeholder for "process alive, nothing written
          // yet". Reporting it as progress would overstate what happened.
          detail: 'The process is alive but has not written any state yet.',
        };
      case 'failed':
        return {
          tone: 'danger',
          Icon: AlertTriangle,
          text: 'Run failed',
          detail:
            typeof exit === 'number' ? `Process exited with code ${exit}.` : undefined,
        };
      case 'completed':
        return { tone: 'success', Icon: CheckCircle2, text: 'Run finished' };
      case 'disconnected':
        return {
          tone: 'warning',
          Icon: WifiOff,
          text: 'Disconnected',
          detail:
            staleSeconds !== null
              ? `Showing the last state received ${staleSeconds}s ago. Reconnecting.`
              : 'Showing the last state received. Reconnecting.',
        };
      default:
        return null;
    }
  })();

  if (!spec) return null;
  const { Icon } = spec;
  // Shown for a paused/failed/recovering run whose socket has dropped: the run
  // state is still true, but the numbers beside it may have stopped updating.
  const showStale = stale && view !== 'disconnected';

  return (
    <>
      <div
        role="status"
        className={`flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 sm:px-6 ${TONE[spec.tone]}`}
      >
        <Icon
          size={14}
          className={spec.spin ? 'animate-spin motion-reduce:animate-none' : undefined}
        />
        <span className="text-caption font-semibold">{spec.text}</span>
        {spec.detail && <span className="text-caption opacity-80">{spec.detail}</span>}
      </div>
      {showStale && (
        <div
          className={`flex flex-wrap items-center gap-x-2 px-4 py-1.5 sm:px-6 ${TONE.warning}`}
        >
          <WifiOff size={13} aria-hidden="true" />
          <span className="text-small">
            Live updates disconnected
            {staleSeconds !== null
              ? `; this is the state from ${staleSeconds}s ago.`
              : '.'}{' '}
            Reconnecting.
          </span>
        </div>
      )}
    </>
  );
}

export function LastOutput({ status }: { status: StatusResponse | null }) {
  const lines = status?.last_output ?? [];
  if (lines.length === 0) return null;
  return (
    <details className="border-b border-border px-4 py-2 dark:border-dark-border sm:px-6">
      <summary className="cursor-pointer text-small font-semibold text-danger">
        Last output before exit
      </summary>
      <pre className="mt-2 max-h-48 overflow-auto rounded-btn bg-hover p-2 font-mono text-xs text-secondary dark:bg-dark-hover dark:text-dark-ink">
        {lines.join('\n')}
      </pre>
    </details>
  );
}
