import { useState, useCallback, useEffect } from 'react';
import { api } from './api/client';
import { usePolling } from './hooks/usePolling';
import { useWebSocket } from './hooks/useWebSocket';
import { Header } from './components/Header';
import { ControlBar } from './components/ControlBar';
import { StatusOverview } from './components/StatusOverview';
import { PRDInput } from './components/PRDInput';
import { PhaseVisualizer } from './components/PhaseVisualizer';
import { AgentDashboard } from './components/AgentDashboard';
import { TerminalOutput } from './components/TerminalOutput';
import { QualityGatesPanel } from './components/QualityGatesPanel';
import { FileBrowser } from './components/FileBrowser';
import { MemoryViewer } from './components/MemoryViewer';

export default function App() {
  const { connected, subscribe } = useWebSocket();
  const [startError, setStartError] = useState<string | null>(null);

  const fetchStatus = useCallback(() => api.getStatus(), []);
  const fetchAgents = useCallback(() => api.getAgents(), []);
  const fetchLogs = useCallback(() => api.getLogs(200), []);
  const fetchMemory = useCallback(() => api.getMemorySummary(), []);
  const fetchChecklist = useCallback(() => api.getChecklist(), []);
  const fetchFiles = useCallback(() => api.getFiles(), []);

  // Status polls at 2s when running, 30s when idle -- everything else pauses when idle
  const [isRunning, setIsRunning] = useState(false);
  const { data: status } = usePolling(fetchStatus, isRunning ? 2000 : 30000);
  const { data: agents, loading: agentsLoading } = usePolling(fetchAgents, 3000, isRunning);
  const { data: logs, loading: logsLoading } = usePolling(fetchLogs, 2000, isRunning);
  const { data: memory, loading: memoryLoading } = usePolling(fetchMemory, 5000, isRunning);
  const { data: checklist, loading: checklistLoading } = usePolling(fetchChecklist, 5000, isRunning);
  const { data: files, loading: filesLoading } = usePolling(fetchFiles, 10000, isRunning);

  // Sync isRunning from status response
  useEffect(() => {
    if (status !== null) setIsRunning(status.running ?? false);
  }, [status]);

  const handleStartBuild = useCallback(async (prd: string, provider: string) => {
    setStartError(null);
    try {
      await api.startSession({ prd, provider });
    } catch (e) {
      setStartError(e instanceof Error ? e.message : 'Failed to start session');
    }
  }, []);

  const handleStopBuild = useCallback(async () => {
    try {
      await api.stopSession();
    } catch {
      // ignore stop errors
    }
  }, []);

  return (
    <div className="min-h-screen bg-background relative">
      {/* Background pattern */}
      <div className="pattern-circles" />

      <Header status={status} wsConnected={connected} />

      <main className="max-w-[1920px] mx-auto px-6 py-6 relative z-10">
        {!isRunning ? (
          /* ========== LANDING STATE: PRD Input is the hero ========== */
          <div className="flex flex-col items-center">
            {/* Hero section */}
            <div className="text-center mt-8 mb-8">
              <h2 className="text-3xl font-bold text-charcoal tracking-tight">
                Describe it. Build it. Ship it.
              </h2>
              <p className="text-slate mt-2 text-base max-w-lg mx-auto">
                Paste a PRD or pick a template. Purple Lab spins up autonomous agents
                to build your project from scratch.
              </p>
            </div>

            {/* PRD Input -- full width, prominent */}
            <div className="w-full max-w-3xl">
              <PRDInput
                onSubmit={handleStartBuild}
                running={isRunning}
                error={startError}
              />
            </div>

            {/* Connection status hint */}
            <div className="mt-6 text-xs text-slate flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${connected ? 'bg-success' : 'bg-danger'}`} />
              {connected ? 'Connected to Purple Lab backend' : 'Waiting for backend connection...'}
            </div>
          </div>
        ) : (
          /* ========== RUNNING STATE: Monitoring panels ========== */
          <>
            {/* Status bar */}
            <ControlBar status={status} />

            {/* Stats overview */}
            <div className="mt-4">
              <StatusOverview status={status} />
            </div>

            {/* Stop button */}
            <div className="mt-4 flex justify-end">
              <button
                onClick={handleStopBuild}
                className="px-5 py-2 rounded-xl text-sm font-semibold bg-danger/10 text-danger border border-danger/20 hover:bg-danger/20 transition-colors"
              >
                Stop Session
              </button>
            </div>

            {/* Main layout: 3-column grid */}
            <div className="mt-4 grid grid-cols-12 gap-6" style={{ minHeight: 'calc(100vh - 340px)' }}>
              {/* Left column: Phase + PRD (collapsed) */}
              <div className="col-span-3 flex flex-col gap-6">
                <PhaseVisualizer
                  currentPhase={status?.phase || 'idle'}
                  iteration={status?.iteration || 0}
                />
              </div>

              {/* Center column: Terminal Output */}
              <div className="col-span-5 flex flex-col">
                <TerminalOutput logs={logs} loading={logsLoading} subscribe={subscribe} />
              </div>

              {/* Right column: Agents + Quality Gates */}
              <div className="col-span-4 flex flex-col gap-6">
                <AgentDashboard agents={agents} loading={agentsLoading} />
                <QualityGatesPanel checklist={checklist} loading={checklistLoading} />
              </div>
            </div>

            {/* Bottom row: File Browser + Memory Viewer */}
            <div className="mt-6 grid grid-cols-12 gap-6">
              <div className="col-span-6">
                <FileBrowser files={files} loading={filesLoading} />
              </div>
              <div className="col-span-6">
                <MemoryViewer memory={memory} loading={memoryLoading} />
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
