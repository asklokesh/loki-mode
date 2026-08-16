import { useState } from 'react';
import { Check, X, Minus, Circle, Play, ShieldCheck } from 'lucide-react';
import { api } from '../api/client';
import type { ChecklistSummary } from '../types/api';

const ITEM_ICON = {
  pass: { Icon: Check, cls: 'text-success' },
  fail: { Icon: X, cls: 'text-danger' },
  skip: { Icon: Minus, cls: 'text-muted-accessible' },
  pending: { Icon: Circle, cls: 'text-warning' },
} as const;

interface CheckRunState {
  running: boolean;
  returncode: number | null;
  output: string | null;
  error: string | null;
}

const IDLE_RUN: CheckRunState = {
  running: false,
  returncode: null,
  output: null,
  error: null,
};

interface Props {
  sessionId: string;
  checklist: ChecklistSummary | null;
}

export function EvidencePanel({ sessionId, checklist }: Props) {
  const [tests, setTests] = useState<CheckRunState>(IDLE_RUN);
  const [review, setReview] = useState<CheckRunState>(IDLE_RUN);

  // /sessions/{id}/test and /review RUN things and return {output, returncode}.
  // They are actions, not passive evidence, so nothing is shown until the user
  // asks for it -- a green tile for a check we never ran would be a lie.
  function run(
    kind: 'tests' | 'review',
    call: () => Promise<{ output: string; returncode: number }>,
  ) {
    const set = kind === 'tests' ? setTests : setReview;
    set({ ...IDLE_RUN, running: true });
    call()
      .then((r) =>
        set({ running: false, returncode: r.returncode, output: r.output, error: null }),
      )
      .catch((e: unknown) =>
        set({
          running: false,
          returncode: null,
          output: null,
          error: e instanceof Error ? e.message : 'Failed to run',
        }),
      );
  }

  // The endpoint returns all-zeros with items: [] when .loki/state/checklist.json
  // is absent (web-app/server.py:3160). Zeros are NOT "all gates passed".
  const hasGateResults = Boolean(checklist && checklist.items.length > 0);

  return (
    <section aria-label="Evidence" className="p-4 sm:p-5">
      <h2 className="flex items-center gap-1.5 text-small uppercase tracking-wide text-muted-accessible dark:text-dark-muted">
        <ShieldCheck size={13} aria-hidden="true" />
        Evidence
      </h2>

      <div className="mt-3">
        <h3 className="text-caption font-semibold text-ink dark:text-dark-ink">
          Quality gates
        </h3>
        {hasGateResults ? (
          <>
            <p className="mt-1 text-small text-muted-accessible dark:text-dark-muted">
              {checklist!.passed} passed, {checklist!.failed} failed,{' '}
              {checklist!.skipped} skipped, {checklist!.pending} pending
            </p>
            <ul className="mt-2 space-y-1">
              {checklist!.items.map((item) => {
                const { Icon, cls } = ITEM_ICON[item.status] ?? ITEM_ICON.pending;
                return (
                  <li key={item.id} className="flex items-start gap-2">
                    <span className={`mt-0.5 shrink-0 ${cls}`}>
                      <Icon size={14} aria-hidden="true" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-caption text-secondary dark:text-dark-ink">
                        {item.label}
                      </span>
                      <span className="sr-only">{item.status}</span>
                      {item.details && (
                        <span className="block text-small text-muted-accessible dark:text-dark-muted">
                          {item.details}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <p className="mt-1 text-caption text-muted-accessible dark:text-dark-muted">
            No gate results recorded. The engine writes these during a run; an
            empty file is not the same as a clean pass.
          </p>
        )}
      </div>

      <div className="mt-5 space-y-3">
        <h3 className="text-caption font-semibold text-ink dark:text-dark-ink">
          Checks
        </h3>
        <CheckRow
          name="Test suite"
          state={tests}
          onRun={() => run('tests', () => api.testProject(sessionId))}
        />
        <CheckRow
          name="Code review"
          state={review}
          onRun={() => run('review', () => api.reviewProject(sessionId))}
        />
        <p className="text-small text-muted-accessible dark:text-dark-muted">
          Build, typecheck and lint are not exposed as separate endpoints by this
          API. They run inside the test and review commands above.
        </p>
      </div>
    </section>
  );
}

function CheckRow({
  name,
  state,
  onRun,
}: {
  name: string;
  state: CheckRunState;
  onRun: () => void;
}) {
  const verdict =
    state.returncode === null
      ? null
      : state.returncode === 0
        ? { text: 'Passed', cls: 'text-success' }
        : { text: `Failed (exit ${state.returncode})`, cls: 'text-danger' };

  return (
    <div className="rounded-card border border-border p-3 dark:border-dark-border">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-caption text-ink dark:text-dark-ink">{name}</p>
          <p
            className={`text-small ${verdict?.cls ?? 'text-muted-accessible dark:text-dark-muted'}`}
          >
            {state.running
              ? 'Running...'
              : state.error
                ? state.error
                : (verdict?.text ?? 'Not run')}
          </p>
        </div>
        <button
          type="button"
          onClick={onRun}
          disabled={state.running}
          className="inline-flex items-center gap-1.5 rounded-btn border border-primary/30 px-2.5 py-1 text-small font-semibold text-primary transition-colors hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <Play size={12} aria-hidden="true" />
          {state.returncode === null ? 'Run' : 'Re-run'}
        </button>
      </div>
      {state.output && (
        <pre className="mt-2 max-h-48 overflow-auto rounded-btn bg-hover p-2 font-mono text-xs text-secondary dark:bg-dark-hover dark:text-dark-ink">
          {state.output}
        </pre>
      )}
    </div>
  );
}
