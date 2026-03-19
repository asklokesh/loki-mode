import { useCallback } from 'react';
import { api } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import type { SessionHistoryItem } from '../api/client';

interface SessionHistoryProps {
  onLoadSession?: (item: SessionHistoryItem) => void;
}

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  completed: { bg: 'bg-success/10', text: 'text-success', label: 'Completed' },
  complete: { bg: 'bg-success/10', text: 'text-success', label: 'Completed' },
  done: { bg: 'bg-success/10', text: 'text-success', label: 'Completed' },
  in_progress: { bg: 'bg-primary/10', text: 'text-primary', label: 'In Progress' },
  started: { bg: 'bg-warning/10', text: 'text-warning', label: 'Started' },
  error: { bg: 'bg-danger/10', text: 'text-danger', label: 'Failed' },
  failed: { bg: 'bg-danger/10', text: 'text-danger', label: 'Failed' },
  empty: { bg: 'bg-slate/10', text: 'text-slate', label: 'Empty' },
};

function getStatusStyle(status: string) {
  return STATUS_STYLES[status] || { bg: 'bg-slate/10', text: 'text-slate', label: status };
}

export function SessionHistory({ onLoadSession }: SessionHistoryProps) {
  const fetchHistory = useCallback(() => api.getSessionsHistory(), []);
  const { data: sessions, loading } = usePolling(fetchHistory, 60000, true);

  if (loading && !sessions) {
    return (
      <div className="glass p-4 rounded-2xl">
        <h3 className="text-sm font-semibold text-charcoal uppercase tracking-wider mb-3">Past Builds</h3>
        <div className="text-sm text-slate">Loading...</div>
      </div>
    );
  }

  if (!sessions || sessions.length === 0) {
    return null;
  }

  return (
    <div className="glass p-4 rounded-2xl">
      <h3 className="text-sm font-semibold text-charcoal uppercase tracking-wider mb-3">Past Builds</h3>
      <div className="flex flex-col gap-2 max-h-64 overflow-y-auto terminal-scroll">
        {sessions.map((item) => {
          const style = getStatusStyle(item.status);
          const fileCount = (item as unknown as Record<string, unknown>).file_count as number | undefined;
          return (
            <button
              key={item.id}
              onClick={() => onLoadSession?.(item)}
              className="text-left px-4 py-3 rounded-xl glass-subtle hover:bg-white/40 transition-all group cursor-pointer"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] font-mono text-slate">{item.date}</span>
                <div className="flex items-center gap-2">
                  {fileCount !== undefined && fileCount > 0 && (
                    <span className="text-[10px] font-mono text-slate">
                      {fileCount} files
                    </span>
                  )}
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${style.bg} ${style.text}`}>
                    {style.label}
                  </span>
                </div>
              </div>
              <div className="text-xs text-charcoal truncate group-hover:text-accent-product transition-colors">
                {item.prd_snippet || item.id}
              </div>
              <div className="text-[10px] font-mono text-slate/60 mt-0.5 truncate">
                {item.path}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
