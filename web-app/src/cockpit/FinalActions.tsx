import { useState } from 'react';
import {
  GitPullRequest,
  Pause,
  Play,
  Square,
  Upload,
  GitCommitHorizontal,
  MessageSquareDiff,
  ThumbsUp,
} from 'lucide-react';
import { api } from '../api/client';
import type { GitStatus, StatusResponse } from '../types/api';
import type { ChangedFile } from './useCockpitState';

/**
 * An affordance is either backed by a real endpoint or it is disabled WITH a
 * visible reason. There is no third option: a button that looks live and does
 * nothing is worse than no button.
 */
interface ActionSpec {
  key: string;
  label: string;
  icon: React.ComponentType<{ size?: number }>;
  /** Null when enabled; otherwise the reason shown to the user. */
  disabledReason: string | null;
  danger?: boolean;
  onRun?: () => Promise<string>;
}

interface Props {
  sessionId: string;
  isLive: boolean;
  status: StatusResponse | null;
  git: GitStatus | null;
  changedFiles: ChangedFile[];
  onChanged: () => void;
}

export function FinalActions({
  sessionId,
  isLive,
  status,
  git,
  changedFiles,
  onChanged,
}: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [prTitle, setPrTitle] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState('');

  const paused = Boolean(status?.paused);
  const hasChanges = changedFiles.length > 0;
  const ahead = git?.ahead ?? 0;

  const actions: ActionSpec[] = [
    {
      key: 'pause',
      label: 'Pause',
      icon: Pause,
      disabledReason: !isLive
        ? 'No run in progress for this session'
        : paused
          ? 'Already paused'
          : null,
      onRun: () => api.pauseSession().then((r) => r.message ?? 'Paused'),
    },
    {
      key: 'resume',
      label: 'Resume',
      icon: Play,
      disabledReason: !isLive
        ? 'No run in progress for this session'
        : !paused
          ? 'The run is not paused'
          : null,
      onRun: () => api.resumeSession().then((r) => r.message ?? 'Resumed'),
    },
    {
      key: 'stop',
      label: 'Stop run',
      icon: Square,
      danger: true,
      disabledReason: !isLive ? 'No run in progress for this session' : null,
      onRun: () => api.stopSession().then((r) => r.message ?? 'Stopped'),
    },
    {
      key: 'commit',
      label: 'Commit',
      icon: GitCommitHorizontal,
      disabledReason: !hasChanges ? 'The working tree is clean' : null,
      onRun: () =>
        api
          .git.commit(sessionId, prTitle.trim() || 'Loki: apply changes')
          .then((r) => `Committed ${r.hash.slice(0, 7)}`),
    },
    {
      key: 'push',
      label: 'Push',
      icon: Upload,
      disabledReason: ahead <= 0 ? 'Nothing to push: no commits ahead of the remote' : null,
      onRun: () => api.git.push(sessionId).then((r) => r.message ?? 'Pushed'),
    },
    {
      key: 'pr',
      label: 'Open pull request',
      icon: GitPullRequest,
      disabledReason: !hasChanges && ahead <= 0
        ? 'Nothing to open a pull request for'
        : !prTitle.trim()
          ? 'Enter a title first'
          : null,
      onRun: () =>
        api
          .git.pr(sessionId, prTitle.trim(), '')
          .then((r) => `Opened #${r.number}: ${r.url}`),
    },
  ];

  function run(a: ActionSpec) {
    if (!a.onRun || a.disabledReason) return;
    setBusy(a.key);
    setMessage(null);
    a.onRun()
      .then((m) => {
        setMessage(m);
        onChanged();
      })
      .catch((e: unknown) =>
        setMessage(e instanceof Error ? e.message : `${a.label} failed`),
      )
      .finally(() => setBusy(null));
  }

  function requestChange() {
    const text = previewText.trim();
    if (!text) return;
    setBusy('preview');
    setPreview(null);
    api
      .previewChanges(sessionId, text)
      .then((d) =>
        setPreview(
          d.files.length === 0
            ? 'No files would change.'
            : `${d.files.length} file(s) would change: +${d.total_additions} / -${d.total_deletions}\n\n${d.files
                .map((f) => `${f.action.padEnd(7)} ${f.path}  +${f.additions} -${f.deletions}`)
                .join('\n')}`,
        ),
      )
      .catch((e: unknown) =>
        setPreview(e instanceof Error ? e.message : 'Preview failed'),
      )
      .finally(() => setBusy(null));
  }

  return (
    <section aria-label="Actions" className="p-4 sm:p-5">
      <h2 className="text-small uppercase tracking-wide text-muted-accessible dark:text-dark-muted">
        Actions
      </h2>

      <label className="mt-3 block">
        <span className="text-small text-muted-accessible dark:text-dark-muted">
          Commit / pull request title
        </span>
        <input
          type="text"
          value={prTitle}
          onChange={(e) => setPrTitle(e.target.value)}
          placeholder="Describe the change"
          className="mt-1 w-full rounded-btn border border-border bg-card px-2.5 py-1.5 text-caption text-ink placeholder:text-muted-accessible focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-1px] focus-visible:outline-primary dark:border-dark-border dark:bg-dark-card dark:text-dark-ink"
        />
      </label>

      <div className="mt-3 flex flex-wrap gap-2">
        {actions.map((a) => {
          const disabled = Boolean(a.disabledReason) || busy !== null;
          const Icon = a.icon;
          return (
            <button
              key={a.key}
              type="button"
              onClick={() => run(a)}
              disabled={disabled}
              aria-describedby={a.disabledReason ? `reason-${a.key}` : undefined}
              className={[
                'inline-flex items-center gap-1.5 rounded-btn border px-3 py-1.5 text-small font-semibold transition-colors motion-reduce:transition-none',
                a.danger
                  ? 'border-danger/30 bg-danger/10 text-danger hover:bg-danger/20'
                  : 'border-primary/30 text-primary hover:bg-primary/5',
                disabled ? 'cursor-not-allowed opacity-60' : '',
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
              ].join(' ')}
            >
              <Icon size={13} />
              {busy === a.key ? 'Working...' : a.label}
            </button>
          );
        })}
      </div>

      {/* Reasons are text, not tooltips: a greyed button with no explanation is
          the thing this panel exists to avoid. */}
      <ul className="mt-2 space-y-0.5">
        {actions
          .filter((a) => a.disabledReason)
          .map((a) => (
            <li
              key={a.key}
              id={`reason-${a.key}`}
              className="text-small text-muted-accessible dark:text-dark-muted"
            >
              {a.label}: {a.disabledReason}.
            </li>
          ))}
      </ul>

      {message && (
        <p
          role="status"
          className="mt-3 break-words rounded-btn bg-hover px-2.5 py-2 text-caption text-secondary dark:bg-dark-hover dark:text-dark-ink"
        >
          {message}
        </p>
      )}

      <div className="mt-5 border-t border-border pt-4 dark:border-dark-border">
        <h3 className="flex items-center gap-1.5 text-caption font-semibold text-ink dark:text-dark-ink">
          <MessageSquareDiff size={14} aria-hidden="true" />
          Request a change
        </h3>
        <p className="mt-1 text-small text-muted-accessible dark:text-dark-muted">
          Dry run only. This shows the diff a change would produce; it does not
          apply anything.
        </p>
        <textarea
          value={previewText}
          onChange={(e) => setPreviewText(e.target.value)}
          rows={2}
          placeholder="What should be different?"
          className="mt-2 w-full rounded-btn border border-border bg-card px-2.5 py-1.5 text-caption text-ink placeholder:text-muted-accessible focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-1px] focus-visible:outline-primary dark:border-dark-border dark:bg-dark-card dark:text-dark-ink"
        />
        <button
          type="button"
          onClick={requestChange}
          disabled={!previewText.trim() || busy !== null}
          className="mt-2 inline-flex items-center gap-1.5 rounded-btn border border-primary/30 px-3 py-1.5 text-small font-semibold text-primary transition-colors hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {busy === 'preview' ? 'Previewing...' : 'Preview change'}
        </button>
        {preview && (
          <pre className="mt-2 max-h-56 overflow-auto rounded-btn bg-hover p-2 font-mono text-xs text-secondary dark:bg-dark-hover dark:text-dark-ink">
            {preview}
          </pre>
        )}
      </div>

      <div className="mt-5 border-t border-border pt-4 dark:border-dark-border">
        <div className="flex items-start gap-2">
          <ThumbsUp
            size={14}
            aria-hidden="true"
            className="mt-0.5 shrink-0 text-muted-accessible dark:text-dark-muted"
          />
          <div>
            <h3 className="text-caption font-semibold text-muted-accessible dark:text-dark-muted">
              Approve
            </h3>
            {/* No endpoint approves a local run. reviewGitHubPR approves an
                EXISTING GitHub PR, which is a different thing. Saying so beats
                a button that pretends. */}
            <p className="mt-1 text-small text-muted-accessible dark:text-dark-muted">
              Not available. This API has no endpoint that approves a local run.
              Approval happens on the pull request once one is open.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
