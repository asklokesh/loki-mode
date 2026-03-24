import { useState } from 'react';
import { X, ExternalLink } from 'lucide-react';

interface AnnouncementBannerProps {
  id: string;
  message: string;
  linkText?: string;
  linkHref?: string;
  variant?: 'info' | 'update' | 'warning';
  className?: string;
}

const VARIANT_STYLES = {
  info: 'bg-[#553DE9] text-white',
  update: 'bg-gradient-to-r from-[#553DE9] to-[#D63384] text-white',
  warning: 'bg-[#E5A940] text-[#36342E]',
};

const LS_PREFIX = 'pl_banner_dismissed_';

export function AnnouncementBanner({
  id,
  message,
  linkText,
  linkHref,
  variant = 'info',
  className = '',
}: AnnouncementBannerProps) {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(LS_PREFIX + id) === '1';
    } catch {
      return false;
    }
  });

  if (dismissed) return null;

  const handleDismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(LS_PREFIX + id, '1');
    } catch {
      // ignore storage errors
    }
  };

  return (
    <div className={`flex items-center justify-center gap-3 px-4 py-2 text-xs font-medium ${VARIANT_STYLES[variant]} ${className}`}>
      <span>{message}</span>
      {linkText && linkHref && (
        <a
          href={linkHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 underline underline-offset-2 opacity-90 hover:opacity-100 transition-opacity"
        >
          {linkText}
          <ExternalLink size={11} />
        </a>
      )}
      <button
        type="button"
        onClick={handleDismiss}
        className="ml-2 p-0.5 rounded-sm opacity-70 hover:opacity-100 transition-opacity"
        aria-label="Dismiss announcement"
      >
        <X size={14} />
      </button>
    </div>
  );
}
