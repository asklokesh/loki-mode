import { useEffect, useRef, useState } from 'react';
import { ChevronUp, Terminal } from 'lucide-react';

interface Props {
  logs: string[];
  isLive: boolean;
}

/**
 * Agent chatter is secondary by design: collapsed until asked for. The product
 * is the outcome, not the monologue that produced it.
 */
export function AgentChatter({ logs, isLive }: Props) {
  const [open, setOpen] = useState(false);
  const [follow, setFollow] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !follow || !bodyRef.current) return;
    bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [logs, open, follow]);

  return (
    <section
      aria-label="Agent activity"
      className="border-t border-border bg-card dark:border-dark-border dark:bg-dark-card"
    >
      <h2>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="chatter-body"
          className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-hover dark:hover:bg-dark-hover sm:px-6 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
        >
          <Terminal
            size={14}
            aria-hidden="true"
            className="text-muted-accessible dark:text-dark-muted"
          />
          <span className="text-small font-semibold uppercase tracking-wide text-muted-accessible dark:text-dark-muted">
            Agent activity
          </span>
          <span className="text-small text-muted-accessible dark:text-dark-muted">
            {logs.length} line{logs.length === 1 ? '' : 's'}
            {isLive ? ', live' : ''}
          </span>
          <ChevronUp
            size={14}
            aria-hidden="true"
            className={`ml-auto text-muted-accessible transition-transform motion-reduce:transition-none dark:text-dark-muted ${open ? '' : 'rotate-180'}`}
          />
        </button>
      </h2>
      {open && (
        <div id="chatter-body">
          <div className="flex items-center justify-end px-4 pb-1 sm:px-6">
            <label className="flex items-center gap-1.5 text-small text-muted-accessible dark:text-dark-muted">
              <input
                type="checkbox"
                checked={follow}
                onChange={(e) => setFollow(e.target.checked)}
                className="accent-primary"
              />
              Follow output
            </label>
          </div>
          <div
            ref={bodyRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              const atBottom =
                el.scrollHeight - el.scrollTop - el.clientHeight < 24;
              if (!atBottom && follow) setFollow(false);
            }}
            className="max-h-64 overflow-auto bg-hover px-4 py-2 dark:bg-dark-hover sm:px-6"
          >
            {logs.length === 0 ? (
              <p className="py-2 text-caption text-muted-accessible dark:text-dark-muted">
                No output recorded.
              </p>
            ) : (
              <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-secondary dark:text-dark-ink">
                {logs.join('\n')}
              </pre>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
