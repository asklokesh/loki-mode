import { useState } from 'react';
import { AlertTriangle, History, Undo2 } from 'lucide-react';
import { api } from '../api/client';
import type { Checkpoint, ChecklistSummary } from '../types/api';
import type { ChangedFile } from './useCockpitState';

interface Props {
  sessionId: string;
  checkpoints: Checkpoint[];
  changedFiles: ChangedFile[];
  checklist: ChecklistSummary | null;
  isLive: boolean;
  onRestored: () => void;
}

/**
 * What we can honestly say about risk, from what we actually read. Every item
 * cites the observation behind it; nothing is a model's opinion.
 */
function riskSignals(
  changedFiles: ChangedFile[],
  checklist: ChecklistSummary | null,
  checkpoints: Checkpoint[],
): string[] {
  const out: string[] = [];
  const failed = checklist?.items.filter((i) => i.status === 'fail') ?? [];
  if (failed.length > 0) {
    out.push(`${failed.length} quality gate(s) failed: ${failed.map((f) => f.label).join(', ')}.`);
  }
  if (!checklist || checklist.items.length === 0) {
    out.push('No quality gate results were recorded, so nothing here is verified.');
  }
  const pending = checklist?.items.filter((i) => i.status === 'pending') ?? [];
  if (pending.length > 0) {
    out.push(`${pending.length} gate(s) still pending.`);
  }
  if (changedFiles.length > 20) {
    out.push(`${changedFiles.length} files changed, which is a large surface to review.`);
  }
  const untracked = changedFiles.filter((f) => f.status === 'untracked').length;
  if (untracked > 0) {
    out.push(`${untracked} file(s) are untracked and would not be included in a commit.`);
  }
  if (checkpoints.length === 0) {
    out.push('No checkpoints were recorded, so there is nothing to roll back to.');
  }
  return out;
}

export function RiskPanel({
  sessionId,
  checkpoints,
  changedFiles,
  checklist,
  isLive,
  onRestored,
}: Props) {
  const [confirming, setConfirming] = useState<Checkpoint | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const signals = riskSignals(changedFiles, checklist, checkpoints);

  function restore(cp: Checkpoint) {
    setBusy(true);
    setResult(null);
    api
      .restoreCheckpoint(sessionId, cp.id)
      .then((r) => {
        setResult(`Restored: ${r.description}`);
        setConfirming(null);
        onRestored();
      })
      .catch((e: unknown) =>
        setResult(e instanceof Error ? e.message : 'Restore failed'),
      )
      .finally(() => setBusy(false));
  }

  return (
    <section aria-label="Risk and rollback" className="p-4 sm:p-5">
      <h2 className="flex items-center gap-1.5 text-small uppercase tracking-wide text-muted-accessible dark:text-dark-muted">
        <AlertTriangle size={13} aria-hidden="true" />
        Risk
      </h2>

      {signals.length > 0 ? (
        <ul className="mt-3 space-y-1.5">
          {signals.map((s) => (
            <li
              key={s}
              className="flex gap-2 text-caption text-secondary dark:text-dark-ink"
            >
              <span
                aria-hidden="true"
                className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
              />
              <span>{s}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-caption text-secondary dark:text-dark-ink">
          Nothing flagged from what was recorded. That is not a guarantee of
          correctness, only that no recorded signal was negative.
        </p>
      )}

      <div className="mt-5">
        <h3 className="flex items-center gap-1.5 text-caption font-semibold text-ink dark:text-dark-ink">
          <History size={14} aria-hidden="true" />
          Rollback
        </h3>
        {checkpoints.length === 0 ? (
          <p className="mt-1 text-caption text-muted-accessible dark:text-dark-muted">
            No checkpoints recorded for this session, so there is nothing to roll
            back to.
          </p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {checkpoints.map((cp) => (
              <li
                key={cp.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-border p-2.5 dark:border-dark-border"
              >
                <div className="min-w-0">
                  <p className="truncate text-caption text-ink dark:text-dark-ink">
                    {cp.description}
                  </p>
                  <p className="text-small text-muted-accessible dark:text-dark-muted">
                    {cp.timestamp || 'no timestamp'} - iteration {cp.iteration} -{' '}
                    {cp.files_changed} file(s)
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setConfirming(cp)}
                  disabled={busy || isLive}
                  title={
                    isLive
                      ? 'Cannot roll back while a run is in progress'
                      : undefined
                  }
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-btn border border-danger/30 bg-danger/10 px-2.5 py-1 text-small font-semibold text-danger transition-colors hover:bg-danger/20 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger"
                >
                  <Undo2 size={12} aria-hidden="true" />
                  Roll back
                </button>
              </li>
            ))}
          </ul>
        )}
        {isLive && checkpoints.length > 0 && (
          <p className="mt-2 text-small text-muted-accessible dark:text-dark-muted">
            Rollback is disabled while a run is in progress. Stop the run first.
          </p>
        )}
      </div>

      {/* Destructive: overwrites files in the project directory. Two steps, and
          the confirm names the exact checkpoint. */}
      {confirming && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="rollback-title"
          className="mt-3 rounded-card border border-danger/30 bg-danger/5 p-3"
        >
          <p id="rollback-title" className="text-caption font-semibold text-ink dark:text-dark-ink">
            Roll back to "{confirming.description}"?
          </p>
          <p className="mt-1 text-small text-secondary dark:text-dark-ink">
            This overwrites files in the project directory with the snapshot
            taken at iteration {confirming.iteration}. Changes made since then
            and not checkpointed are lost.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              autoFocus
              onClick={() => restore(confirming)}
              disabled={busy}
              className="rounded-btn bg-danger px-3 py-1.5 text-small font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger"
            >
              {busy ? 'Restoring...' : 'Yes, roll back'}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(null)}
              disabled={busy}
              className="rounded-btn px-3 py-1.5 text-small font-semibold text-secondary transition-colors hover:bg-hover dark:text-dark-ink dark:hover:bg-dark-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {result && (
        <p role="status" className="mt-2 text-caption text-secondary dark:text-dark-ink">
          {result}
        </p>
      )}
    </section>
  );
}
