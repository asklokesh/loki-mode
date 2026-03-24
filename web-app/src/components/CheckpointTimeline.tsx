import { useState, useEffect, useCallback } from 'react';
import { History, RotateCcw, Clock, FileCode2 } from 'lucide-react';
import { api } from '../api/client';
import type { Checkpoint } from '../types/api';

interface CheckpointTimelineProps {
  sessionId: string;
  onRestore?: () => void;
}

export function CheckpointTimeline({ sessionId, onRestore }: CheckpointTimelineProps) {
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchCheckpoints = useCallback(async () => {
    try {
      const data = await api.getCheckpoints(sessionId);
      setCheckpoints(data);
      setError(null);
    } catch {
      setError('Failed to load checkpoints');
    }
    setLoading(false);
  }, [sessionId]);

  useEffect(() => {
    fetchCheckpoints();
    const interval = setInterval(fetchCheckpoints, 15000);
    return () => clearInterval(interval);
  }, [fetchCheckpoints]);

  const handleRestore = useCallback(async (cpId: string) => {
    if (restoring) return;
    const cp = checkpoints.find(c => c.id === cpId);
    if (!cp) return;

    const confirmed = window.confirm(
      `Restore to checkpoint "${cp.description}"?\n\nThis will revert files to this checkpoint state.`
    );
    if (!confirmed) return;

    setRestoring(cpId);
    try {
      await api.restoreCheckpoint(sessionId, cpId);
      await fetchCheckpoints();
      onRestore?.();
    } catch {
      setError('Failed to restore checkpoint');
    }
    setRestoring(null);
  }, [sessionId, checkpoints, restoring, fetchCheckpoints, onRestore]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-4 py-2 bg-card border-b border-border">
        <History size={14} className="text-muted animate-pulse" />
        <span className="text-xs text-muted">Loading checkpoints...</span>
      </div>
    );
  }

  if (error && checkpoints.length === 0) {
    return null;
  }

  if (checkpoints.length === 0) {
    return null;
  }

  const formatTime = (timestamp: string) => {
    if (!timestamp) return '';
    try {
      const d = new Date(timestamp);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  };

  return (
    <div className="flex items-center gap-2 px-4 py-1.5 bg-card border-b border-border overflow-x-auto">
      <History size={14} className="text-muted flex-shrink-0" />
      <span className="text-[11px] font-medium text-muted flex-shrink-0">Checkpoints</span>

      <div className="flex items-center gap-1 flex-1 min-w-0">
        {checkpoints.map((cp, i) => (
          <div key={cp.id} className="flex items-center gap-1">
            {/* Connector line */}
            {i > 0 && (
              <div className="w-4 h-px bg-border flex-shrink-0" />
            )}

            {/* Checkpoint dot */}
            <div className="relative flex-shrink-0">
              <button
                onClick={() => handleRestore(cp.id)}
                onMouseEnter={() => setHoveredId(cp.id)}
                onMouseLeave={() => setHoveredId(null)}
                disabled={restoring !== null}
                className={`w-3.5 h-3.5 rounded-full border-2 transition-all cursor-pointer ${
                  cp.is_current
                    ? 'bg-primary border-primary shadow-sm shadow-primary/30'
                    : restoring === cp.id
                    ? 'bg-warning border-warning animate-pulse'
                    : 'bg-card border-border hover:border-primary hover:bg-primary/10'
                } ${restoring !== null && restoring !== cp.id ? 'opacity-50' : ''}`}
                title={`${cp.description} -- Click to restore`}
              />

              {/* Hover tooltip */}
              {hoveredId === cp.id && (
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 pointer-events-none">
                  <div className="bg-card border border-border rounded-lg shadow-lg px-3 py-2 whitespace-nowrap">
                    <p className="text-xs font-medium text-ink">{cp.description}</p>
                    <div className="flex items-center gap-3 mt-1">
                      {cp.timestamp && (
                        <span className="flex items-center gap-1 text-[11px] text-muted">
                          <Clock size={10} />
                          {formatTime(cp.timestamp)}
                        </span>
                      )}
                      {cp.files_changed > 0 && (
                        <span className="flex items-center gap-1 text-[11px] text-muted">
                          <FileCode2 size={10} />
                          {cp.files_changed} file{cp.files_changed !== 1 ? 's' : ''}
                        </span>
                      )}
                      {cp.iteration > 0 && (
                        <span className="text-[11px] text-muted">
                          Iter {cp.iteration}
                        </span>
                      )}
                    </div>
                    {!cp.is_current && (
                      <div className="flex items-center gap-1 mt-1.5 text-[11px] text-primary font-medium">
                        <RotateCcw size={10} />
                        Click to restore
                      </div>
                    )}
                    {cp.is_current && (
                      <div className="text-[11px] text-success mt-1">Current</div>
                    )}
                  </div>
                  {/* Tooltip arrow */}
                  <div className="w-2 h-2 bg-card border-r border-b border-border rotate-45 mx-auto -mt-1" />
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {error && (
        <span className="text-[11px] text-danger flex-shrink-0">{error}</span>
      )}
    </div>
  );
}
