import { Clock, Repeat, Zap, DollarSign } from 'lucide-react';
import type { StatusResponse } from '../types/api';

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

interface MetricProps {
  icon: React.ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
  label: string;
  value: string;
  /** Shown under the value. Use it to say why a value is absent. */
  note?: string;
  muted?: boolean;
}

function Metric({ icon: Icon, label, value, note, muted }: MetricProps) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1.5 text-small uppercase tracking-wide text-muted-accessible dark:text-dark-muted">
        <Icon size={13} aria-hidden={true} />
        {label}
      </dt>
      <dd
        className={[
          'mt-1 font-mono text-h3 tabular-nums',
          muted
            ? 'text-muted-accessible dark:text-dark-muted'
            : 'text-ink dark:text-dark-ink',
        ].join(' ')}
      >
        {value}
      </dd>
      {note && (
        <p className="mt-0.5 text-small text-muted-accessible dark:text-dark-muted">
          {note}
        </p>
      )}
    </div>
  );
}

interface Props {
  status: StatusResponse | null;
  isLive: boolean;
  elapsedSeconds: number | null;
  timeToFirstSignal: number | null;
}

export function RunMetrics({ status, isLive, elapsedSeconds, timeToFirstSignal }: Props) {
  const iteration = status?.iteration ?? 0;
  const cost = status?.cost ?? 0;

  return (
    <section aria-label="Run metrics" className="p-4 sm:p-5">
      <h2 className="text-small uppercase tracking-wide text-muted-accessible dark:text-dark-muted">
        Metrics
      </h2>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-4 lg:grid-cols-2">
        <Metric
          icon={Clock}
          label="Elapsed"
          value={elapsedSeconds !== null ? formatDuration(elapsedSeconds) : '--'}
          note={isLive ? undefined : 'Only measured while a run is live'}
          muted={elapsedSeconds === null}
        />
        <Metric
          icon={Zap}
          label="First signal"
          value={timeToFirstSignal !== null ? formatDuration(timeToFirstSignal) : '--'}
          // No endpoint serves an authoritative first-result timestamp, so this
          // is only ever what THIS page load witnessed. Saying so is the
          // difference between a measurement and a guess.
          note={
            timeToFirstSignal !== null
              ? 'Observed since this view opened'
              : isLive
                ? 'Not yet observed in this view'
                : 'Not recorded'
          }
          muted={timeToFirstSignal === null}
        />
        <Metric
          icon={Repeat}
          label="Iteration"
          value={isLive && iteration > 0 ? String(iteration) : '--'}
          note={isLive && iteration > 0 ? undefined : 'Not reported'}
          muted={!isLive || iteration <= 0}
        />
        <Metric
          icon={DollarSign}
          label="Cost"
          value={cost > 0 ? `$${cost.toFixed(2)}` : '--'}
          // A zero here means "the state file had no cost field", not "this run
          // was free". Rendering $0.00 would assert something we did not read.
          note={cost > 0 ? undefined : 'Not recorded'}
          muted={cost <= 0}
        />
      </dl>
    </section>
  );
}
