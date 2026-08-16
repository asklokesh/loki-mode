import { useEffect, useRef, useState } from 'react';
import { FilePlus2, FileMinus2, FilePen, FileQuestion } from 'lucide-react';
import { api } from '../api/client';
import type { ChangedFile } from './useCockpitState';

const STATUS_ICON: Record<string, React.ComponentType<{ size?: number }>> = {
  added: FilePlus2,
  deleted: FileMinus2,
  modified: FilePen,
  renamed: FilePen,
  untracked: FileQuestion,
};

const STATUS_COLOR: Record<string, string> = {
  added: 'text-success',
  deleted: 'text-danger',
  modified: 'text-info',
  renamed: 'text-info',
  untracked: 'text-warning',
};

interface Props {
  sessionId: string;
  files: ChangedFile[];
  clean: boolean;
}

export function ChangeReview({ sessionId, files, clean }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent(null);
    api
      .getSessionFileContent(sessionId, selected)
      .then((r) => !cancelled && setContent(r.content))
      .catch((e: unknown) =>
        !cancelled &&
        setError(e instanceof Error ? e.message : 'Could not read this file'),
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [sessionId, selected]);

  // Roving tabindex: the list is one tab stop, arrows move within it.
  function onKeyDown(e: React.KeyboardEvent<HTMLUListElement>) {
    if (files.length === 0) return;
    let next = focusIndex;
    if (e.key === 'ArrowDown') next = Math.min(focusIndex + 1, files.length - 1);
    else if (e.key === 'ArrowUp') next = Math.max(focusIndex - 1, 0);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = files.length - 1;
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setSelected(files[focusIndex].path);
      return;
    } else return;
    e.preventDefault();
    setFocusIndex(next);
    const el = listRef.current?.querySelectorAll('li > button')[next];
    (el as HTMLElement | undefined)?.focus();
  }

  if (clean && files.length === 0) {
    return (
      <section aria-label="Changed files" className="p-4 sm:p-5">
        <h2 className="text-small uppercase tracking-wide text-muted-accessible dark:text-dark-muted">
          Changes
        </h2>
        <p className="mt-3 text-caption text-muted-accessible dark:text-dark-muted">
          The working tree is clean. Nothing has been changed in this session.
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Changed files" className="flex min-h-0 flex-col p-4 sm:p-5">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-small uppercase tracking-wide text-muted-accessible dark:text-dark-muted">
          Changes
        </h2>
        <span className="text-small text-muted-accessible dark:text-dark-muted">
          {files.length} {files.length === 1 ? 'file' : 'files'}
        </span>
      </div>

      <div className="mt-3 grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <ul
          ref={listRef}
          role="listbox"
          aria-label="Changed files"
          tabIndex={files.length ? 0 : -1}
          onKeyDown={onKeyDown}
          className="max-h-72 space-y-0.5 overflow-y-auto lg:max-h-none"
        >
          {files.map((f, i) => {
            const Icon = STATUS_ICON[f.status] ?? FilePen;
            const active = selected === f.path;
            return (
              <li key={f.path} role="option" aria-selected={active}>
                <button
                  type="button"
                  tabIndex={i === focusIndex ? 0 : -1}
                  onFocus={() => setFocusIndex(i)}
                  onClick={() => setSelected(f.path)}
                  className={[
                    'flex w-full items-center gap-2 rounded-btn px-2 py-1.5 text-left transition-colors motion-reduce:transition-none',
                    active
                      ? 'bg-primary/10 text-ink dark:text-dark-ink'
                      : 'text-secondary hover:bg-hover dark:text-dark-ink dark:hover:bg-dark-hover',
                    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary',
                  ].join(' ')}
                >
                  <span className={STATUS_COLOR[f.status] ?? 'text-muted-accessible'}>
                    <Icon size={14} />
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs" title={f.path}>
                    {f.path}
                  </span>
                  <span className="shrink-0 text-small text-muted-accessible dark:text-dark-muted">
                    {f.partiallyStaged ? 'partly staged' : f.staged ? 'staged' : ''}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        <div className="min-w-0 rounded-card border border-border bg-hover dark:border-dark-border dark:bg-dark-hover">
          {!selected && (
            <p className="p-4 text-caption text-muted-accessible dark:text-dark-muted">
              Select a file to read it. This shows the file as it stands now; a
              line-by-line diff against the previous revision is not served by
              this API.
            </p>
          )}
          {selected && loading && (
            <p className="p-4 text-caption text-muted-accessible dark:text-dark-muted">
              Loading {selected}...
            </p>
          )}
          {selected && error && (
            <p className="p-4 text-caption text-danger">{error}</p>
          )}
          {selected && content !== null && (
            <pre className="max-h-[28rem] overflow-auto p-3 font-mono text-xs leading-relaxed text-secondary dark:text-dark-ink">
              {content}
            </pre>
          )}
        </div>
      </div>
    </section>
  );
}
