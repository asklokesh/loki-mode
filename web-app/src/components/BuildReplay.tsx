import { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Pause, SkipForward, RotateCcw, Share2, FileCode2, CheckCircle2, Clock } from 'lucide-react';

interface ReplayEvent {
  timestamp: number;
  type: 'file_created' | 'file_modified' | 'phase_change' | 'gate_pass' | 'gate_fail' | 'iteration';
  label: string;
  detail?: string;
  phase?: string;
}

interface BuildReplayProps {
  sessionId: string;
  files: Array<{ path: string; type: 'file' | 'directory' }>;
  phases: string[];
  checkpoints: Array<{ description: string; iteration: number; files_changed: number; timestamp: string }>;
  qualityGates: Array<{ label: string; status: string }>;
  totalIterations: number;
  onShare?: (summary: string) => void;
}

const SPEEDS = [1, 2, 5] as const;

function buildReplayTimeline(props: BuildReplayProps): ReplayEvent[] {
  const events: ReplayEvent[] = [];
  let ts = 0;
  const step = 600; // ms per event at 1x

  // Phase changes and iterations
  const phaseOrder = ['planning', 'building', 'testing', 'reviewing', 'complete'];
  const phasesUsed = props.phases.length > 0 ? props.phases : phaseOrder;

  for (const phase of phasesUsed) {
    events.push({ timestamp: ts, type: 'phase_change', label: `Phase: ${phase}`, phase });
    ts += step;

    if (phase === 'building') {
      // Simulate files appearing during the build phase
      for (const f of props.files.filter(f => f.type === 'file')) {
        events.push({ timestamp: ts, type: 'file_created', label: f.path, detail: f.path });
        ts += step * 0.4;
      }
    }

    if (phase === 'testing' || phase === 'reviewing') {
      for (const gate of props.qualityGates) {
        const evType = gate.status === 'pass' ? 'gate_pass' : 'gate_fail';
        events.push({ timestamp: ts, type: evType, label: gate.label, phase });
        ts += step * 0.3;
      }
    }
  }

  // Add iteration markers
  for (let i = 1; i <= props.totalIterations; i++) {
    const iterTs = (i / props.totalIterations) * ts;
    events.push({ timestamp: iterTs, type: 'iteration', label: `Iteration ${i}/${props.totalIterations}` });
  }

  // Sort by timestamp
  events.sort((a, b) => a.timestamp - b.timestamp);
  return events;
}

function FileTreeNode({ path, visible, delay }: { path: string; visible: boolean; delay: number }) {
  const parts = path.split('/');
  const name = parts[parts.length - 1];
  const depth = parts.length - 1;

  return (
    <div
      className={`flex items-center gap-1.5 py-0.5 transition-all duration-500 ${
        visible ? 'opacity-100 translate-x-0' : 'opacity-0 -translate-x-4'
      }`}
      style={{ paddingLeft: `${depth * 16 + 8}px`, transitionDelay: `${delay}ms` }}
    >
      <FileCode2 size={12} className="text-primary flex-shrink-0" />
      <span className="text-xs font-mono text-ink truncate">{name}</span>
    </div>
  );
}

export function BuildReplay({
  sessionId,
  files,
  phases,
  checkpoints,
  qualityGates,
  totalIterations,
  onShare,
}: BuildReplayProps) {
  const [playing, setPlaying] = useState(false);
  const [speedIndex, setSpeedIndex] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const animFrameRef = useRef<number | null>(null);
  const lastTickRef = useRef<number>(0);

  const timeline = useRef<ReplayEvent[]>([]);
  if (timeline.current.length === 0) {
    timeline.current = buildReplayTimeline({ sessionId, files, phases, checkpoints, qualityGates, totalIterations });
  }

  const totalDuration = timeline.current.length > 0
    ? timeline.current[timeline.current.length - 1].timestamp + 600
    : 1;

  const visibleEvents = timeline.current.filter(e => e.timestamp <= currentTime);
  const visibleFiles = new Set(
    visibleEvents.filter(e => e.type === 'file_created').map(e => e.detail!)
  );
  const currentPhase = [...visibleEvents].reverse().find(e => e.type === 'phase_change')?.phase || 'idle';
  const passedGates = visibleEvents.filter(e => e.type === 'gate_pass').length;
  const failedGates = visibleEvents.filter(e => e.type === 'gate_fail').length;
  const currentIter = [...visibleEvents].reverse().find(e => e.type === 'iteration')?.label || '';

  const speed = SPEEDS[speedIndex];

  const tick = useCallback((now: number) => {
    if (lastTickRef.current === 0) lastTickRef.current = now;
    const delta = (now - lastTickRef.current) * speed;
    lastTickRef.current = now;

    setCurrentTime(prev => {
      const next = prev + delta;
      if (next >= totalDuration) {
        setPlaying(false);
        return totalDuration;
      }
      return next;
    });

    animFrameRef.current = requestAnimationFrame(tick);
  }, [speed, totalDuration]);

  useEffect(() => {
    if (playing) {
      lastTickRef.current = 0;
      animFrameRef.current = requestAnimationFrame(tick);
    } else if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
    }
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [playing, tick]);

  const handleReset = () => {
    setPlaying(false);
    setCurrentTime(0);
  };

  const handleScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    setCurrentTime(Number(e.target.value));
  };

  const handleShare = () => {
    const summary = [
      `Build Replay: Session ${sessionId}`,
      `Total iterations: ${totalIterations}`,
      `Files created: ${files.filter(f => f.type === 'file').length}`,
      `Quality gates: ${passedGates} passed, ${failedGates} failed`,
      `Phases: ${phases.join(' > ')}`,
    ].join('\n');
    onShare?.(summary);
  };

  const progress = totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0;

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="flex items-center gap-2 px-3 py-2 text-xs font-medium text-primary hover:bg-primary/5 rounded-card transition-colors"
      >
        <Play size={14} />
        Replay Build
      </button>
    );
  }

  return (
    <div className="card overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 className="text-sm font-semibold text-ink uppercase tracking-wider">
          Build Replay
        </h3>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setExpanded(false)}
            className="text-xs text-muted hover:text-ink transition-colors"
          >
            Collapse
          </button>
        </div>
      </div>

      {/* Replay viewport */}
      <div className="grid grid-cols-2 gap-0 min-h-[240px]">
        {/* Left: File tree growing */}
        <div className="border-r border-border p-3 overflow-y-auto terminal-scroll max-h-[300px]">
          <div className="text-[11px] font-semibold text-muted uppercase tracking-wider mb-2">
            File Tree
          </div>
          {files.filter(f => f.type === 'file').length === 0 ? (
            <div className="text-xs text-muted py-4 text-center">No files to display</div>
          ) : (
            files
              .filter(f => f.type === 'file')
              .map((f, i) => (
                <FileTreeNode
                  key={f.path}
                  path={f.path}
                  visible={visibleFiles.has(f.path)}
                  delay={i * 30}
                />
              ))
          )}
        </div>

        {/* Right: Event log */}
        <div className="p-3 overflow-y-auto terminal-scroll max-h-[300px]">
          <div className="text-[11px] font-semibold text-muted uppercase tracking-wider mb-2">
            Activity
          </div>
          <div className="space-y-1">
            {visibleEvents.slice(-20).map((evt, i) => (
              <div
                key={`${evt.timestamp}-${i}`}
                className="flex items-center gap-2 text-xs animate-fade-in"
              >
                {evt.type === 'file_created' && <FileCode2 size={11} className="text-primary flex-shrink-0" />}
                {evt.type === 'phase_change' && <Clock size={11} className="text-info flex-shrink-0" />}
                {evt.type === 'gate_pass' && <CheckCircle2 size={11} className="text-success flex-shrink-0" />}
                {evt.type === 'gate_fail' && <CheckCircle2 size={11} className="text-danger flex-shrink-0" />}
                {evt.type === 'iteration' && <SkipForward size={11} className="text-muted flex-shrink-0" />}
                <span className={`truncate ${
                  evt.type === 'phase_change' ? 'font-semibold text-ink' :
                  evt.type === 'gate_fail' ? 'text-danger' :
                  'text-secondary'
                }`}>
                  {evt.label}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Status bar */}
      <div className="flex items-center gap-4 px-4 py-2 bg-hover/50 border-t border-border text-xs text-muted">
        <span className="font-medium text-ink capitalize">{currentPhase}</span>
        <span>{visibleFiles.size} files</span>
        <span className="text-success">{passedGates} passed</span>
        {failedGates > 0 && <span className="text-danger">{failedGates} failed</span>}
        {currentIter && <span className="font-mono">{currentIter}</span>}
      </div>

      {/* Timeline scrubber */}
      <div className="px-4 py-2 border-t border-border">
        <div className="relative w-full h-1.5 bg-border rounded-full overflow-hidden mb-2">
          <div
            className="h-full bg-gradient-to-r from-primary to-teal rounded-full transition-all duration-100"
            style={{ width: `${progress}%` }}
          />
        </div>
        <input
          type="range"
          min={0}
          max={totalDuration}
          value={currentTime}
          onChange={handleScrub}
          className="w-full h-1 opacity-0 absolute cursor-pointer"
          style={{ marginTop: '-14px' }}
        />
      </div>

      {/* Controls */}
      <div className="flex items-center justify-between px-4 py-2 border-t border-border">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setPlaying(!playing)}
            className="p-1.5 rounded-card hover:bg-hover transition-colors text-ink"
            title={playing ? 'Pause' : 'Play'}
          >
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <button
            onClick={handleReset}
            className="p-1.5 rounded-card hover:bg-hover transition-colors text-muted"
            title="Reset"
          >
            <RotateCcw size={14} />
          </button>
          <button
            onClick={() => setSpeedIndex((speedIndex + 1) % SPEEDS.length)}
            className="px-2 py-1 rounded-card hover:bg-hover transition-colors text-xs font-mono text-muted"
            title="Playback speed"
          >
            {speed}x
          </button>
        </div>

        <button
          onClick={handleShare}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/5 rounded-card transition-colors"
        >
          <Share2 size={12} />
          Share Replay
        </button>
      </div>
    </div>
  );
}
