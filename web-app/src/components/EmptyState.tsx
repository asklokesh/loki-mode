import { Button } from './ui/Button';
import type { LucideIcon } from 'lucide-react';

type IllustrationType = 'no-projects' | 'no-files' | 'no-results' | 'no-agents' | 'no-tasks';

interface EmptyStateProps {
  title: string;
  description?: string;
  illustration?: IllustrationType;
  actionLabel?: string;
  actionIcon?: LucideIcon;
  onAction?: () => void;
  className?: string;
}

function Illustration({ type }: { type: IllustrationType }) {
  const colors = {
    'no-projects': { primary: '#553DE9', secondary: '#D63384' },
    'no-files': { primary: '#3B82F6', secondary: '#553DE9' },
    'no-results': { primary: '#E5A940', secondary: '#553DE9' },
    'no-agents': { primary: '#1FC5A8', secondary: '#553DE9' },
    'no-tasks': { primary: '#8B5CF6', secondary: '#1FC5A8' },
  };

  const c = colors[type] || colors['no-projects'];

  return (
    <svg width="120" height="100" viewBox="0 0 120 100" fill="none" className="mb-4 opacity-60">
      {/* Background circles */}
      <circle cx="60" cy="50" r="40" fill={c.primary} opacity="0.06" />
      <circle cx="60" cy="50" r="28" fill={c.primary} opacity="0.08" />

      {/* Decorative elements vary by type */}
      {type === 'no-projects' && (
        <>
          <rect x="38" y="32" width="44" height="36" rx="4" stroke={c.primary} strokeWidth="2" fill="none" opacity="0.4" />
          <line x1="44" y1="44" x2="76" y2="44" stroke={c.secondary} strokeWidth="2" opacity="0.3" strokeLinecap="round" />
          <line x1="44" y1="52" x2="66" y2="52" stroke={c.primary} strokeWidth="2" opacity="0.3" strokeLinecap="round" />
          <line x1="44" y1="60" x2="58" y2="60" stroke={c.primary} strokeWidth="2" opacity="0.2" strokeLinecap="round" />
          <circle cx="90" cy="24" r="3" fill={c.secondary} opacity="0.2" />
          <circle cx="28" cy="68" r="4" fill={c.primary} opacity="0.15" />
        </>
      )}
      {type === 'no-files' && (
        <>
          <rect x="42" y="28" width="28" height="36" rx="2" stroke={c.primary} strokeWidth="2" fill="none" opacity="0.4" />
          <polyline points="56,28 56,38 70,38" stroke={c.primary} strokeWidth="2" fill="none" opacity="0.3" />
          <line x1="48" y1="48" x2="64" y2="48" stroke={c.secondary} strokeWidth="1.5" opacity="0.3" strokeLinecap="round" />
          <line x1="48" y1="54" x2="60" y2="54" stroke={c.primary} strokeWidth="1.5" opacity="0.2" strokeLinecap="round" />
          <circle cx="84" cy="30" r="5" fill={c.secondary} opacity="0.15" />
          <circle cx="32" cy="72" r="3" fill={c.primary} opacity="0.15" />
        </>
      )}
      {type === 'no-results' && (
        <>
          <circle cx="56" cy="46" r="16" stroke={c.primary} strokeWidth="2" fill="none" opacity="0.4" />
          <line x1="68" y1="58" x2="80" y2="70" stroke={c.primary} strokeWidth="3" opacity="0.3" strokeLinecap="round" />
          <circle cx="86" cy="28" r="4" fill={c.secondary} opacity="0.2" />
          <circle cx="30" cy="62" r="3" fill={c.primary} opacity="0.15" />
        </>
      )}
      {type === 'no-agents' && (
        <>
          <circle cx="60" cy="42" r="10" stroke={c.primary} strokeWidth="2" fill="none" opacity="0.4" />
          <path d="M42 62 C42 54 50 48 60 48 C70 48 78 54 78 62" stroke={c.primary} strokeWidth="2" fill="none" opacity="0.3" />
          <circle cx="82" cy="30" r="6" stroke={c.secondary} strokeWidth="1.5" fill="none" opacity="0.2" />
          <circle cx="36" cy="32" r="4" stroke={c.secondary} strokeWidth="1.5" fill="none" opacity="0.15" />
        </>
      )}
      {type === 'no-tasks' && (
        <>
          <rect x="38" y="30" width="44" height="10" rx="2" stroke={c.primary} strokeWidth="1.5" fill="none" opacity="0.3" />
          <rect x="38" y="45" width="44" height="10" rx="2" stroke={c.primary} strokeWidth="1.5" fill="none" opacity="0.25" />
          <rect x="38" y="60" width="44" height="10" rx="2" stroke={c.secondary} strokeWidth="1.5" fill="none" opacity="0.2" />
          <circle cx="44" cy="35" r="2" fill={c.primary} opacity="0.3" />
          <circle cx="44" cy="50" r="2" fill={c.primary} opacity="0.25" />
          <circle cx="44" cy="65" r="2" fill={c.secondary} opacity="0.2" />
        </>
      )}
    </svg>
  );
}

export function EmptyState({
  title,
  description,
  illustration = 'no-projects',
  actionLabel,
  actionIcon,
  onAction,
  className = '',
}: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center py-16 text-center ${className}`}>
      <Illustration type={illustration} />
      <h3 className="text-base font-semibold text-ink mb-1">{title}</h3>
      {description && (
        <p className="text-sm text-muted max-w-sm mb-4">{description}</p>
      )}
      {actionLabel && onAction && (
        <Button icon={actionIcon} onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
