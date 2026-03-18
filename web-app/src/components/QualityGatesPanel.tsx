import { useState } from 'react';
import type { ChecklistSummary, ChecklistItem } from '../types/api';

interface QualityGatesPanelProps {
  checklist: ChecklistSummary | null;
  loading: boolean;
}

const STATUS_STYLES: Record<ChecklistItem['status'], { badge: string; dot: string; label: string }> = {
  pass: { badge: 'bg-success/10 text-success border-success/20', dot: 'bg-success', label: 'Pass' },
  fail: { badge: 'bg-danger/10 text-danger border-danger/20', dot: 'bg-danger', label: 'Fail' },
  skip: { badge: 'bg-slate/10 text-slate border-slate/20', dot: 'bg-slate/40', label: 'Skip' },
  pending: { badge: 'bg-warning/10 text-warning border-warning/20', dot: 'bg-warning', label: 'Pending' },
};

function GateItem({ item }: { item: ChecklistItem }) {
  const [expanded, setExpanded] = useState(false);
  const style = STATUS_STYLES[item.status];

  return (
    <div className={`border rounded-xl overflow-hidden ${style.badge}`}>
      <button
        type="button"
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left"
        onClick={() => item.details && setExpanded(!expanded)}
      >
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${style.dot}`} />
        <span className="text-sm font-medium flex-1 truncate">{item.label}</span>
        <span className="text-[10px] font-mono font-semibold uppercase tracking-wider flex-shrink-0">
          {style.label}
        </span>
        {item.details && (
          <span className="text-xs text-slate/60 flex-shrink-0">
            {expanded ? 'v' : '>'}
          </span>
        )}
      </button>
      {expanded && item.details && (
        <div className="px-3 pb-2.5 pt-0">
          <p className="text-xs font-mono opacity-70 leading-relaxed">{item.details}</p>
        </div>
      )}
    </div>
  );
}

export function QualityGatesPanel({ checklist, loading }: QualityGatesPanelProps) {
  const passedPercent = checklist && checklist.total > 0
    ? (checklist.passed / checklist.total) * 100
    : 0;

  return (
    <div className="glass p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-charcoal uppercase tracking-wider">
          Quality Gates
        </h3>
        {checklist && (
          <span className="font-mono text-xs text-slate">
            {checklist.passed}/{checklist.total} passed
          </span>
        )}
      </div>

      {loading && !checklist && (
        <div className="text-center py-8 text-slate text-sm">Loading gates...</div>
      )}

      {!loading && !checklist && (
        <div className="text-center py-8">
          <p className="text-slate text-sm">No quality gate data</p>
          <p className="text-primary-wash text-xs mt-1">Gates run during verification phase</p>
        </div>
      )}

      {checklist && (
        <>
          {/* Summary stats */}
          <div className="flex items-center gap-4 mb-3 text-xs">
            <span className="text-success font-medium">{checklist.passed} passed</span>
            {checklist.failed > 0 && (
              <span className="text-danger font-medium">{checklist.failed} failed</span>
            )}
            {checklist.skipped > 0 && (
              <span className="text-slate">{checklist.skipped} skipped</span>
            )}
            {checklist.pending > 0 && (
              <span className="text-warning">{checklist.pending} pending</span>
            )}
          </div>

          {/* Progress bar */}
          <div className="w-full h-2 bg-charcoal/10 rounded-full overflow-hidden mb-4">
            <div
              className="h-full bg-success rounded-full transition-all duration-500"
              style={{ width: `${passedPercent}%` }}
            />
          </div>

          {/* Gate items */}
          <div className="space-y-2 max-h-[400px] overflow-y-auto terminal-scroll">
            {checklist.items.map((item) => (
              <GateItem key={item.id} item={item} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
