import { useEffect, useRef, useState } from 'react';
import type { LogEntry } from '../types/api';

interface TerminalOutputProps {
  logs: LogEntry[] | null;
  loading: boolean;
  subscribe?: (type: string, callback: (data: unknown) => void) => () => void;
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

export function TerminalOutput({ logs, loading, subscribe }: TerminalOutputProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // scrollLocked = true means user scrolled up, auto-scroll is OFF
  const [scrollLocked, setScrollLocked] = useState(false);
  const [wsLines, setWsLines] = useState<{ message: string; timestamp: string }[]>([]);

  // Subscribe to WebSocket log events for real-time streaming
  useEffect(() => {
    if (!subscribe) return;
    const unsub = subscribe('log', (data: unknown) => {
      const d = data as { line?: string; timestamp?: string };
      if (d?.line) {
        setWsLines(prev => {
          const next = [...prev, { message: d.line!, timestamp: d.timestamp || '' }];
          return next.length > 500 ? next.slice(-500) : next;
        });
      }
    });
    return unsub;
  }, [subscribe]);

  // Merge polled HTTP logs with WS lines (dedup by message content, preserve order)
  const displayLogs: LogEntry[] = (() => {
    const wsEntries: LogEntry[] = wsLines.map(l => {
      let level = 'info';
      const lower = l.message.toLowerCase();
      if (lower.includes('error') || lower.includes('fail')) level = 'error';
      else if (lower.includes('warn')) level = 'warning';
      else if (lower.includes('debug')) level = 'debug';
      return { timestamp: l.timestamp, level, message: l.message, source: 'ws' };
    });
    const httpEntries = logs || [];
    if (wsEntries.length === 0) return httpEntries;
    if (httpEntries.length === 0) return wsEntries;
    // Merge: keep all HTTP lines not already present in WS lines, then append WS lines
    const wsMessages = new Set(wsEntries.map(e => e.message));
    const uniqueHttp = httpEntries.filter(e => !wsMessages.has(e.message));
    return [...uniqueHttp, ...wsEntries];
  })();

  // Auto-scroll to bottom when new logs arrive (only when not locked)
  useEffect(() => {
    if (!scrollLocked && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [displayLogs, scrollLocked]);

  // Detect if user scrolled up -- engage scroll lock
  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const nearBottom = scrollHeight - scrollTop - clientHeight < 50;
    setScrollLocked(!nearBottom);
  };

  const scrollToBottom = () => {
    setScrollLocked(false);
    containerRef.current?.scrollTo({
      top: containerRef.current.scrollHeight,
      behavior: 'smooth',
    });
  };

  return (
    <div className="glass p-0 overflow-hidden flex flex-col" style={{ height: 'calc(100vh - 380px)', minHeight: '300px', maxHeight: '600px' }}>
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 flex-shrink-0">
        <h3 className="text-sm font-semibold text-charcoal uppercase tracking-wider">
          Terminal
        </h3>
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-slate">
            {displayLogs.length} lines
          </span>
          {/* Scroll lock toggle */}
          <button
            onClick={scrollLocked ? scrollToBottom : () => setScrollLocked(true)}
            className={`text-xs font-medium px-2.5 py-1 rounded-lg border transition-colors ${
              scrollLocked
                ? 'border-warning/40 text-warning bg-warning/5 hover:bg-warning/10'
                : 'border-primary/20 text-primary hover:bg-primary/5'
            }`}
            title={scrollLocked ? 'Scroll locked -- click to resume auto-scroll' : 'Auto-scrolling -- click to lock'}
          >
            {scrollLocked ? 'Locked' : 'Live'}
          </button>
          {scrollLocked && (
            <button
              onClick={scrollToBottom}
              className="text-xs text-primary hover:text-primary-light transition-colors font-medium"
            >
              Jump to bottom
            </button>
          )}
        </div>
      </div>

      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto terminal-scroll bg-charcoal/[0.03] p-4 font-mono text-xs leading-relaxed"
      >
        {loading && !logs && wsLines.length === 0 && (
          <div className="text-slate animate-pulse">Connecting to log stream...</div>
        )}

        {displayLogs.length === 0 && !loading && (
          <div className="text-slate/60">
            <p>No log output yet.</p>
            <p className="mt-1">Start a build to see terminal output here.</p>
          </div>
        )}

        {displayLogs.map((entry, i) => (
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
        {displayLogs.length > 0 && (
          <div className="terminal-cursor mt-1" />
        )}
      </div>
    </div>
  );
}
