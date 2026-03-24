import { useState, useMemo } from 'react';
import {
  BarChart3, FileCode2, Code2, TestTube2, Zap, Clock, Shield,
  Share2, ChevronDown, ChevronUp, TrendingUp, Layers
} from 'lucide-react';

interface PhaseBreakdown {
  phase: string;
  label: string;
  durationSecs: number;
  tokenCount: number;
  percentage: number;
}

interface BuildInsightsProps {
  /** Number of files created */
  filesCreated: number;
  /** Number of files modified */
  filesModified: number;
  /** Total lines of code generated */
  linesGenerated: number;
  /** Number of tests generated */
  testsGenerated: number;
  /** Test pass rate (0-1) */
  testPassRate: number;
  /** Total token usage */
  totalTokens: number;
  /** Token breakdown by phase */
  phaseBreakdown: PhaseBreakdown[];
  /** Total build time in seconds */
  totalTimeSecs: number;
  /** Quality gate score (0-100) */
  qualityScore: number;
  /** Total cost in dollars */
  totalCost: number;
  /** Number of iterations */
  iterations: number;
  /** Provider used */
  provider: string;
  /** Callback for sharing insights */
  onShare?: (summary: string) => void;
  /** CSS class names */
  className?: string;
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

function formatTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function formatLinesOfCode(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
  return String(count);
}

function getQualityLabel(score: number): { label: string; color: string } {
  if (score >= 90) return { label: 'Excellent', color: 'text-success' };
  if (score >= 75) return { label: 'Good', color: 'text-teal' };
  if (score >= 60) return { label: 'Fair', color: 'text-warning' };
  return { label: 'Needs Work', color: 'text-danger' };
}

interface StatCardProps {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: string;
  subtext?: string;
  iconColor?: string;
}

function StatCard({ icon: Icon, label, value, subtext, iconColor = 'text-primary' }: StatCardProps) {
  return (
    <div className="bg-hover/40 rounded-card p-3 flex flex-col items-center text-center">
      <Icon size={18} className={`${iconColor} mb-1.5`} />
      <div className="text-lg font-bold font-mono text-ink leading-tight">{value}</div>
      <div className="text-[11px] text-muted font-medium mt-0.5">{label}</div>
      {subtext && (
        <div className="text-[11px] text-muted/60 mt-0.5">{subtext}</div>
      )}
    </div>
  );
}

function PhaseBar({ phase, maxDuration }: { phase: PhaseBreakdown; maxDuration: number }) {
  const widthPct = maxDuration > 0 ? (phase.durationSecs / maxDuration) * 100 : 0;

  const phaseColors: Record<string, string> = {
    planning: 'bg-info',
    building: 'bg-primary',
    testing: 'bg-teal',
    reviewing: 'bg-warning',
  };

  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-secondary w-16 text-right flex-shrink-0">{phase.label}</span>
      <div className="flex-1 h-4 bg-border rounded-sm overflow-hidden relative">
        <div
          className={`h-full rounded-sm transition-all duration-700 ease-out ${phaseColors[phase.phase] || 'bg-primary'}`}
          style={{ width: `${widthPct}%` }}
        />
        <span className="absolute inset-0 flex items-center px-2 text-[10px] font-mono text-white mix-blend-difference">
          {formatTime(phase.durationSecs)} | {formatTokens(phase.tokenCount)} tokens
        </span>
      </div>
      <span className="text-[11px] font-mono text-muted w-10 text-right flex-shrink-0">
        {Math.round(phase.percentage)}%
      </span>
    </div>
  );
}

export function BuildInsights({
  filesCreated,
  filesModified,
  linesGenerated,
  testsGenerated,
  testPassRate,
  totalTokens,
  phaseBreakdown,
  totalTimeSecs,
  qualityScore,
  totalCost,
  iterations,
  provider,
  onShare,
  className = '',
}: BuildInsightsProps) {
  const [expanded, setExpanded] = useState(true);
  const quality = getQualityLabel(qualityScore);
  const maxPhaseDuration = Math.max(...phaseBreakdown.map(p => p.durationSecs), 1);

  const handleShare = () => {
    const summary = [
      'Build Insights Summary',
      '=====================',
      `Provider: ${provider}`,
      `Total Time: ${formatTime(totalTimeSecs)}`,
      `Iterations: ${iterations}`,
      `Cost: $${totalCost.toFixed(2)}`,
      '',
      'Output:',
      `  Files Created: ${filesCreated}`,
      `  Files Modified: ${filesModified}`,
      `  Lines Generated: ${linesGenerated}`,
      `  Tests Generated: ${testsGenerated}`,
      `  Test Pass Rate: ${Math.round(testPassRate * 100)}%`,
      '',
      'Resources:',
      `  Total Tokens: ${formatTokens(totalTokens)}`,
      `  Quality Score: ${qualityScore}/100 (${quality.label})`,
      '',
      'Time Breakdown:',
      ...phaseBreakdown.map(p => `  ${p.label}: ${formatTime(p.durationSecs)} (${Math.round(p.percentage)}%)`),
    ].join('\n');
    onShare?.(summary);
  };

  return (
    <div className={`card overflow-hidden ${className}`}>
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-hover/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          <BarChart3 size={14} className="text-primary" />
          <h3 className="text-sm font-semibold text-ink uppercase tracking-wider">
            Build Insights
          </h3>
          <span className={`text-[11px] font-medium px-2 py-0.5 rounded-pill ${
            qualityScore >= 80 ? 'bg-success/10 text-success' :
            qualityScore >= 60 ? 'bg-warning/10 text-warning' :
            'bg-danger/10 text-danger'
          }`}>
            {quality.label}
          </span>
        </div>
        <span className="text-muted">
          {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-4">
          {/* Stat cards grid */}
          <div className="grid grid-cols-3 gap-2">
            <StatCard
              icon={FileCode2}
              label="Files"
              value={String(filesCreated + filesModified)}
              subtext={`${filesCreated} new, ${filesModified} modified`}
              iconColor="text-primary"
            />
            <StatCard
              icon={Code2}
              label="Lines of Code"
              value={formatLinesOfCode(linesGenerated)}
              iconColor="text-info"
            />
            <StatCard
              icon={TestTube2}
              label="Tests"
              value={String(testsGenerated)}
              subtext={`${Math.round(testPassRate * 100)}% passing`}
              iconColor="text-teal"
            />
          </div>

          <div className="grid grid-cols-3 gap-2">
            <StatCard
              icon={Zap}
              label="Tokens Used"
              value={formatTokens(totalTokens)}
              iconColor="text-warning"
            />
            <StatCard
              icon={Clock}
              label="Build Time"
              value={formatTime(totalTimeSecs)}
              subtext={`${iterations} iterations`}
              iconColor="text-muted"
            />
            <StatCard
              icon={Shield}
              label="Quality"
              value={`${qualityScore}`}
              subtext={quality.label}
              iconColor={quality.color}
            />
          </div>

          {/* Cost summary */}
          <div className="flex items-center justify-between bg-hover/40 rounded-card px-3 py-2.5">
            <div className="flex items-center gap-2">
              <TrendingUp size={14} className="text-primary" />
              <span className="text-xs font-medium text-ink">Total Cost</span>
            </div>
            <span className="text-sm font-bold font-mono text-ink">${totalCost.toFixed(2)}</span>
          </div>

          {/* Time breakdown by phase */}
          {phaseBreakdown.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <Layers size={12} className="text-muted" />
                <span className="text-[11px] font-semibold text-muted uppercase tracking-wider">
                  Time Breakdown
                </span>
              </div>
              <div className="space-y-1.5">
                {phaseBreakdown.map(phase => (
                  <PhaseBar key={phase.phase} phase={phase} maxDuration={maxPhaseDuration} />
                ))}
              </div>
            </div>
          )}

          {/* Token distribution */}
          {phaseBreakdown.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <Zap size={12} className="text-muted" />
                <span className="text-[11px] font-semibold text-muted uppercase tracking-wider">
                  Token Distribution
                </span>
              </div>
              <div className="flex h-3 rounded-full overflow-hidden bg-border">
                {phaseBreakdown.map(phase => {
                  const phaseColors: Record<string, string> = {
                    planning: 'bg-info',
                    building: 'bg-primary',
                    testing: 'bg-teal',
                    reviewing: 'bg-warning',
                  };
                  return (
                    <div
                      key={phase.phase}
                      className={`h-full transition-all duration-700 ${phaseColors[phase.phase] || 'bg-primary'}`}
                      style={{ width: `${phase.percentage}%` }}
                      title={`${phase.label}: ${formatTokens(phase.tokenCount)} tokens (${Math.round(phase.percentage)}%)`}
                    />
                  );
                })}
              </div>
              <div className="flex items-center justify-between mt-1">
                {phaseBreakdown.map(phase => {
                  const dotColors: Record<string, string> = {
                    planning: 'bg-info',
                    building: 'bg-primary',
                    testing: 'bg-teal',
                    reviewing: 'bg-warning',
                  };
                  return (
                    <span key={phase.phase} className="flex items-center gap-1 text-[11px] text-muted">
                      <span className={`w-2 h-2 rounded-full ${dotColors[phase.phase] || 'bg-primary'}`} />
                      {phase.label}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {/* Share button */}
          {onShare && (
            <div className="flex justify-end pt-1">
              <button
                onClick={handleShare}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium
                           text-primary hover:bg-primary/5 rounded-card transition-colors"
              >
                <Share2 size={12} />
                Share Insights
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
