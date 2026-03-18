import type { RARVPhase } from '../types/api';

interface PhaseVisualizerProps {
  currentPhase: string;
  iteration: number;
}

const PHASES: { key: RARVPhase; label: string; description: string }[] = [
  { key: 'reason', label: 'Reason', description: 'Analyzing task, planning approach' },
  { key: 'act', label: 'Act', description: 'Implementing changes, writing code' },
  { key: 'reflect', label: 'Reflect', description: 'Reviewing output, self-critique' },
  { key: 'verify', label: 'Verify', description: 'Testing, validation, quality gates' },
];

function mapPhaseString(phase: string): RARVPhase {
  const lower = phase.toLowerCase();
  if (lower.includes('reason') || lower.includes('plan')) return 'reason';
  if (lower.includes('act') || lower.includes('implement') || lower.includes('code')) return 'act';
  if (lower.includes('reflect') || lower.includes('review')) return 'reflect';
  if (lower.includes('verify') || lower.includes('test') || lower.includes('check')) return 'verify';
  return 'idle';
}

export function PhaseVisualizer({ currentPhase, iteration }: PhaseVisualizerProps) {
  const active = mapPhaseString(currentPhase);

  return (
    <div className="glass p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-charcoal uppercase tracking-wider">
          RARV Cycle
        </h3>
        <span className="font-mono text-xs text-slate">
          Iteration {iteration}
        </span>
      </div>

      {/* Circular progress visualization */}
      <div className="flex items-center justify-center mb-5">
        <svg viewBox="0 0 120 120" className="w-28 h-28">
          {PHASES.map((phase, i) => {
            const isActive = phase.key === active;
            const isPast = active !== 'idle' && PHASES.findIndex(p => p.key === active) > i;
            const angle = (i * 90 - 90) * (Math.PI / 180);
            const cx = 60 + 40 * Math.cos(angle);
            const cy = 60 + 40 * Math.sin(angle);

            return (
              <g key={phase.key}>
                {/* Connection line to next */}
                {i < PHASES.length - 1 && (
                  <line
                    x1={cx}
                    y1={cy}
                    x2={60 + 40 * Math.cos(((i + 1) * 90 - 90) * (Math.PI / 180))}
                    y2={60 + 40 * Math.sin(((i + 1) * 90 - 90) * (Math.PI / 180))}
                    stroke={isPast ? '#3D52A0' : '#ADBBDA'}
                    strokeWidth={isPast ? 2 : 1}
                    strokeDasharray={isPast ? 'none' : '4 3'}
                  />
                )}
                {/* Closing line from last to first */}
                {i === PHASES.length - 1 && (
                  <line
                    x1={cx}
                    y1={cy}
                    x2={60 + 40 * Math.cos(-90 * (Math.PI / 180))}
                    y2={60 + 40 * Math.sin(-90 * (Math.PI / 180))}
                    stroke="#ADBBDA"
                    strokeWidth={1}
                    strokeDasharray="4 3"
                  />
                )}
                {/* Node */}
                <circle
                  cx={cx}
                  cy={cy}
                  r={isActive ? 14 : 10}
                  fill={isActive ? '#3D52A0' : isPast ? '#7091E6' : '#EDE8F5'}
                  stroke={isActive ? '#6C63FF' : isPast ? '#3D52A0' : '#ADBBDA'}
                  strokeWidth={isActive ? 3 : 1.5}
                  className={isActive ? 'phase-active' : ''}
                />
                {/* Label */}
                <text
                  x={cx}
                  y={cy + (i === 0 ? -20 : i === 2 ? 24 : 0)}
                  textAnchor="middle"
                  className="text-[9px] font-semibold fill-charcoal"
                  dx={i === 1 ? 22 : i === 3 ? -22 : 0}
                >
                  {phase.label[0]}
                </text>
              </g>
            );
          })}
          {/* Center iteration count */}
          <text x="60" y="64" textAnchor="middle" className="text-lg font-bold font-mono fill-primary">
            {iteration}
          </text>
        </svg>
      </div>

      {/* Phase list */}
      <div className="space-y-2">
        {PHASES.map((phase) => {
          const isActive = phase.key === active;
          return (
            <div
              key={phase.key}
              className={`flex items-center gap-3 px-3 py-2 rounded-xl transition-all duration-200 ${
                isActive
                  ? 'bg-primary/8 border border-primary/20'
                  : 'opacity-50'
              }`}
            >
              <div
                className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                  isActive ? 'bg-primary phase-active' : 'bg-surface'
                }`}
              />
              <div>
                <span className={`text-sm font-semibold ${isActive ? 'text-primary' : 'text-slate'}`}>
                  {phase.label}
                </span>
                {isActive && (
                  <p className="text-xs text-slate mt-0.5">{phase.description}</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
