import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Keyboard } from 'lucide-react';
import { Skeleton } from '../components/ui/Skeleton';
import { TaskHeader } from './TaskHeader';
import { PhaseTimeline } from './PhaseTimeline';
import { RunMetrics } from './RunMetrics';
import { ChangeReview } from './ChangeReview';
import { EvidencePanel } from './EvidencePanel';
import { RiskPanel } from './RiskPanel';
import { FinalActions } from './FinalActions';
import { AgentChatter } from './AgentChatter';
import { StatusBanner, LastOutput } from './StatusBanner';
import { useCockpitState } from './useCockpitState';

const SHORTCUTS: { keys: string; action: string; id: string }[] = [
  { keys: 'g then 1', action: 'Go to progress', id: 'region-progress' },
  { keys: 'g then 2', action: 'Go to changes', id: 'region-changes' },
  { keys: 'g then 3', action: 'Go to evidence', id: 'region-evidence' },
  { keys: 'g then 4', action: 'Go to actions', id: 'region-actions' },
  { keys: '?', action: 'Toggle this list', id: '' },
  { keys: 'Esc', action: 'Close this list', id: '' },
];

const panel =
  'rounded-card border border-border bg-card shadow-card dark:border-dark-border dark:bg-dark-card';

interface Props {
  sessionId: string;
  onClose: () => void;
}

export function ExecutionCockpit({ sessionId, onClose }: Props) {
  const s = useCockpitState(sessionId);
  const [showKeys, setShowKeys] = useState(false);
  const pendingG = useRef(false);

  // Keyboard map. Ignored while typing so `g` in a PR title does not navigate.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el?.isContentEditable;
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === 'Escape') {
        setShowKeys(false);
        pendingG.current = false;
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        setShowKeys((v) => !v);
        return;
      }
      if (e.key === 'g') {
        pendingG.current = true;
        return;
      }
      if (pendingG.current) {
        pendingG.current = false;
        const target = SHORTCUTS.find((sc) => sc.keys === `g then ${e.key}`);
        if (target?.id) {
          const node = document.getElementById(target.id);
          if (node) {
            e.preventDefault();
            node.scrollIntoView({ behavior: 'smooth', block: 'start' });
            node.focus({ preventScroll: true });
          }
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (s.error) {
    return (
      <div className="flex h-full items-center justify-center bg-background p-6 dark:bg-dark-bg">
        <div className="text-center">
          <p className="text-caption font-semibold text-danger">
            Could not load this session
          </p>
          <p className="mt-1 text-small text-muted-accessible dark:text-dark-muted">
            {s.error}
          </p>
          <button
            type="button"
            onClick={s.reload}
            className="mt-4 rounded-btn border border-primary/30 px-4 py-2 text-caption font-semibold text-primary hover:bg-primary/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (s.view === 'loading') {
    return (
      <div className="h-full overflow-y-auto bg-background p-4 dark:bg-dark-bg sm:p-6">
        <span className="sr-only" role="status">
          Loading the execution cockpit
        </span>
        <Skeleton variant="block" width="60%" height="32px" />
        <div className="mt-3 flex gap-3">
          <Skeleton variant="text" width="140px" height="12px" />
          <Skeleton variant="text" width="180px" height="12px" />
        </div>
        <div className="mt-6 grid gap-4 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          <Skeleton variant="block" width="100%" height="260px" />
          <Skeleton variant="block" width="100%" height="260px" />
        </div>
      </div>
    );
  }

  const empty = s.view === 'empty';

  return (
    <div className="flex h-full flex-col bg-background dark:bg-dark-bg">
      <nav
        aria-label="Cockpit"
        className="flex items-center justify-between gap-2 border-b border-border bg-card px-4 py-2 dark:border-dark-border dark:bg-dark-card sm:px-6"
      >
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-1.5 rounded-btn px-2 py-1 text-small font-semibold text-secondary transition-colors hover:bg-hover dark:text-dark-ink dark:hover:bg-dark-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          Back
        </button>
        <button
          type="button"
          onClick={() => setShowKeys((v) => !v)}
          aria-expanded={showKeys}
          className="inline-flex items-center gap-1.5 rounded-btn px-2 py-1 text-small text-muted-accessible transition-colors hover:bg-hover dark:text-dark-muted dark:hover:bg-dark-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <Keyboard size={14} aria-hidden="true" />
          Shortcuts
        </button>
      </nav>

      {showKeys && (
        <div className="border-b border-border bg-hover px-4 py-3 dark:border-dark-border dark:bg-dark-hover sm:px-6">
          <dl className="flex flex-wrap gap-x-6 gap-y-1">
            {SHORTCUTS.map((sc) => (
              <div key={sc.keys} className="flex items-center gap-2">
                <dt>
                  <kbd className="rounded-btn border border-border bg-card px-1.5 py-0.5 font-mono text-xs text-ink dark:border-dark-border dark:bg-dark-card dark:text-dark-ink">
                    {sc.keys}
                  </kbd>
                </dt>
                <dd className="text-small text-muted-accessible dark:text-dark-muted">
                  {sc.action}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <StatusBanner
        view={s.view}
        status={s.status}
        dataAgeMs={s.dataAgeMs}
        stale={s.stale}
      />
      {s.view === 'failed' && <LastOutput status={s.status} />}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <TaskHeader
          detail={s.detail}
          status={s.status}
          git={s.git}
          isLive={s.isLive}
        />

        {empty ? (
          <div className="p-6">
            <div className={`${panel} p-6 text-center`}>
              <h2 className="font-heading text-h3 text-ink dark:text-dark-ink">
                Nothing recorded yet
              </h2>
              <p className="mx-auto mt-2 max-w-md text-caption text-muted-accessible dark:text-dark-muted">
                This session has no spec, no files and no changes. Once a run
                starts, its phases, changed files and evidence appear here.
              </p>
            </div>
          </div>
        ) : (
          <main className="grid gap-4 p-4 sm:p-6 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] xl:items-start">
            {/* Left rail on desktop, stacked first on mobile: where it is, and
                how long it has taken. */}
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-1">
              <div id="region-progress" tabIndex={-1} className={panel}>
                <PhaseTimeline
                  phase={s.phase}
                  view={s.view}
                  isLive={s.isLive}
                  iteration={s.status?.iteration}
                />
              </div>
              <div className={panel}>
                <RunMetrics
                  status={s.status}
                  isLive={s.isLive}
                  elapsedSeconds={s.elapsedSeconds}
                  timeToFirstSignal={s.timeToFirstSignal}
                />
              </div>
              <div className={`${panel} md:col-span-2 xl:col-span-1`}>
                <RiskPanel
                  sessionId={sessionId}
                  checkpoints={s.checkpoints}
                  changedFiles={s.changedFiles}
                  checklist={s.checklist}
                  isLive={s.isLive}
                  onRestored={s.reload}
                />
              </div>
            </div>

            {/* Main review surface. */}
            <div className="grid min-w-0 gap-4">
              <div id="region-changes" tabIndex={-1} className={`${panel} min-w-0`}>
                <ChangeReview
                  sessionId={sessionId}
                  files={s.changedFiles}
                  clean={s.git?.clean ?? s.changedFiles.length === 0}
                />
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <div id="region-evidence" tabIndex={-1} className={`${panel} min-w-0`}>
                  <EvidencePanel sessionId={sessionId} checklist={s.checklist} />
                </div>
                <div id="region-actions" tabIndex={-1} className={`${panel} min-w-0`}>
                  <FinalActions
                    sessionId={sessionId}
                    isLive={s.isLive}
                    status={s.status}
                    git={s.git}
                    changedFiles={s.changedFiles}
                    onChanged={s.reload}
                  />
                </div>
              </div>
            </div>
          </main>
        )}
      </div>

      <AgentChatter logs={s.logs} isLive={s.isLive} />
    </div>
  );
}
