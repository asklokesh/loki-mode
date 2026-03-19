import type { Agent } from '../types/api';

interface AgentDashboardProps {
  agents: Agent[] | null;
  loading: boolean;
}

const AGENT_TYPE_COLORS: Record<string, string> = {
  architect: 'bg-accent-product/10 text-accent-product border-accent-product/20',
  developer: 'bg-primary/10 text-primary border-primary/20',
  tester: 'bg-success/10 text-success border-success/20',
  reviewer: 'bg-warning/10 text-warning border-warning/20',
  planner: 'bg-primary-wash/20 text-charcoal border-primary-wash/30',
  default: 'bg-surface/30 text-slate border-surface/50',
};

function getAgentColor(type: string): string {
  if (!type) return AGENT_TYPE_COLORS.default;
  const lower = type.toLowerCase();
  for (const [key, value] of Object.entries(AGENT_TYPE_COLORS)) {
    if (lower.includes(key)) return value;
  }
  return AGENT_TYPE_COLORS.default;
}

export function AgentDashboard({ agents, loading }: AgentDashboardProps) {
  const activeAgents = agents?.filter(a => a.alive) || [];
  const inactiveAgents = agents?.filter(a => !a.alive) || [];

  return (
    <div className="glass p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-charcoal uppercase tracking-wider">
          Agents
        </h3>
        <span className="font-mono text-xs text-slate">
          {activeAgents.length} active
        </span>
      </div>

      {loading && !agents && (
        <div className="text-center py-8 text-slate text-sm">Loading agents...</div>
      )}

      {!loading && agents?.length === 0 && (
        <div className="text-center py-8">
          <p className="text-slate text-sm">No agents running</p>
          <p className="text-primary-wash text-xs mt-1">Start a build to spawn agents</p>
        </div>
      )}

      {/* Active agents */}
      {activeAgents.length > 0 && (
        <div className="space-y-2 mb-4">
          {activeAgents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </div>
      )}

      {/* Inactive agents (collapsed) */}
      {inactiveAgents.length > 0 && (
        <details className="mt-3">
          <summary className="text-xs text-slate cursor-pointer hover:text-charcoal transition-colors">
            {inactiveAgents.length} completed
          </summary>
          <div className="space-y-1.5 mt-2">
            {inactiveAgents.slice(0, 10).map((agent) => (
              <AgentCard key={agent.id} agent={agent} compact />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function AgentCard({ agent, compact }: { agent: Agent; compact?: boolean }) {
  const colorClass = getAgentColor(agent.type || agent.name);

  if (compact) {
    return (
      <div className="flex items-center gap-2 px-2 py-1 rounded-lg bg-white/30 text-xs">
        <div className="w-1.5 h-1.5 rounded-full bg-slate/30" />
        <span className="font-medium text-slate truncate">{agent.name || agent.id}</span>
        <span className="text-primary-wash ml-auto">{agent.type}</span>
      </div>
    );
  }

  return (
    <div className={`flex items-start gap-3 px-3 py-2.5 rounded-xl border ${colorClass}`}>
      <div className="flex-shrink-0 mt-0.5">
        <div className={`w-2.5 h-2.5 rounded-full ${agent.alive ? 'bg-success phase-active' : 'bg-slate/30'}`} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold truncate">{agent.name || agent.id}</span>
          {agent.type && (
            <span className="text-[10px] font-mono font-medium opacity-70">{agent.type}</span>
          )}
        </div>
        {agent.task && (
          <p className="text-xs opacity-70 mt-0.5 truncate">{agent.task}</p>
        )}
        {agent.status && agent.status !== 'unknown' && (
          <span className="inline-block text-[10px] font-mono mt-1 opacity-60">{agent.status}</span>
        )}
      </div>
      {agent.pid && (
        <span className="text-[10px] font-mono text-slate/50 flex-shrink-0">PID {agent.pid}</span>
      )}
    </div>
  );
}
