import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

interface ChangelogEntry {
  version: string;
  date: string;
  features: string[];
}

const RECENT_CHANGES: ChangelogEntry[] = [
  {
    version: '6.71.1',
    date: 'Mar 24, 2026',
    features: [
      'BuildProgressBar server integration with cost, ETA, and phase data',
      'Sprint 1 complete: BuildProgressBar, CommandPalette, dark mode, sidebar theme toggle',
      'Quick-start API, dark mode prep, theme hook foundation',
    ],
  },
  {
    version: '6.70.0',
    date: 'Mar 22, 2026',
    features: [
      'Embedded Loki Dashboard in Purple Lab workspace',
      'Panel toggles, modern UI, bigger fonts, smooth transitions',
      'Sprint 1 foundation with quick-start API',
    ],
  },
  {
    version: '6.69.0',
    date: 'Mar 20, 2026',
    features: [
      'Purple Lab IDE workspace with Monaco editor',
      'AI chat panel for iterative development',
      'Activity panel with build log and quality gates',
    ],
  },
];

export function ChangelogWidget() {
  const [expanded, setExpanded] = useState(false);

  const visibleEntries = expanded ? RECENT_CHANGES : RECENT_CHANGES.slice(0, 2);

  return (
    <div className="bg-white border border-[#ECEAE3] rounded-xl p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-bold text-[#36342E]">Recent Changes</h4>
        <a
          href="https://github.com/asklokesh/loki-mode/blob/main/CHANGELOG.md"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-[#553DE9] hover:text-[#4832c7] font-medium"
        >
          View all
        </a>
      </div>

      <div className="space-y-3">
        {visibleEntries.map((entry) => (
          <div key={entry.version} className="pb-3 border-b border-[#ECEAE3] last:border-b-0 last:pb-0">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="px-1.5 py-0.5 text-xs font-mono font-bold rounded bg-[#553DE9]/10 text-[#553DE9]">
                v{entry.version}
              </span>
              <span className="text-xs text-[#939084]">{entry.date}</span>
            </div>
            <ul className="space-y-1">
              {entry.features.map((feature, i) => (
                <li key={i} className="text-xs text-[#6B6960] pl-3 relative before:content-[''] before:absolute before:left-0 before:top-[7px] before:w-1.5 before:h-1.5 before:rounded-full before:bg-[#ECEAE3]">
                  {feature}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {RECENT_CHANGES.length > 2 && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-2 flex items-center gap-1 text-xs text-[#6B6960] hover:text-[#36342E] transition-colors"
        >
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          {expanded ? 'Show less' : `Show ${RECENT_CHANGES.length - 2} more`}
        </button>
      )}
    </div>
  );
}
