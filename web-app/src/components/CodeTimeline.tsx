import { useState, useMemo } from 'react';
import { GitCommit, ChevronLeft, ChevronRight, FileCode2, Plus, Minus, ArrowRight } from 'lucide-react';

interface IterationChange {
  iteration: number;
  timestamp?: string;
  files: Array<{
    path: string;
    additions: number;
    deletions: number;
    action: 'add' | 'modify' | 'delete';
  }>;
  description?: string;
}

interface CodeTimelineProps {
  /** File path to show evolution for */
  filePath: string;
  /** Changes across iterations */
  iterations: IterationChange[];
  /** CSS class names */
  className?: string;
}

function ChangeIndicator({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  if (total === 0) return null;

  const addPct = total > 0 ? (additions / total) * 100 : 0;

  return (
    <div className="flex items-center gap-1.5">
      <div className="flex items-center gap-0.5">
        {additions > 0 && (
          <span className="text-[11px] font-mono text-success flex items-center gap-0.5">
            <Plus size={10} />{additions}
          </span>
        )}
        {deletions > 0 && (
          <span className="text-[11px] font-mono text-danger flex items-center gap-0.5">
            <Minus size={10} />{deletions}
          </span>
        )}
      </div>
      <div className="w-16 h-1.5 bg-border rounded-full overflow-hidden flex">
        <div className="h-full bg-success" style={{ width: `${addPct}%` }} />
        <div className="h-full bg-danger" style={{ width: `${100 - addPct}%` }} />
      </div>
    </div>
  );
}

function IterationCard({
  change,
  isSelected,
  onClick,
}: {
  change: IterationChange;
  isSelected: boolean;
  onClick: () => void;
}) {
  const fileForPath = change.files[0]; // Primary file change
  const totalAdditions = change.files.reduce((s, f) => s + f.additions, 0);
  const totalDeletions = change.files.reduce((s, f) => s + f.deletions, 0);

  return (
    <button
      onClick={onClick}
      className={`flex-shrink-0 w-40 rounded-card border p-2.5 text-left transition-all cursor-pointer ${
        isSelected
          ? 'border-primary bg-primary/5 shadow-sm'
          : 'border-border bg-card hover:border-primary/30 hover:bg-hover/50'
      }`}
    >
      <div className="flex items-center gap-1.5 mb-1.5">
        <GitCommit size={12} className={isSelected ? 'text-primary' : 'text-muted'} />
        <span className={`text-xs font-semibold ${isSelected ? 'text-primary' : 'text-ink'}`}>
          Iteration {change.iteration}
        </span>
      </div>

      {change.description && (
        <p className="text-[11px] text-muted leading-relaxed truncate mb-1.5">
          {change.description}
        </p>
      )}

      <ChangeIndicator additions={totalAdditions} deletions={totalDeletions} />

      <div className="text-[11px] text-muted mt-1">
        {change.files.length} file{change.files.length !== 1 ? 's' : ''} changed
      </div>
    </button>
  );
}

export function CodeTimeline({ filePath, iterations, className = '' }: CodeTimelineProps) {
  const [selectedIndex, setSelectedIndex] = useState(iterations.length > 0 ? iterations.length - 1 : 0);

  // Filter iterations that affect the target file (or show all if no filePath filter)
  const relevantIterations = useMemo(() => {
    if (!filePath) return iterations;
    return iterations.filter(iter =>
      iter.files.some(f => f.path === filePath || f.path.endsWith(filePath))
    );
  }, [iterations, filePath]);

  const selected = relevantIterations[selectedIndex];
  const hasNext = selectedIndex < relevantIterations.length - 1;
  const hasPrev = selectedIndex > 0;

  if (relevantIterations.length === 0) {
    return (
      <div className={`card p-4 ${className}`}>
        <div className="flex items-center gap-2 mb-3">
          <GitCommit size={14} className="text-primary" />
          <h3 className="text-sm font-semibold text-ink uppercase tracking-wider">
            Code Evolution
          </h3>
        </div>
        <div className="text-center py-6">
          <p className="text-sm text-muted">No iteration history available</p>
          <p className="text-xs text-muted/60 mt-1">Changes will appear here as the AI iterates</p>
        </div>
      </div>
    );
  }

  const approachCount = relevantIterations.filter(iter =>
    iter.files.some(f => f.action === 'modify' && (f.additions + f.deletions) > 20)
  ).length;

  return (
    <div className={`card overflow-hidden ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <GitCommit size={14} className="text-primary" />
          <h3 className="text-sm font-semibold text-ink uppercase tracking-wider">
            Code Evolution
          </h3>
          {filePath && (
            <span className="text-[11px] text-muted font-mono truncate max-w-[200px]">
              {filePath.split('/').pop()}
            </span>
          )}
        </div>
        {approachCount > 1 && (
          <span className="text-[11px] text-primary font-medium bg-primary/8 px-2 py-0.5 rounded-pill">
            {approachCount} approaches tried
          </span>
        )}
      </div>

      {/* Film strip timeline */}
      <div className="relative px-4 py-3 bg-hover/30">
        <div className="flex items-center gap-2">
          <button
            onClick={() => hasPrev && setSelectedIndex(selectedIndex - 1)}
            disabled={!hasPrev}
            className={`p-1 rounded-card transition-colors flex-shrink-0 ${
              hasPrev ? 'hover:bg-hover text-ink' : 'text-border cursor-not-allowed'
            }`}
          >
            <ChevronLeft size={16} />
          </button>

          <div className="flex gap-2 overflow-x-auto terminal-scroll flex-1 pb-1">
            {relevantIterations.map((iter, i) => (
              <IterationCard
                key={iter.iteration}
                change={iter}
                isSelected={i === selectedIndex}
                onClick={() => setSelectedIndex(i)}
              />
            ))}
          </div>

          <button
            onClick={() => hasNext && setSelectedIndex(selectedIndex + 1)}
            disabled={!hasNext}
            className={`p-1 rounded-card transition-colors flex-shrink-0 ${
              hasNext ? 'hover:bg-hover text-ink' : 'text-border cursor-not-allowed'
            }`}
          >
            <ChevronRight size={16} />
          </button>
        </div>

        {/* Position indicator */}
        <div className="flex items-center justify-center gap-1 mt-2">
          {relevantIterations.map((_, i) => (
            <div
              key={i}
              className={`h-1 rounded-full transition-all ${
                i === selectedIndex ? 'w-4 bg-primary' : 'w-1.5 bg-border'
              }`}
            />
          ))}
        </div>
      </div>

      {/* Selected iteration detail */}
      {selected && (
        <div className="px-4 py-3 border-t border-border">
          {selected.description && (
            <p className="text-xs text-secondary mb-2">{selected.description}</p>
          )}

          <div className="space-y-1.5">
            {selected.files.map((f, i) => (
              <div
                key={`${f.path}-${i}`}
                className="flex items-center justify-between py-1 text-xs"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <FileCode2 size={12} className={
                    f.action === 'add' ? 'text-success' :
                    f.action === 'delete' ? 'text-danger' :
                    'text-info'
                  } />
                  <span className="font-mono text-secondary truncate">{f.path}</span>
                  <span className={`text-[11px] font-medium uppercase ${
                    f.action === 'add' ? 'text-success' :
                    f.action === 'delete' ? 'text-danger' :
                    'text-info'
                  }`}>
                    {f.action}
                  </span>
                </div>
                <ChangeIndicator additions={f.additions} deletions={f.deletions} />
              </div>
            ))}
          </div>

          {/* Before/after navigation hint */}
          {hasPrev && hasNext && (
            <div className="flex items-center justify-center gap-1.5 mt-3 text-[11px] text-muted">
              <span>Iteration {relevantIterations[selectedIndex - 1]?.iteration}</span>
              <ArrowRight size={10} />
              <span className="font-semibold text-ink">Iteration {selected.iteration}</span>
              <ArrowRight size={10} />
              <span>Iteration {relevantIterations[selectedIndex + 1]?.iteration}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
