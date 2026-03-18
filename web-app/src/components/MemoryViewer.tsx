import type { MemorySummary } from '../types/api';

interface MemoryViewerProps {
  memory: MemorySummary | null;
  loading: boolean;
}

const TOKEN_BUDGET = 500_000;

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return tokens.toString();
}

function formatTimestamp(ts: string | null): string {
  if (!ts) return 'Never';
  try {
    const date = new Date(ts);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const hours = Math.floor(diff / (1000 * 60 * 60));
    if (hours < 1) return 'Just now';
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  } catch {
    return ts;
  }
}

export function MemoryViewer({ memory, loading }: MemoryViewerProps) {
  const stats = memory
    ? [
        { label: 'Episodic', count: memory.episodic_count, color: 'text-primary', bg: 'bg-primary/10', border: 'border-primary/20' },
        { label: 'Semantic', count: memory.semantic_count, color: 'text-success', bg: 'bg-success/10', border: 'border-success/20' },
        { label: 'Skills', count: memory.skill_count, color: 'text-warning', bg: 'bg-warning/10', border: 'border-warning/20' },
      ]
    : [];

  const tokenPercent = memory ? Math.min((memory.total_tokens / TOKEN_BUDGET) * 100, 100) : 0;

  return (
    <div className="glass p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-charcoal uppercase tracking-wider">
          Memory System
        </h3>
        {memory && (
          <span className="font-mono text-xs text-slate">
            {formatTimestamp(memory.last_consolidation)}
          </span>
        )}
      </div>

      {loading && !memory && (
        <div className="text-center py-8 text-slate text-sm">Loading memory...</div>
      )}

      {!loading && !memory && (
        <div className="text-center py-8">
          <p className="text-slate text-sm">No memory data available</p>
          <p className="text-primary-wash text-xs mt-1">Memory populates during autonomous runs</p>
        </div>
      )}

      {memory && (
        <>
          {/* Stat cards */}
          <div className="grid grid-cols-3 gap-3 mb-4">
            {stats.map((stat) => (
              <div
                key={stat.label}
                className={`${stat.bg} border ${stat.border} rounded-xl p-3 text-center`}
              >
                <div className={`text-2xl font-bold font-mono ${stat.color}`}>
                  {stat.count}
                </div>
                <div className="text-[10px] text-slate font-medium mt-1 uppercase tracking-wider">
                  {stat.label}
                </div>
              </div>
            ))}
          </div>

          {/* Token usage */}
          <div className="mt-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs text-slate font-medium">Token Usage</span>
              <span className="text-xs font-mono text-charcoal">
                {formatTokens(memory.total_tokens)} / {formatTokens(TOKEN_BUDGET)}
              </span>
            </div>
            <div className="w-full h-2 bg-charcoal/10 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  tokenPercent > 80 ? 'bg-danger' : tokenPercent > 50 ? 'bg-warning' : 'bg-primary-light'
                }`}
                style={{ width: `${tokenPercent}%` }}
              />
            </div>
          </div>

          {/* Last consolidation */}
          <div className="mt-3 flex items-center justify-between text-xs">
            <span className="text-slate">Last Consolidation</span>
            <span className="font-mono text-charcoal">
              {memory.last_consolidation
                ? new Date(memory.last_consolidation).toLocaleString()
                : 'Never'}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
