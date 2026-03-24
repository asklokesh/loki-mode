import { useState, useEffect } from 'react';
import { DollarSign, Clock, Zap } from 'lucide-react';
import { AnimatedCounter } from './AnimatedCounter';
import { ProgressRing } from './ProgressRing';

interface BuildProgressBarProps {
  phase: string;       // 'planning' | 'building' | 'testing' | 'reviewing' | 'complete' | 'idle'
  iteration: number;
  maxIterations: number;
  cost: number;        // dollars spent
  startTime: number;   // timestamp when build started
  isRunning: boolean;
}

const phases = [
  { id: 'planning', label: 'Plan', color: 'bg-blue-500' },
  { id: 'building', label: 'Build', color: 'bg-primary' },
  { id: 'testing', label: 'Test', color: 'bg-teal' },
  { id: 'reviewing', label: 'Review', color: 'bg-warning' },
  { id: 'complete', label: 'Done', color: 'bg-success' },
];

export function BuildProgressBar({ phase, iteration, maxIterations, cost, startTime, isRunning }: BuildProgressBarProps) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!isRunning || !startTime) return;
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [isRunning, startTime]);

  if (!isRunning && phase === 'idle') return null;

  const currentPhaseIndex = phases.findIndex(p => p.id === phase);
  const progress = maxIterations > 0 ? Math.min((iteration / maxIterations) * 100, 100) : 0;

  // ETA: average time per iteration * remaining iterations
  const avgTimePerIter = iteration > 0 ? elapsed / iteration : 60;
  const remainingIters = Math.max(0, maxIterations - iteration);
  const eta = Math.ceil(avgTimePerIter * remainingIters);

  const formatTime = (seconds: number) => {
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  };

  return (
    <div className="flex-shrink-0">
      {/* Progress bar */}
      <div className="h-1 bg-border relative overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-primary to-teal transition-all duration-1000 ease-out"
          style={{ width: `${progress}%` }}
        />
        {isRunning && (
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer" />
        )}
      </div>

      {/* D45: Phase labels + stats with glassmorphism */}
      <div className="px-4 py-1.5 flex items-center gap-4 glass-card border-b border-border text-xs rounded-none">
        {/* Phase indicators */}
        <div className="flex items-center gap-1">
          {phases.map((p, i) => (
            <div key={p.id} className="flex items-center gap-1">
              <div className={`w-2 h-2 rounded-full transition-colors ${
                i < currentPhaseIndex ? 'bg-success' :
                i === currentPhaseIndex ? `${p.color} animate-pulse` :
                'bg-border'
              }`} />
              <span className={`text-[11px] font-medium ${
                i === currentPhaseIndex ? 'text-ink' : 'text-muted'
              }`}>{p.label}</span>
              {i < phases.length - 1 && <span className="text-border mx-0.5">--</span>}
            </div>
          ))}
        </div>

        <div className="flex-1" />

        {/* D49: Progress ring for build percentage */}
        {isRunning && (
          <ProgressRing percentage={progress} size={24} strokeWidth={3}>
            <span className="text-[8px] font-bold text-ink">{Math.round(progress)}</span>
          </ProgressRing>
        )}

        {/* Stats with animated counter for cost (D48) */}
        <div className="flex items-center gap-3 text-muted">
          <span className="flex items-center gap-1">
            <Zap size={12} />
            Iter <AnimatedCounter target={iteration} duration={400} />/{maxIterations}
          </span>
          <span className="flex items-center gap-1">
            <Clock size={12} />
            {formatTime(elapsed)}
            {isRunning && eta > 0 && <span className="text-muted/60">({formatTime(eta)} left)</span>}
          </span>
          <span className="flex items-center gap-1">
            <DollarSign size={12} />
            <AnimatedCounter target={cost} duration={600} prefix="$" decimals={2} />
          </span>
        </div>
      </div>
    </div>
  );
}
