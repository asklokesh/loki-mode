import { useState, useEffect, useRef } from 'react';
import { Trophy, Zap, DollarSign, Shield, Clock, Star } from 'lucide-react';

interface ProviderProgress {
  provider: string;
  label: string;
  progress: number; // 0-100
  phase: string;
  iteration: number;
  maxIterations: number;
  cost: number;
  qualityScore: number; // 0-100
  finished: boolean;
  finishTime?: number; // seconds
  color: string;
}

interface ProviderRaceProps {
  /** Whether the race is actively running */
  active: boolean;
  /** CSS class names */
  className?: string;
}

// Mock data generator for demo purposes -- designed for future backend integration
function createMockProviders(): ProviderProgress[] {
  return [
    {
      provider: 'claude',
      label: 'Claude (Sonnet)',
      progress: 0,
      phase: 'planning',
      iteration: 0,
      maxIterations: 8,
      cost: 0,
      qualityScore: 0,
      finished: false,
      color: 'bg-primary',
    },
    {
      provider: 'codex',
      label: 'Codex (GPT-4o)',
      progress: 0,
      phase: 'planning',
      iteration: 0,
      maxIterations: 10,
      cost: 0,
      qualityScore: 0,
      finished: false,
      color: 'bg-teal',
    },
    {
      provider: 'gemini',
      label: 'Gemini Pro',
      progress: 0,
      phase: 'planning',
      iteration: 0,
      maxIterations: 12,
      cost: 0,
      qualityScore: 0,
      finished: false,
      color: 'bg-info',
    },
  ];
}

const phaseOrder = ['planning', 'building', 'testing', 'reviewing', 'complete'];

function getPhaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    planning: 'Plan',
    building: 'Build',
    testing: 'Test',
    reviewing: 'Review',
    complete: 'Done',
  };
  return labels[phase] || phase;
}

function RaceBar({ provider, winner }: { provider: ProviderProgress; winner: string | null }) {
  const isWinner = winner === provider.provider;
  const isLoser = winner !== null && !isWinner && provider.finished;

  return (
    <div className={`p-3 rounded-card border transition-all ${
      isWinner ? 'border-success bg-success/5 shadow-sm' :
      isLoser ? 'border-border bg-hover/30 opacity-60' :
      'border-border bg-card'
    }`}>
      {/* Provider header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {isWinner && <Trophy size={14} className="text-success" />}
          <span className={`text-xs font-semibold ${isWinner ? 'text-success' : 'text-ink'}`}>
            {provider.label}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted">
          <span className="font-mono">{getPhaseLabel(provider.phase)}</span>
          <span className="font-mono">
            {provider.iteration}/{provider.maxIterations}
          </span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="relative w-full h-3 bg-border rounded-full overflow-hidden mb-2">
        <div
          className={`h-full rounded-full transition-all duration-500 ease-out ${provider.color}`}
          style={{ width: `${provider.progress}%` }}
        />
        {!provider.finished && provider.progress > 0 && (
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer" />
        )}
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-3 text-[11px]">
        <span className="flex items-center gap-1 text-muted">
          <DollarSign size={10} />
          <span className="font-mono">${provider.cost.toFixed(2)}</span>
        </span>
        <span className="flex items-center gap-1 text-muted">
          <Shield size={10} />
          <span className="font-mono">{provider.qualityScore}%</span>
        </span>
        {provider.finishTime && (
          <span className="flex items-center gap-1 text-muted">
            <Clock size={10} />
            <span className="font-mono">{provider.finishTime}s</span>
          </span>
        )}
        {isWinner && (
          <span className="flex items-center gap-1 text-success font-medium ml-auto">
            <Star size={10} />
            Winner
          </span>
        )}
      </div>
    </div>
  );
}

function ComparisonTable({ providers }: { providers: ProviderProgress[] }) {
  const finished = providers.filter(p => p.finished);
  if (finished.length < 2) return null;

  const sorted = [...finished].sort((a, b) => {
    // Sort by quality first, then speed
    if (Math.abs(a.qualityScore - b.qualityScore) > 5) return b.qualityScore - a.qualityScore;
    return (a.finishTime || 999) - (b.finishTime || 999);
  });

  return (
    <div className="mt-3 bg-hover/30 rounded-card p-3">
      <div className="text-[11px] font-semibold text-muted uppercase tracking-wider mb-2">
        Comparison
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-muted text-left">
              <th className="pb-1.5 font-medium">Provider</th>
              <th className="pb-1.5 font-medium text-right">Speed</th>
              <th className="pb-1.5 font-medium text-right">Quality</th>
              <th className="pb-1.5 font-medium text-right">Cost</th>
              <th className="pb-1.5 font-medium text-right">Value</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((p, i) => {
              const valueScore = p.qualityScore / Math.max(p.cost, 0.01);
              return (
                <tr key={p.provider} className={i === 0 ? 'text-ink font-medium' : 'text-secondary'}>
                  <td className="py-1">{p.label}</td>
                  <td className="py-1 text-right font-mono">{p.finishTime || '--'}s</td>
                  <td className="py-1 text-right font-mono">{p.qualityScore}%</td>
                  <td className="py-1 text-right font-mono">${p.cost.toFixed(2)}</td>
                  <td className="py-1 text-right font-mono">{valueScore.toFixed(0)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ProviderRace({ active, className = '' }: ProviderRaceProps) {
  const [providers, setProviders] = useState<ProviderProgress[]>(createMockProviders);
  const [winner, setWinner] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Simulate race progress with mock data
  useEffect(() => {
    if (!active) return;

    // Reset
    setProviders(createMockProviders());
    setWinner(null);
    setElapsed(0);

    intervalRef.current = setInterval(() => {
      setElapsed(prev => prev + 1);
      setProviders(prev => {
        const updated = prev.map(p => {
          if (p.finished) return p;

          // Different speeds for each provider (simulate real behavior)
          const speedMultiplier = p.provider === 'claude' ? 1.3 :
            p.provider === 'codex' ? 1.1 : 0.9;
          const progressInc = (Math.random() * 3 + 1) * speedMultiplier;
          const newProgress = Math.min(p.progress + progressInc, 100);

          // Update phase based on progress
          const phaseIdx = Math.min(
            Math.floor((newProgress / 100) * phaseOrder.length),
            phaseOrder.length - 1
          );
          const newPhase = phaseOrder[phaseIdx];

          // Update iteration
          const newIter = Math.min(
            Math.ceil((newProgress / 100) * p.maxIterations),
            p.maxIterations
          );

          // Cost increases with iterations
          const costRate = p.provider === 'claude' ? 0.12 :
            p.provider === 'codex' ? 0.08 : 0.05;
          const newCost = newIter * costRate;

          // Quality score builds up
          const baseQuality = p.provider === 'claude' ? 92 :
            p.provider === 'codex' ? 88 : 85;
          const qualityNoise = Math.floor(Math.random() * 6 - 3);
          const newQuality = Math.min(
            Math.floor((newProgress / 100) * (baseQuality + qualityNoise)),
            baseQuality + 3
          );

          const finished = newProgress >= 100;

          return {
            ...p,
            progress: newProgress,
            phase: finished ? 'complete' : newPhase,
            iteration: newIter,
            cost: Number(newCost.toFixed(2)),
            qualityScore: newQuality,
            finished,
            finishTime: finished && !p.finishTime ? elapsed + 1 : p.finishTime,
          };
        });

        // Detect winner
        const firstFinished = updated.find(p => p.finished && !p.finishTime);
        if (firstFinished) {
          // Winner was already set in the map above
        }

        return updated;
      });
    }, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [active]);

  // Detect winner
  useEffect(() => {
    if (winner) return;
    const firstDone = providers.find(p => p.finished);
    if (firstDone) {
      setWinner(firstDone.provider);
      // Stop the race after all finish or after a delay
      setTimeout(() => {
        if (intervalRef.current) clearInterval(intervalRef.current);
      }, 10000);
    }
  }, [providers, winner]);

  const allFinished = providers.every(p => p.finished);

  return (
    <div className={`card overflow-hidden ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <Trophy size={14} className="text-warning" />
          <h3 className="text-sm font-semibold text-ink uppercase tracking-wider">
            Provider Race
          </h3>
          {active && !allFinished && (
            <span className="text-[11px] text-primary font-medium bg-primary/8 px-2 py-0.5 rounded-pill animate-pulse">
              LIVE
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted">
          <Clock size={12} />
          <span className="font-mono">{elapsed}s</span>
        </div>
      </div>

      {/* Description */}
      <div className="px-4 py-2 bg-hover/30 border-b border-border">
        <p className="text-[11px] text-muted">
          {active
            ? 'Multiple providers building simultaneously. First to finish with quality wins.'
            : 'Start a build to see providers race against each other.'
          }
        </p>
      </div>

      {/* Race bars */}
      <div className="p-4 space-y-2">
        {providers.map(p => (
          <RaceBar key={p.provider} provider={p} winner={winner} />
        ))}
      </div>

      {/* Comparison table after race */}
      {allFinished && (
        <div className="px-4 pb-4">
          <ComparisonTable providers={providers} />
        </div>
      )}

      {/* Winner announcement */}
      {winner && allFinished && (
        <div className="px-4 pb-3 text-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-success/10 border border-success/20 rounded-pill">
            <Trophy size={14} className="text-success" />
            <span className="text-sm font-semibold text-success">
              {providers.find(p => p.provider === winner)?.label} wins!
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
