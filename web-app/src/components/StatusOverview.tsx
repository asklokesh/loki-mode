import type { StatusResponse } from '../types/api';

interface StatusOverviewProps {
  status: StatusResponse | null;
}

export function StatusOverview({ status }: StatusOverviewProps) {
  if (!status) return null;

  const stats = [
    {
      label: 'Iteration',
      value: status.iteration.toString(),
      color: 'text-primary',
    },
    {
      label: 'Agents',
      value: status.running_agents.toString(),
      color: status.running_agents > 0 ? 'text-success' : 'text-slate',
    },
    {
      label: 'Pending',
      value: status.pending_tasks.toString(),
      color: status.pending_tasks > 0 ? 'text-warning' : 'text-slate',
    },
    {
      label: 'Provider',
      value: status.provider || '--',
      color: 'text-accent-product',
    },
  ];

  return (
    <div className="grid grid-cols-4 gap-3">
      {stats.map((stat) => (
        <div key={stat.label} className="glass-subtle p-4 text-center">
          <div className={`text-2xl font-bold font-mono ${stat.color}`}>
            {stat.value}
          </div>
          <div className="text-xs text-slate font-medium mt-1 uppercase tracking-wider">
            {stat.label}
          </div>
        </div>
      ))}
    </div>
  );
}
