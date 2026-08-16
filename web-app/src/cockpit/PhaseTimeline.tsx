import { Check, CircleDashed, CircleDot, AlertTriangle, Pause } from 'lucide-react';
import {
  PHASE_HINT,
  PHASE_LABEL,
  TIMELINE,
  timelineIndex,
  type DisplayPhase,
  type MappedPhase,
} from './phases';
import type { ViewState } from './useCockpitState';

interface Props {
  phase: MappedPhase;
  view: ViewState;
  isLive: boolean;
  iteration?: number;
}

type StepState = 'done' | 'active' | 'ahead';

function StepIcon({ state, view }: { state: StepState; view: ViewState }) {
  if (state === 'active') {
    if (view === 'paused') return <Pause size={16} aria-hidden="true" />;
    if (view === 'failed') return <AlertTriangle size={16} aria-hidden="true" />;
    return (
      <span className="relative flex h-4 w-4 items-center justify-center">
        {view === 'running' && (
          <span className="absolute inline-flex h-4 w-4 animate-ping rounded-full bg-current opacity-40 motion-reduce:hidden" />
        )}
        <CircleDot size={16} aria-hidden="true" className="relative" />
      </span>
    );
  }
  if (state === 'done') return <Check size={16} aria-hidden="true" />;
  return <CircleDashed size={16} aria-hidden="true" />;
}

export function PhaseTimeline({ phase, view, isLive, iteration }: Props) {
  const activeIndex = timelineIndex(phase.display);
  const terminal = phase.display === 'failed' || phase.display === 'pr-ready';

  function stateOf(step: DisplayPhase, index: number): StepState {
    if (index === activeIndex) return 'active';
    // On a finished run the earlier steps genuinely happened. On a live run
    // they may not have: RARV cycles (iteration % 4), so being in "testing"
    // now says nothing about whether "review" already ran. Marking them done
    // would be a claim we cannot support.
    if (phase.display === 'pr-ready') return 'done';
    if (isLive && index < activeIndex) return 'ahead';
    if (!isLive && activeIndex >= 0 && index < activeIndex) return 'done';
    return 'ahead';
  }

  return (
    <section aria-label="Phase timeline" className="p-4 sm:p-5">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-small uppercase tracking-wide text-muted-accessible dark:text-dark-muted">
          Progress
        </h2>
        {!isLive && (
          <span className="text-small text-muted-accessible dark:text-dark-muted">
            Historical
          </span>
        )}
      </div>

      {/* Screen readers get the phase change as a single polite announcement
          rather than a re-read of the whole list on every 2s push. */}
      <p aria-live="polite" className="sr-only">
        {`Phase: ${PHASE_LABEL[phase.display]}`}
      </p>

      <ol className="mt-3 space-y-0.5">
        {TIMELINE.map((step, i) => {
          const state = stateOf(step, i);
          const isActive = state === 'active';
          return (
            <li
              key={step}
              aria-current={isActive ? 'step' : undefined}
              className={[
                'flex gap-3 rounded-btn px-2 py-2 transition-colors motion-reduce:transition-none',
                isActive ? 'bg-primary/5 dark:bg-primary/10' : '',
              ].join(' ')}
            >
              <span
                className={[
                  'mt-0.5 shrink-0',
                  isActive && view === 'failed'
                    ? 'text-danger'
                    : isActive
                      ? 'text-primary'
                      : state === 'done'
                        ? 'text-success'
                        : 'text-muted-accessible dark:text-dark-muted',
                ].join(' ')}
              >
                <StepIcon state={state} view={view} />
              </span>
              <span className="min-w-0">
                <span
                  className={[
                    'block text-caption',
                    isActive
                      ? 'font-semibold text-ink dark:text-dark-ink'
                      : state === 'done'
                        ? 'text-secondary dark:text-dark-ink'
                        : 'text-muted-accessible dark:text-dark-muted',
                  ].join(' ')}
                >
                  {PHASE_LABEL[step]}
                </span>
                {isActive && (
                  <span className="mt-0.5 block text-small text-muted-accessible dark:text-dark-muted">
                    {PHASE_HINT[step]}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>

      {phase.display === 'failed' && (
        <p className="mt-2 rounded-btn bg-danger/10 px-2 py-2 text-caption text-danger">
          {PHASE_HINT.failed}
        </p>
      )}

      {!phase.recognised && (
        <p className="mt-2 rounded-btn bg-warning/10 px-2 py-2 text-caption text-ink dark:text-dark-ink">
          The engine reported phase{' '}
          <code className="font-mono font-semibold">{phase.raw}</code>, which this
          view does not recognise. Shown verbatim rather than guessed at.
        </p>
      )}

      {isLive && !terminal && typeof iteration === 'number' && iteration > 0 && (
        <p className="mt-3 text-small text-muted-accessible dark:text-dark-muted">
          Iteration {iteration}. Phases repeat each iteration, so this is a cycle,
          not a countdown.
        </p>
      )}
    </section>
  );
}
