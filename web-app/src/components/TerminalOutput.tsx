import { useEffect, useRef } from 'react';
import type { LogEntry } from '../types/api';

interface TerminalOutputProps {
  logs: LogEntry[] | null;
  loading: boolean;
}

const LEVEL_COLORS: Record<string, string> = {
  info: 'text-primary-light',
  error: 'text-danger',
  warning: 'text-warning',
  debug: 'text-slate',
  critical: 'text-danger font-bold',
};

function formatTimestamp(ts: string): string {
  if (!ts) return '';
  // Handle both full ISO and time-only formats
  if (ts.includes('T') || ts.includes('-')) {
    try {
      const d = new Date(ts);
      return d.toLocaleTimeString('en-US', { hour12: false });
    } catch {
      return ts;
    }
  }
  return ts;
}

export function TerminalOutput({ logs, loading }: TerminalOutputProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (autoScrollRef.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs]);

  // Detect if user scrolled up (pause auto-scroll)
  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 50;
  };

  return (
    <div className="glass p-0 overflow-hidden flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
        <h3 className="text-sm font-semibold text-charcoal uppercase tracking-wider">
          Terminal
        </h3>
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-slate">
            {logs?.length || 0} lines
          </span>
          {!autoScrollRef.current && (
            <button
              onClick={() => {
                autoScrollRef.current = true;
                containerRef.current?.scrollTo({
                  top: containerRef.current.scrollHeight,
                  behavior: 'smooth',
                });
              }}
              className="text-xs text-primary hover:text-primary-light transition-colors font-medium"
            >
              Scroll to bottom
            </button>
          )}
        </div>
      </div>

      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto terminal-scroll bg-charcoal/[0.03] p-4 font-mono text-xs leading-relaxed min-h-[300px]"
      >
        {loading && !logs && (
          <div className="text-slate animate-pulse">Connecting to log stream...</div>
        )}

        {logs?.length === 0 && !loading && (
          <div className="text-slate/60">
            <p>No log output yet.</p>
            <p className="mt-1">Start a Loki Mode session to see terminal output here.</p>
          </div>
        )}

        {logs?.map((entry, i) => (
          <div key={i} className="flex gap-2 hover:bg-white/5 rounded px-1 -mx-1">
            <span className="text-slate/40 flex-shrink-0 select-none w-16 text-right">
              {formatTimestamp(entry.timestamp)}
            </span>
            <span
              className={`flex-shrink-0 w-12 text-right uppercase text-[10px] font-semibold ${
                LEVEL_COLORS[entry.level] || 'text-slate'
              }`}
            >
              {entry.level}
            </span>
            <span className={`flex-1 break-all ${
              entry.level === 'error' || entry.level === 'critical'
                ? 'text-danger'
                : 'text-charcoal/80'
            }`}>
              {entry.message}
            </span>
          </div>
        ))}

        {/* Terminal cursor */}
        {logs && logs.length > 0 && (
          <div className="terminal-cursor mt-1" />
        )}
      </div>
    </div>
  );
}
