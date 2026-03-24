import { useState } from 'react';
import { Info } from 'lucide-react';

interface ConfidenceIndicatorProps {
  /** Quality gate pass rate (0-1) */
  gatePassRate: number;
  /** Test coverage percentage (0-100) */
  testCoverage: number;
  /** Current iteration number */
  iteration: number;
  /** Maximum iterations */
  maxIterations: number;
  /** Overall phase of the build */
  phase: string;
  /** Compact display for inline use */
  compact?: boolean;
}

interface ConfidenceFactor {
  label: string;
  value: number;
  weight: number;
  description: string;
}

function computeConfidence(props: ConfidenceIndicatorProps): {
  score: number;
  factors: ConfidenceFactor[];
} {
  const factors: ConfidenceFactor[] = [];

  // Gate pass rate: 40% weight
  const gateScore = props.gatePassRate * 100;
  factors.push({
    label: 'Quality Gates',
    value: gateScore,
    weight: 0.4,
    description: `${Math.round(gateScore)}% of quality gates passing`,
  });

  // Test coverage: 30% weight
  const coverageScore = Math.min(props.testCoverage, 100);
  factors.push({
    label: 'Test Coverage',
    value: coverageScore,
    weight: 0.3,
    description: `${Math.round(coverageScore)}% code covered by tests`,
  });

  // Iteration progress: 20% weight
  // Confidence increases as we progress through iterations (more refinement)
  const iterProgress = props.maxIterations > 0
    ? Math.min((props.iteration / props.maxIterations) * 100, 100)
    : 50;
  factors.push({
    label: 'Iteration Progress',
    value: iterProgress,
    weight: 0.2,
    description: `${props.iteration}/${props.maxIterations} iterations completed`,
  });

  // Phase maturity: 10% weight
  const phaseScores: Record<string, number> = {
    planning: 30,
    building: 50,
    testing: 75,
    reviewing: 90,
    complete: 100,
    idle: 0,
  };
  const phaseScore = phaseScores[props.phase] ?? 40;
  factors.push({
    label: 'Build Phase',
    value: phaseScore,
    weight: 0.1,
    description: `Currently in ${props.phase} phase`,
  });

  const score = factors.reduce((sum, f) => sum + f.value * f.weight, 0);
  return { score: Math.round(Math.min(score, 100)), factors };
}

function getConfidenceColor(score: number): { ring: string; text: string; bg: string; label: string } {
  if (score >= 80) return { ring: '#1FC5A8', text: 'text-success', bg: 'bg-success/10', label: 'High' };
  if (score >= 60) return { ring: '#D4A03C', text: 'text-warning', bg: 'bg-warning/10', label: 'Medium' };
  return { ring: '#C45B5B', text: 'text-danger', bg: 'bg-danger/10', label: 'Low' };
}

function CircularGauge({ score, size = 48 }: { score: number; size?: number }) {
  const strokeWidth = size < 40 ? 3 : 4;
  const radius = (size - strokeWidth * 2) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = (score / 100) * circumference;
  const color = getConfidenceColor(score);

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        {/* Background track */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          className="text-border"
          strokeWidth={strokeWidth}
        />
        {/* Progress arc */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color.ring}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference - progress}
          className="transition-all duration-1000 ease-out"
        />
      </svg>
      <span
        className={`absolute text-center font-mono font-bold ${color.text}`}
        style={{ fontSize: size < 40 ? '10px' : '12px' }}
      >
        {score}
      </span>
    </div>
  );
}

export function ConfidenceIndicator(props: ConfidenceIndicatorProps) {
  const [showTooltip, setShowTooltip] = useState(false);
  const { score, factors } = computeConfidence(props);
  const color = getConfidenceColor(score);

  if (props.compact) {
    return (
      <div
        className="relative inline-flex items-center gap-1.5"
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
      >
        <CircularGauge score={score} size={28} />
        <span className={`text-xs font-medium ${color.text}`}>
          {color.label}
        </span>

        {showTooltip && (
          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 pointer-events-none">
            <div className="bg-card border border-border rounded-lg shadow-lg px-3 py-2 w-56">
              <div className="text-xs font-semibold text-ink mb-2">AI Confidence: {score}%</div>
              {factors.map(f => (
                <div key={f.label} className="flex items-center justify-between text-[11px] text-muted mb-1">
                  <span>{f.label}</span>
                  <span className="font-mono">{Math.round(f.value)}%</span>
                </div>
              ))}
            </div>
            <div className="w-2 h-2 bg-card border-r border-b border-border rotate-45 mx-auto -mt-1" />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="card p-4">
      <div className="flex items-center gap-3 mb-4">
        <CircularGauge score={score} size={56} />
        <div>
          <h3 className="text-sm font-semibold text-ink">AI Confidence</h3>
          <div className={`text-xs font-medium ${color.text} flex items-center gap-1`}>
            {color.label} Confidence
            <div className="relative">
              <Info
                size={12}
                className="text-muted cursor-help"
                onMouseEnter={() => setShowTooltip(true)}
                onMouseLeave={() => setShowTooltip(false)}
              />
              {showTooltip && (
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 w-64 pointer-events-none">
                  <div className="bg-card border border-border rounded-lg shadow-lg px-3 py-2">
                    <p className="text-[11px] text-muted leading-relaxed">
                      Confidence is computed from quality gate pass rate (40%),
                      test coverage (30%), iteration progress (20%),
                      and build phase maturity (10%).
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Factor breakdown */}
      <div className="space-y-2.5">
        {factors.map(f => (
          <div key={f.label}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-secondary">{f.label}</span>
              <span className="text-xs font-mono text-muted">{Math.round(f.value)}%</span>
            </div>
            <div className="w-full h-1.5 bg-border rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-700 ease-out ${
                  f.value >= 80 ? 'bg-success' :
                  f.value >= 60 ? 'bg-warning' :
                  'bg-danger'
                }`}
                style={{ width: `${Math.min(f.value, 100)}%` }}
              />
            </div>
            <p className="text-[11px] text-muted mt-0.5">{f.description}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
