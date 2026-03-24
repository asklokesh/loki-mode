import { useState, useEffect } from 'react';
import { DollarSign, Clock, Zap } from 'lucide-react';
import { AnimatedCounter } from './AnimatedCounter';
import { ProgressRing } from './ProgressRing';
import { useState, useEffect, useRef } from 'react';
import {
  DollarSign, Clock, Zap,
  Compass, Hammer, TestTube2, Search, CheckCircle2, Loader2,
} from 'lucide-react';

// B21: Smooth CSS transitions between build phases
// B22: Phase icons that animate (spin on active, checkmark on complete)

interface BuildProgressBarProps {
  phase: string;       // 'planning' | 'building' | 'testing' | 'reviewing' | 'complete' | 'idle'
  iteration: number;
  maxIterations: number;
  cost: number;        // dollars spent
  startTime: number;   // timestamp when build started
  isRunning: boolean;
}

const phases = [
  { id: 'planning', label: 'Plan', color: 'bg-blue-500', textColor: 'text-blue-500', icon: Compass },
  { id: 'building', label: 'Build', color: 'bg-primary', textColor: 'text-primary', icon: Hammer },
  { id: 'testing', label: 'Test', color: 'bg-teal', textColor: 'text-teal', icon: TestTube2 },
  { id: 'reviewing', label: 'Review', color: 'bg-warning', textColor: 'text-warning', icon: Search },
  { id: 'complete', label: 'Done', color: 'bg-success', textColor: 'text-success', icon: CheckCircle2 },
];

export function BuildProgressBar({ phase, iteration, maxIterations, cost, startTime, isRunning }: BuildProgressBarProps) {
  const [elapsed, setElapsed] = useState(0);
  const [prevPhase, setPrevPhase] = useState(phase);
  const [transitioning, setTransitioning] = useState(false);

  useEffect(() => {
    if (!isRunning || !startTime) return;
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [isRunning, startTime]);

  // B21: Detect phase transitions for smooth animation
  useEffect(() => {
    if (phase !== prevPhase) {
      setTransitioning(true);
      const timer = setTimeout(() => {
        setPrevPhase(phase);
        setTransitioning(false);
      }, 400);
      return () => clearTimeout(timer);
    }
  }, [phase, prevPhase]);

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
    <div className="flex-shrink-0 build-progress-container">
      {/* Progress bar */}
      <div className="h-1 bg-border relative overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-primary to-teal build-progress-bar"
          style={{ width: `${progress}%` }}
        />
        {isRunning && (
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer" />
        )}
      </div>

      {/* D45: Phase labels + stats with glassmorphism */}
      <div className="px-4 py-1.5 flex items-center gap-4 glass-card border-b border-border text-xs rounded-none">
        {/* Phase indicators */}
      {/* Phase labels + stats */}
      <div className={`px-4 py-1.5 flex items-center gap-4 bg-card border-b border-border text-xs ${
        transitioning ? 'phase-transitioning' : ''
      }`}>
        {/* Phase indicators with icons */}
        <div className="flex items-center gap-1">
          {phases.map((p, i) => {
            const isComplete = i < currentPhaseIndex;
            const isCurrent = i === currentPhaseIndex;
            const isPending = i > currentPhaseIndex;
            const PhaseIcon = p.icon;

            return (
              <div key={p.id} className={`flex items-center gap-1 phase-indicator ${
                isCurrent ? 'phase-indicator-active' : ''
              } ${isComplete ? 'phase-indicator-complete' : ''}`}>
                {/* B22: Phase icon with animation */}
                <div className={`phase-icon-wrapper ${
                  isCurrent ? 'phase-icon-active' : ''
                } ${isComplete ? 'phase-icon-complete' : ''}`}>
                  {isComplete ? (
                    <CheckCircle2 size={14} className="text-success phase-check-enter" />
                  ) : isCurrent ? (
                    <PhaseIcon size={14} className={`${p.textColor} phase-icon-spin`} />
                  ) : (
                    <PhaseIcon size={14} className="text-muted/40" />
                  )}
                </div>
                <span className={`text-[11px] font-medium transition-all duration-300 ${
                  isCurrent ? 'text-ink' :
                  isComplete ? 'text-success' :
                  'text-muted/50'
                }`}>{p.label}</span>
                {i < phases.length - 1 && (
                  <div className={`mx-1 h-px w-4 transition-all duration-500 ${
                    isComplete ? 'bg-success' : 'bg-border'
                  }`} />
                )}
              </div>
            );
          })}
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
