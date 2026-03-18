import type { StatusResponse } from '../types/api';

interface ControlBarProps {
  status: StatusResponse | null;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function getModelTier(phase: string): string {
  const lower = phase.toLowerCase();
  if (lower.includes('plan') || lower.includes('architect') || lower.includes('design')) return 'Opus';
  if (lower.includes('test') || lower.includes('unit') || lower.includes('monitor')) return 'Haiku';
  return 'Sonnet';
}

export function ControlBar({ status }: ControlBarProps) {
  if (!status) return null;

  const tier = getModelTier(status.phase || '');

  return (
    <div className="glass px-5 py-3 flex items-center gap-6 text-sm">
      {/* Phase */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate uppercase tracking-wider font-medium">Phase</span>
        <span className="font-mono font-semibold text-charcoal">
          {status.phase || 'idle'}
        </span>
      </div>

      <div className="w-px h-5 bg-surface" />

      {/* Complexity */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate uppercase tracking-wider font-medium">Complexity</span>
        <span className={`font-mono font-semibold ${
          status.complexity === 'complex' ? 'text-warning' :
          status.complexity === 'simple' ? 'text-success' : 'text-charcoal'
        }`}>
          {status.complexity || 'standard'}
        </span>
      </div>

      <div className="w-px h-5 bg-surface" />

      {/* Model tier */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate uppercase tracking-wider font-medium">Model</span>
        <span className={`font-mono font-semibold px-2 py-0.5 rounded-md text-xs ${
          tier === 'Opus' ? 'bg-accent-product/10 text-accent-product' :
          tier === 'Haiku' ? 'bg-success/10 text-success' :
          'bg-primary/10 text-primary'
        }`}>
          {tier}
        </span>
      </div>

      <div className="w-px h-5 bg-surface" />

      {/* Tasks */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate uppercase tracking-wider font-medium">Tasks</span>
        <span className="font-mono text-charcoal">
          {status.current_task ? (
            <span className="text-xs">{status.current_task}</span>
          ) : (
            <span className="text-slate">--</span>
          )}
        </span>
        {status.pending_tasks > 0 && (
          <span className="text-xs text-primary-wash font-mono">
            +{status.pending_tasks} pending
          </span>
        )}
      </div>

      <div className="flex-1" />

      {/* Uptime */}
      {status.uptime > 0 && (
        <span className="font-mono text-xs text-slate">
          {formatUptime(status.uptime)}
        </span>
      )}
    </div>
  );
}
