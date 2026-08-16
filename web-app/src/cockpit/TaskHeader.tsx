import { useMemo, useState } from 'react';
import { ChevronDown, FileText, GitBranch, Cpu } from 'lucide-react';
import type { SessionDetail } from '../api/client';
import type { GitStatus, StatusResponse } from '../types/api';
import { parseSpec } from './derive';

interface Props {
  detail: SessionDetail | null;
  status: StatusResponse | null;
  git: GitStatus | null;
  isLive: boolean;
}

export function TaskHeader({ detail, status, git, isLive }: Props) {
  const { goal, criteria } = useMemo(() => parseSpec(detail?.prd), [detail?.prd]);
  const [specOpen, setSpecOpen] = useState(false);

  return (
    <header
      aria-label="Task"
      className="border-b border-border dark:border-dark-border bg-card dark:bg-dark-card px-4 py-4 sm:px-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-small uppercase tracking-wide text-muted-accessible dark:text-dark-muted">
            Goal
          </p>
          <h1 className="mt-1 font-heading text-h2 leading-tight text-ink dark:text-dark-ink">
            {goal ?? 'No spec recorded for this session'}
          </h1>
          {!goal && (
            <p className="mt-1 text-caption text-muted-accessible dark:text-dark-muted">
              A PRD.md in the project directory would appear here.
            </p>
          )}
        </div>
      </div>

      <dl className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-caption text-muted-accessible dark:text-dark-muted">
        {git?.branch && (
          <div className="flex items-center gap-1.5">
            <GitBranch size={14} aria-hidden="true" />
            <dt className="sr-only">Branch</dt>
            <dd className="font-mono">{git.branch}</dd>
          </div>
        )}
        {isLive && status?.provider && (
          <div className="flex items-center gap-1.5">
            <Cpu size={14} aria-hidden="true" />
            <dt className="sr-only">Provider</dt>
            <dd>{status.provider}</dd>
          </div>
        )}
        {detail?.path && (
          <div className="flex min-w-0 items-center gap-1.5">
            <FileText size={14} aria-hidden="true" />
            <dt className="sr-only">Project directory</dt>
            <dd className="truncate font-mono" title={detail.path}>
              {detail.path}
            </dd>
          </div>
        )}
      </dl>

      <section aria-label="Acceptance criteria" className="mt-4">
        <h2 className="text-small uppercase tracking-wide text-muted-accessible dark:text-dark-muted">
          Acceptance criteria
        </h2>
        {criteria.length > 0 ? (
          <ul className="mt-2 space-y-1.5">
            {criteria.map((c) => (
              <li
                key={c}
                className="flex gap-2 text-caption text-secondary dark:text-dark-ink"
              >
                <span
                  aria-hidden="true"
                  className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                />
                <span>{c}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-caption text-muted-accessible dark:text-dark-muted">
            None stated in the spec. Nothing here is inferred, so this run has no
            declared pass condition beyond its quality gates.
          </p>
        )}
      </section>

      {detail?.prd?.trim() && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setSpecOpen((v) => !v)}
            aria-expanded={specOpen}
            className="inline-flex items-center gap-1.5 rounded-btn px-2 py-1 text-small text-primary transition-colors hover:bg-primary/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <ChevronDown
              size={14}
              aria-hidden="true"
              className={`transition-transform motion-reduce:transition-none ${specOpen ? 'rotate-180' : ''}`}
            />
            {specOpen ? 'Hide full spec' : 'Read full spec'}
          </button>
          {specOpen && (
            <pre className="mt-2 max-h-80 overflow-auto rounded-card border border-border bg-hover p-3 font-mono text-xs leading-relaxed text-secondary dark:border-dark-border dark:bg-dark-hover dark:text-dark-ink">
              {detail.prd}
            </pre>
          )}
        </div>
      )}
    </header>
  );
}
