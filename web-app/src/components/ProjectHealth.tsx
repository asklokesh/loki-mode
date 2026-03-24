import { useState } from 'react';
import { Shield, TrendingUp, TrendingDown, Minus, ChevronDown, ChevronUp, Lightbulb } from 'lucide-react';

interface HealthFactor {
  label: string;
  score: number; // 0-100
  weight: number;
  description: string;
}

interface HistoryEntry {
  buildNumber: number;
  grade: string;
  score: number;
}

interface ProjectHealthProps {
  /** Test coverage percentage (0-100) */
  testCoverage: number;
  /** Number of lint errors */
  lintErrors: number;
  /** Build success rate from recent builds (0-1) */
  buildSuccessRate: number;
  /** Code complexity score (lower is better, 0-100) */
  codeComplexity: number;
  /** History of recent build health scores */
  history?: HistoryEntry[];
  /** Compact badge mode for headers */
  badge?: boolean;
}

const GRADE_STYLES: Record<string, { color: string; bg: string; border: string }> = {
  'A+': { color: 'text-success', bg: 'bg-success/10', border: 'border-success/20' },
  'A':  { color: 'text-success', bg: 'bg-success/10', border: 'border-success/20' },
  'A-': { color: 'text-success', bg: 'bg-success/8', border: 'border-success/15' },
  'B+': { color: 'text-teal', bg: 'bg-teal/10', border: 'border-teal/20' },
  'B':  { color: 'text-teal', bg: 'bg-teal/8', border: 'border-teal/15' },
  'B-': { color: 'text-info', bg: 'bg-info/8', border: 'border-info/15' },
  'C+': { color: 'text-warning', bg: 'bg-warning/10', border: 'border-warning/20' },
  'C':  { color: 'text-warning', bg: 'bg-warning/8', border: 'border-warning/15' },
  'C-': { color: 'text-warning', bg: 'bg-warning/8', border: 'border-warning/15' },
  'D':  { color: 'text-danger', bg: 'bg-danger/10', border: 'border-danger/20' },
  'F':  { color: 'text-danger', bg: 'bg-danger/15', border: 'border-danger/25' },
};

function computeHealth(props: ProjectHealthProps): {
  score: number;
  grade: string;
  factors: HealthFactor[];
  recommendations: string[];
} {
  const factors: HealthFactor[] = [];
  const recommendations: string[] = [];

  // Test coverage: 30% weight
  const coverageScore = Math.min(props.testCoverage, 100);
  factors.push({
    label: 'Test Coverage',
    score: coverageScore,
    weight: 0.3,
    description: `${Math.round(coverageScore)}% of code covered`,
  });
  if (coverageScore < 60) {
    recommendations.push(`Add tests to increase coverage from ${Math.round(coverageScore)}% to 80%+`);
  }

  // Lint cleanliness: 25% weight
  const lintScore = props.lintErrors === 0 ? 100 : Math.max(0, 100 - props.lintErrors * 5);
  factors.push({
    label: 'Code Quality',
    score: lintScore,
    weight: 0.25,
    description: props.lintErrors === 0 ? 'No lint errors' : `${props.lintErrors} lint error${props.lintErrors !== 1 ? 's' : ''} found`,
  });
  if (props.lintErrors > 0) {
    recommendations.push(`Fix ${props.lintErrors} lint error${props.lintErrors !== 1 ? 's' : ''} to improve code quality`);
  }

  // Build success rate: 25% weight
  const buildScore = Math.round(props.buildSuccessRate * 100);
  factors.push({
    label: 'Build Reliability',
    score: buildScore,
    weight: 0.25,
    description: `${buildScore}% of recent builds succeeded`,
  });
  if (buildScore < 80) {
    recommendations.push('Investigate build failures to improve reliability');
  }

  // Code complexity (inverted -- lower complexity = higher score): 20% weight
  const complexityScore = Math.max(0, 100 - props.codeComplexity);
  factors.push({
    label: 'Simplicity',
    score: complexityScore,
    weight: 0.2,
    description: complexityScore >= 70 ? 'Code is well-structured' : 'Some files could benefit from refactoring',
  });
  if (complexityScore < 50) {
    recommendations.push('Refactor complex files to reduce cognitive load');
  }

  const total = Math.round(factors.reduce((sum, f) => sum + f.score * f.weight, 0));

  // Grade mapping
  let grade: string;
  if (total >= 95) grade = 'A+';
  else if (total >= 90) grade = 'A';
  else if (total >= 85) grade = 'A-';
  else if (total >= 80) grade = 'B+';
  else if (total >= 75) grade = 'B';
  else if (total >= 70) grade = 'B-';
  else if (total >= 65) grade = 'C+';
  else if (total >= 60) grade = 'C';
  else if (total >= 55) grade = 'C-';
  else if (total >= 40) grade = 'D';
  else grade = 'F';

  // Improvement recommendation based on grade
  if (recommendations.length === 0 && total < 95) {
    const bestUpgrade = factors.reduce((best, f) =>
      f.score < best.score ? f : best
    , factors[0]);
    recommendations.push(`Improve ${bestUpgrade.label.toLowerCase()} to reach the next grade`);
  }

  return { score: total, grade, factors, recommendations };
}

function TrendIndicator({ history }: { history: HistoryEntry[] }) {
  if (history.length < 2) return null;

  const latest = history[history.length - 1].score;
  const previous = history[history.length - 2].score;
  const diff = latest - previous;

  if (diff > 2) {
    return (
      <span className="inline-flex items-center gap-0.5 text-success text-[11px] font-medium">
        <TrendingUp size={11} /> +{diff}
      </span>
    );
  }
  if (diff < -2) {
    return (
      <span className="inline-flex items-center gap-0.5 text-danger text-[11px] font-medium">
        <TrendingDown size={11} /> {diff}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5 text-muted text-[11px]">
      <Minus size={11} /> Stable
    </span>
  );
}

function MiniHistoryChart({ history }: { history: HistoryEntry[] }) {
  if (history.length === 0) return null;

  const max = 100;
  const barWidth = 100 / history.length;

  return (
    <div className="flex items-end gap-0.5 h-8">
      {history.map((entry, i) => {
        const height = (entry.score / max) * 100;
        const style = GRADE_STYLES[entry.grade] || GRADE_STYLES['C'];
        return (
          <div
            key={i}
            className={`flex-1 rounded-t-sm transition-all duration-300 ${style.bg}`}
            style={{ height: `${height}%`, minWidth: '4px' }}
            title={`Build #${entry.buildNumber}: ${entry.grade} (${entry.score})`}
          />
        );
      })}
    </div>
  );
}

export function ProjectHealth(props: ProjectHealthProps) {
  const [expanded, setExpanded] = useState(false);
  const { score, grade, factors, recommendations } = computeHealth(props);
  const style = GRADE_STYLES[grade] || GRADE_STYLES['C'];
  const history = props.history || [];

  // Badge mode: minimal inline display
  if (props.badge) {
    return (
      <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-pill border text-xs font-bold ${style.color} ${style.bg} ${style.border}`}>
        <Shield size={12} />
        {grade}
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-hover/30 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className={`flex items-center justify-center w-10 h-10 rounded-lg ${style.bg} ${style.border} border`}>
            <span className={`text-lg font-bold font-mono ${style.color}`}>{grade}</span>
          </div>
          <div className="text-left">
            <h3 className="text-sm font-semibold text-ink">Project Health</h3>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted font-mono">{score}/100</span>
              {history.length >= 2 && <TrendIndicator history={history} />}
            </div>
          </div>
        </div>
        <span className="text-muted">
          {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-4">
          {/* Factor breakdown */}
          <div className="space-y-3">
            {factors.map(f => (
              <div key={f.label}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-secondary">{f.label}</span>
                  <span className={`text-xs font-mono font-semibold ${
                    f.score >= 80 ? 'text-success' :
                    f.score >= 60 ? 'text-warning' :
                    'text-danger'
                  }`}>
                    {Math.round(f.score)}%
                  </span>
                </div>
                <div className="w-full h-1.5 bg-border rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-700 ease-out ${
                      f.score >= 80 ? 'bg-success' :
                      f.score >= 60 ? 'bg-warning' :
                      'bg-danger'
                    }`}
                    style={{ width: `${Math.min(f.score, 100)}%` }}
                  />
                </div>
                <p className="text-[11px] text-muted mt-0.5">{f.description}</p>
              </div>
            ))}
          </div>

          {/* History chart */}
          {history.length > 0 && (
            <div>
              <div className="text-[11px] font-semibold text-muted uppercase tracking-wider mb-2">
                Recent Builds
              </div>
              <MiniHistoryChart history={history} />
            </div>
          )}

          {/* Recommendations */}
          {recommendations.length > 0 && (
            <div className="bg-primary/5 border border-primary/10 rounded-card p-3">
              <div className="flex items-center gap-1.5 mb-2">
                <Lightbulb size={12} className="text-primary" />
                <span className="text-[11px] font-semibold text-primary uppercase tracking-wider">
                  Recommendations
                </span>
              </div>
              <ul className="space-y-1">
                {recommendations.map((rec, i) => (
                  <li key={i} className="text-xs text-secondary flex items-start gap-1.5">
                    <span className="text-primary mt-0.5 flex-shrink-0">--</span>
                    {rec}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
