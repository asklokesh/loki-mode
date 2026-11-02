import { useState, useRef, useEffect } from 'react';
import { HelpCircle, X } from 'lucide-react';

interface ContextualHelpProps {
  text: string;
  position?: 'top' | 'bottom' | 'left' | 'right';
  size?: number;
}

export function ContextualHelp({ text, position = 'top', size = 14 }: ContextualHelpProps) {
  const [visible, setVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!visible) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setVisible(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [visible]);

  const positionClasses: Record<string, string> = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
    left: 'right-full top-1/2 -translate-y-1/2 mr-2',
    right: 'left-full top-1/2 -translate-y-1/2 ml-2',
  };

  const arrowClasses: Record<string, string> = {
    top: 'top-full left-1/2 -translate-x-1/2 border-t-[#1A1A1E] dark:border-t-card border-l-transparent border-r-transparent border-b-transparent border-4',
    bottom: 'bottom-full left-1/2 -translate-x-1/2 border-b-[#1A1A1E] dark:border-b-card border-l-transparent border-r-transparent border-t-transparent border-4',
    left: 'left-full top-1/2 -translate-y-1/2 border-l-[#1A1A1E] dark:border-l-card border-t-transparent border-b-transparent border-r-transparent border-4',
    right: 'right-full top-1/2 -translate-y-1/2 border-r-[#1A1A1E] dark:border-r-card border-t-transparent border-b-transparent border-l-transparent border-4',
  };

  return (
    <div className="relative inline-flex items-center" ref={containerRef}>
      <button
        onClick={() => setVisible(!visible)}
        onMouseEnter={() => setVisible(true)}
        onMouseLeave={() => setVisible(false)}
        className="text-muted/50 hover:text-primary transition-colors p-0.5 rounded-full"
        aria-label="Help"
        type="button"
      >
        <HelpCircle size={size} />
      </button>

      {visible && (
        <div
          className={`absolute z-50 ${positionClasses[position]}`}
          role="tooltip"
        >
          <div className="relative bg-[#1A1A1E] text-white px-3 py-2 rounded-lg shadow-lg max-w-[240px]">
            <p className="text-[11px] leading-relaxed">{text}</p>
            <span className={`absolute ${arrowClasses[position]}`} />
          </div>
        </div>
      )}
    </div>
  );
}

// Pre-defined help tooltips for common features (H80)
export const HELP_TOOLTIPS = {
  buildProgress:
    'Shows the current phase of your AI-powered build. Phases include planning, building, testing, and reviewing.',
  qualityGates:
    'Automated checks ensuring your code meets quality standards. Includes static analysis, test coverage, and security scanning.',
  rarvCycle:
    'Reason, Act, Reflect, Verify -- the AI\'s thinking process. Each iteration follows this cycle to produce high-quality results.',
  providerSelector:
    'Choose which AI model powers your builds. Claude offers full features; opencode runs any model, including OpenRouter models.',
};
