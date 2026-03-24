import { useState } from 'react';
import { DollarSign, Zap, Clock, TrendingDown, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from './ui/Button';

interface CostBreakdown {
  phase: string;
  label: string;
  estimatedCost: number;
  estimatedTokens: number;
}

interface CostEstimatorProps {
  /** Project complexity: simple, standard, complex */
  complexity: 'simple' | 'standard' | 'complex';
  /** Provider name */
  provider: string;
  /** Template type for comparison data */
  templateType?: string;
  /** Estimated iterations */
  estimatedIterations: number;
  /** Callback when user confirms to proceed */
  onConfirm: () => void;
  /** Callback when user cancels */
  onCancel: () => void;
  /** Average cost from similar past projects */
  historicalAvgCost?: number;
}

const PROVIDER_RATES: Record<string, { input: number; output: number; label: string }> = {
  claude: { input: 0.003, output: 0.015, label: 'Claude (Sonnet)' },
  codex: { input: 0.002, output: 0.008, label: 'Codex (GPT-4o)' },
  gemini: { input: 0.00125, output: 0.005, label: 'Gemini Pro' },
};

const COMPLEXITY_MULTIPLIERS: Record<string, { tokens: number; label: string; iters: number }> = {
  simple: { tokens: 50_000, label: 'Simple', iters: 3 },
  standard: { tokens: 150_000, label: 'Standard', iters: 8 },
  complex: { tokens: 400_000, label: 'Complex', iters: 15 },
};

function estimateCosts(
  complexity: string,
  provider: string,
  estimatedIterations: number,
): { total: { low: number; high: number }; breakdown: CostBreakdown[]; totalTokens: number; estimatedTime: string } {
  const rates = PROVIDER_RATES[provider] || PROVIDER_RATES.claude;
  const comp = COMPLEXITY_MULTIPLIERS[complexity] || COMPLEXITY_MULTIPLIERS.standard;
  const iters = estimatedIterations || comp.iters;

  // Token estimation by phase
  const phaseDistribution = [
    { phase: 'planning', label: 'Planning', pct: 0.15 },
    { phase: 'building', label: 'Building', pct: 0.55 },
    { phase: 'testing', label: 'Testing', pct: 0.20 },
    { phase: 'reviewing', label: 'Review', pct: 0.10 },
  ];

  const baseTokens = comp.tokens * (iters / comp.iters);
  const totalTokens = Math.round(baseTokens);

  const breakdown: CostBreakdown[] = phaseDistribution.map(p => {
    const phaseTokens = Math.round(totalTokens * p.pct);
    // Assume 40% input, 60% output distribution
    const inputTokens = phaseTokens * 0.4;
    const outputTokens = phaseTokens * 0.6;
    const cost = (inputTokens * rates.input + outputTokens * rates.output) / 1000;
    return {
      phase: p.phase,
      label: p.label,
      estimatedCost: cost,
      estimatedTokens: phaseTokens,
    };
  });

  const totalCost = breakdown.reduce((s, b) => s + b.estimatedCost, 0);

  // Time estimate: ~20-40 seconds per iteration depending on complexity
  const secsPerIter = complexity === 'complex' ? 40 : complexity === 'simple' ? 15 : 25;
  const totalSecs = iters * secsPerIter;
  const estimatedTime = totalSecs < 60
    ? `${totalSecs}s`
    : totalSecs < 3600
    ? `${Math.round(totalSecs / 60)}min`
    : `${(totalSecs / 3600).toFixed(1)}hr`;

  return {
    total: { low: totalCost * 0.7, high: totalCost * 1.4 },
    breakdown,
    totalTokens,
    estimatedTime,
  };
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(0)}K`;
  return String(count);
}

export function CostEstimator({
  complexity,
  provider,
  templateType,
  estimatedIterations,
  onConfirm,
  onCancel,
  historicalAvgCost,
}: CostEstimatorProps) {
  const [showBreakdown, setShowBreakdown] = useState(false);
  const estimate = estimateCosts(complexity, provider, estimatedIterations);
  const rates = PROVIDER_RATES[provider] || PROVIDER_RATES.claude;
  const comp = COMPLEXITY_MULTIPLIERS[complexity] || COMPLEXITY_MULTIPLIERS.standard;

  const isExpensive = estimate.total.high > 5;

  return (
    <div className="card overflow-hidden max-w-md mx-auto">
      {/* Header */}
      <div className="px-5 pt-5 pb-3">
        <div className="flex items-center gap-2 mb-1">
          <DollarSign size={18} className="text-primary" />
          <h3 className="text-sm font-semibold text-ink uppercase tracking-wider">
            Build Cost Estimate
          </h3>
        </div>
        <p className="text-xs text-muted">
          Estimated cost before starting your build
        </p>
      </div>

      {/* Main estimate */}
      <div className="px-5 py-4">
        <div className="text-center mb-4">
          <div className="text-3xl font-bold font-mono text-ink tracking-tight">
            ${estimate.total.low.toFixed(2)} -- ${estimate.total.high.toFixed(2)}
          </div>
          <p className="text-xs text-muted mt-1">Estimated total cost</p>
        </div>

        {/* Key stats */}
        <div className="grid grid-cols-3 gap-3 text-center">
          <div className="bg-hover/50 rounded-card px-2 py-2">
            <Zap size={14} className="text-primary mx-auto mb-1" />
            <div className="text-xs font-mono font-semibold text-ink">
              {formatTokens(estimate.totalTokens)}
            </div>
            <div className="text-[11px] text-muted">Tokens</div>
          </div>
          <div className="bg-hover/50 rounded-card px-2 py-2">
            <Clock size={14} className="text-info mx-auto mb-1" />
            <div className="text-xs font-mono font-semibold text-ink">
              {estimate.estimatedTime}
            </div>
            <div className="text-[11px] text-muted">Est. Time</div>
          </div>
          <div className="bg-hover/50 rounded-card px-2 py-2">
            <Zap size={14} className="text-warning mx-auto mb-1" />
            <div className="text-xs font-mono font-semibold text-ink">
              {estimatedIterations || comp.iters}
            </div>
            <div className="text-[11px] text-muted">Iterations</div>
          </div>
        </div>
      </div>

      {/* Configuration summary */}
      <div className="px-5 py-2 bg-hover/30 border-t border-b border-border">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted">Provider</span>
          <span className="font-medium text-ink">{rates.label}</span>
        </div>
        <div className="flex items-center justify-between text-xs mt-1">
          <span className="text-muted">Complexity</span>
          <span className="font-medium text-ink">{comp.label}</span>
        </div>
        {templateType && (
          <div className="flex items-center justify-between text-xs mt-1">
            <span className="text-muted">Template</span>
            <span className="font-medium text-ink">{templateType}</span>
          </div>
        )}
      </div>

      {/* Historical comparison */}
      {historicalAvgCost !== undefined && historicalAvgCost > 0 && (
        <div className="px-5 py-2.5 bg-primary/5 border-b border-border">
          <div className="flex items-center gap-1.5 text-xs">
            <TrendingDown size={12} className="text-primary" />
            <span className="text-secondary">
              Similar projects cost <span className="font-mono font-semibold text-ink">${historicalAvgCost.toFixed(2)}</span> on average
            </span>
          </div>
        </div>
      )}

      {/* Phase breakdown */}
      <div className="px-5 py-2">
        <button
          onClick={() => setShowBreakdown(!showBreakdown)}
          className="flex items-center gap-1.5 w-full text-xs font-medium text-primary py-1.5"
        >
          {showBreakdown ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          Cost breakdown by phase
        </button>

        {showBreakdown && (
          <div className="space-y-2 mt-1 mb-2">
            {estimate.breakdown.map(b => (
              <div key={b.phase} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-secondary">{b.label}</span>
                  <span className="text-[11px] text-muted font-mono">
                    {formatTokens(b.estimatedTokens)} tokens
                  </span>
                </div>
                <span className="text-xs font-mono font-semibold text-ink">
                  ${b.estimatedCost.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Warning for expensive builds */}
      {isExpensive && (
        <div className="px-5 py-2 bg-warning/8 border-t border-warning/15">
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} className="text-warning mt-0.5 flex-shrink-0" />
            <p className="text-xs text-secondary">
              This build may be expensive. Consider using a simpler complexity level
              or a more cost-effective provider.
            </p>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={onConfirm} icon={Zap}>
          Start Build
        </Button>
      </div>
    </div>
  );
}
