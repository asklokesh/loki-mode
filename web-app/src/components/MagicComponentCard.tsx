import { useCallback, useState } from 'react';
import {
  FileText,
  Code2,
  Gavel,
  Archive,
  CheckCircle2,
  AlertTriangle,
  Atom,
  Boxes,
  Loader2,
} from 'lucide-react';
import type { MagicComponent, MagicTarget } from '../pages/MagicPage';

interface MagicComponentCardProps {
  component: MagicComponent;
  variant: 'grid' | 'list';
  onRunDebate?: (name: string) => Promise<boolean>;
  onDeprecate?: (name: string) => Promise<boolean>;
}

function formatDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function getTargets(targets: MagicTarget[]): { react: boolean; webcomponent: boolean } {
  const react = targets.includes('react') || targets.includes('both');
  const webcomponent = targets.includes('webcomponent') || targets.includes('both');
  return { react, webcomponent };
}

function TargetBadges({ targets }: { targets: MagicTarget[] }) {
  const { react, webcomponent } = getTargets(targets);
  return (
    <div className="flex items-center gap-1.5" aria-label="Supported targets">
      {react ? (
        <span
          className="inline-flex items-center gap-1 rounded-md bg-sky-500/10 text-sky-600 dark:text-sky-400 px-1.5 py-0.5 text-[11px] font-medium"
          title="React target"
        >
          <Atom size={11} aria-hidden="true" />
          React
        </span>
      ) : null}
      {webcomponent ? (
        <span
          className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 text-amber-700 dark:text-amber-400 px-1.5 py-0.5 text-[11px] font-medium"
          title="Web Component target"
        >
          <Boxes size={11} aria-hidden="true" />
          WC
        </span>
      ) : null}
    </div>
  );
}

function DebateStatus({ passed }: { passed: boolean }) {
  if (passed) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-md bg-[#1FC5A8]/10 text-[#1FC5A8] px-1.5 py-0.5 text-[11px] font-medium"
        title="Debate passed"
      >
        <CheckCircle2 size={11} aria-hidden="true" />
        Debate passed
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md bg-[#D4A03C]/10 text-[#D4A03C] px-1.5 py-0.5 text-[11px] font-medium"
      title="Debate has not passed"
    >
      <AlertTriangle size={11} aria-hidden="true" />
      Needs debate
    </span>
  );
}

function Tag({ value }: { value: string }) {
  return (
    <span className="inline-flex items-center rounded-full bg-[#F5F4EF] dark:bg-[#23232A] text-[#6B6960] dark:text-[#8A8880] px-2 py-0.5 text-[11px]">
      {value}
    </span>
  );
}

export function MagicComponentCard({
  component,
  variant,
  onRunDebate,
  onDeprecate,
}: MagicComponentCardProps) {
  const [debateLoading, setDebateLoading] = useState<boolean>(false);
  const [deprecateLoading, setDeprecateLoading] = useState<boolean>(false);

  const handleRunDebate = useCallback(async () => {
    if (!onRunDebate || debateLoading) return;
    setDebateLoading(true);
    try {
      await onRunDebate(component.name);
    } finally {
      setDebateLoading(false);
    }
  }, [onRunDebate, debateLoading, component.name]);

  const handleDeprecate = useCallback(async () => {
    if (!onDeprecate || deprecateLoading) return;
    const confirmed = window.confirm(
      `Deprecate component "${component.name}"? This marks it as unavailable for new projects.`,
    );
    if (!confirmed) return;
    setDeprecateLoading(true);
    try {
      await onDeprecate(component.name);
    } finally {
      setDeprecateLoading(false);
    }
  }, [onDeprecate, deprecateLoading, component.name]);

  const handleViewSpec = useCallback(() => {
    const url = `/api/magic/components/${encodeURIComponent(component.name)}/spec`;
    window.open(url, '_blank', 'noopener,noreferrer');
  }, [component.name]);

  const handleViewCode = useCallback(() => {
    const url = `/api/magic/components/${encodeURIComponent(component.name)}/code`;
    window.open(url, '_blank', 'noopener,noreferrer');
  }, [component.name]);

  const visibleTags = component.tags.slice(0, 4);
  const hiddenTagCount = component.tags.length - visibleTags.length;

  const actionButtons = (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={handleViewSpec}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-[#ECEAE3] dark:border-[#2A2A30] bg-white dark:bg-[#121215] text-[#36342E] dark:text-[#E8E6E3] text-xs hover:bg-[#F5F4EF] dark:hover:bg-[#23232A] focus:outline-none focus:ring-2 focus:ring-[#553DE9]/40"
      >
        <FileText size={12} aria-hidden="true" />
        View spec
      </button>
      <button
        type="button"
        onClick={handleViewCode}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-[#ECEAE3] dark:border-[#2A2A30] bg-white dark:bg-[#121215] text-[#36342E] dark:text-[#E8E6E3] text-xs hover:bg-[#F5F4EF] dark:hover:bg-[#23232A] focus:outline-none focus:ring-2 focus:ring-[#553DE9]/40"
      >
        <Code2 size={12} aria-hidden="true" />
        View code
      </button>
      <button
        type="button"
        onClick={handleRunDebate}
        disabled={debateLoading}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-[#553DE9]/40 bg-[#553DE9]/10 text-[#553DE9] text-xs hover:bg-[#553DE9]/20 focus:outline-none focus:ring-2 focus:ring-[#553DE9]/40 disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {debateLoading ? (
          <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
        ) : (
          <Gavel size={12} aria-hidden="true" />
        )}
        Run debate
      </button>
      <button
        type="button"
        onClick={handleDeprecate}
        disabled={deprecateLoading}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-[#ECEAE3] dark:border-[#2A2A30] bg-white dark:bg-[#121215] text-[#6B6960] dark:text-[#8A8880] text-xs hover:text-[#C45B5B] hover:border-[#C45B5B]/40 focus:outline-none focus:ring-2 focus:ring-[#C45B5B]/40 disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {deprecateLoading ? (
          <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
        ) : (
          <Archive size={12} aria-hidden="true" />
        )}
        Deprecate
      </button>
    </div>
  );

  if (variant === 'list') {
    return (
      <article className="rounded-lg border border-[#ECEAE3] dark:border-[#2A2A30] bg-white dark:bg-[#1A1A1E] px-4 py-3 hover:shadow-sm transition-shadow">
        <div className="flex flex-col md:flex-row md:items-center gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <h3 className="text-sm font-semibold text-[#36342E] dark:text-[#E8E6E3] truncate">
              {component.name}
            </h3>
            <span className="inline-flex items-center rounded-md bg-[#553DE9]/10 text-[#553DE9] px-1.5 py-0.5 text-[11px] font-medium">
              v{component.version}
            </span>
          </div>
          <p className="flex-1 text-xs text-[#6B6960] dark:text-[#8A8880] truncate">
            {component.description}
          </p>
          <div className="flex items-center gap-2 flex-shrink-0">
            <TargetBadges targets={component.targets} />
            <DebateStatus passed={component.debate_passed} />
            <span className="text-[11px] text-[#939084]">
              Updated {formatDate(component.updated_at)}
            </span>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1">
            {visibleTags.map((t) => (
              <Tag key={t} value={t} />
            ))}
            {hiddenTagCount > 0 ? (
              <span className="text-[11px] text-[#939084]">+{hiddenTagCount} more</span>
            ) : null}
          </div>
          {actionButtons}
        </div>
      </article>
    );
  }

  return (
    <article className="flex flex-col rounded-xl border border-[#ECEAE3] dark:border-[#2A2A30] bg-white dark:bg-[#1A1A1E] shadow-sm hover:shadow-md transition-shadow overflow-hidden">
      <div className="h-24 bg-gradient-to-br from-[#553DE9]/20 via-[#553DE9]/10 to-[#8B78F0]/10 dark:from-[#553DE9]/30 dark:via-[#553DE9]/15 dark:to-[#8B78F0]/10 border-b border-[#ECEAE3] dark:border-[#2A2A30]" />
      <div className="px-4 py-4 flex-1 flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-[#36342E] dark:text-[#E8E6E3] truncate">
              {component.name}
            </h3>
            <div className="mt-0.5 flex items-center gap-2">
              <span className="inline-flex items-center rounded-md bg-[#553DE9]/10 text-[#553DE9] px-1.5 py-0.5 text-[11px] font-medium">
                v{component.version}
              </span>
              <TargetBadges targets={component.targets} />
            </div>
          </div>
          <DebateStatus passed={component.debate_passed} />
        </div>

        <p className="text-xs text-[#6B6960] dark:text-[#8A8880] line-clamp-3">
          {component.description}
        </p>

        {visibleTags.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {visibleTags.map((t) => (
              <Tag key={t} value={t} />
            ))}
            {hiddenTagCount > 0 ? (
              <span className="text-[11px] text-[#939084]">+{hiddenTagCount}</span>
            ) : null}
          </div>
        ) : null}

        <div className="mt-auto pt-2 border-t border-[#ECEAE3] dark:border-[#2A2A30] flex items-center justify-between text-[11px] text-[#939084]">
          <span>Updated {formatDate(component.updated_at)}</span>
        </div>

        {actionButtons}
      </div>
    </article>
  );
}
