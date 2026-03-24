import { ChevronRight, Home } from 'lucide-react';
import { Link } from 'react-router-dom';

export interface BreadcrumbSegment {
  label: string;
  href?: string;
}

interface BreadcrumbProps {
  segments: BreadcrumbSegment[];
  maxLabelLength?: number;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '\u2026';
}

export function Breadcrumb({ segments, maxLabelLength = 24 }: BreadcrumbProps) {
  if (segments.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-xs text-muted">
      <Link
        to="/"
        className="flex items-center gap-1 text-muted hover:text-ink transition-colors"
        title="Home"
      >
        <Home size={13} />
      </Link>
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        const label = truncate(seg.label, maxLabelLength);
        return (
          <span key={i} className="flex items-center gap-1">
            <ChevronRight size={12} className="text-muted/50 flex-shrink-0" />
            {isLast || !seg.href ? (
              <span
                className={isLast ? 'text-ink font-medium' : 'text-muted'}
                title={seg.label.length > maxLabelLength ? seg.label : undefined}
              >
                {label}
              </span>
            ) : (
              <Link
                to={seg.href}
                className="text-muted hover:text-ink transition-colors"
                title={seg.label.length > maxLabelLength ? seg.label : undefined}
              >
                {label}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
