import { useState, useCallback, useEffect } from 'react';
import { api } from './api/client';
import { usePolling } from './hooks/usePolling';
import { useWebSocket, StateUpdate } from './hooks/useWebSocket';
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
import { ReportPanel } from './components/ReportPanel';
import { MetricsPanel } from './components/MetricsPanel';
import { SessionHistory } from './components/SessionHistory';
import type { StatusResponse, Agent, LogEntry, FileNode } from './types/api';
import type { SessionDetail } from './api/client';

export default function App() {
  const [startError, setStartError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [currentPrd, setCurrentPrd] = useState<string | null>(null);
  const [wasRunning, setWasRunning] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [showMetrics, setShowMetrics] = useState(false);
  const [activeTab, setActiveTab] = useState<'terminal' | 'metrics'>('terminal');
  const [selectedProvider, setSelectedProvider] = useState('claude');
  const [viewingSession, setViewingSession] = useState<SessionDetail | null>(null);

  // Primary state -- populated by WebSocket state_update pushes
  const [wsStatus, setWsStatus] = useState<StatusResponse | null>(null);
  const [wsAgents, setWsAgents] = useState<Agent[] | null>(null);
  const [wsLogs, setWsLogs] = useState<LogEntry[] | null>(null);

  // Called by WebSocket hook when a state_update message arrives
  const handleStateUpdate = useCallback((update: StateUpdate) => {
    setWsStatus(update.status);
    setWsAgents(update.agents);
    setWsLogs(update.logs);
    setIsRunning(update.status.running ?? false);
    setIsPaused(update.status.paused ?? false);
  }, []);

  const { connected, subscribe } = useWebSocket(handleStateUpdate);

  // Fallback HTTP poll for status (30s) -- only when WebSocket is disconnected
  const fetchStatus = useCallback(() => api.getStatus(), []);
  const { data: httpStatus } = usePolling(fetchStatus, 30000, !connected);

  // Sync isRunning and status from HTTP fallback when WebSocket has no data
  useEffect(() => {
    if (wsStatus === null && httpStatus !== null) {
      setIsRunning(httpStatus.running ?? false);
      setIsPaused(httpStatus.paused ?? false);
    }
  }, [httpStatus, wsStatus]);

  // Track wasRunning to show report/metrics after session ends
  useEffect(() => {
    if (isRunning) {
      setWasRunning(true);
    }
  }, [isRunning]);

  // Rarely-changing data: memory, checklist, files -- slow HTTP polls (30s)
  // These are not pushed over WebSocket since they change infrequently
  const fetchMemory = useCallback(() => api.getMemorySummary(), []);
  const fetchChecklist = useCallback(() => api.getChecklist(), []);
  const fetchFiles = useCallback(() => api.getFiles(), []);

  const { data: memory, loading: memoryLoading } = usePolling(fetchMemory, 30000, isRunning);
  const { data: checklist, loading: checklistLoading } = usePolling(fetchChecklist, 30000, isRunning);
  const { data: files, loading: filesLoading } = usePolling(fetchFiles, 30000, isRunning);

  // Resolve status/agents/logs: prefer WebSocket push, fall back to HTTP
  const status = wsStatus ?? httpStatus;
  const agents = wsAgents;
  const logs = wsLogs;
  const agentsLoading = wsAgents === null;
  const logsLoading = wsLogs === null;

  const handleStartBuild = useCallback(async (prd: string, provider: string, projectDir?: string, mode?: string) => {
    setStartError(null);
    setWasRunning(false);
    setShowReport(false);
    setActiveTab('terminal');
    try {
      await api.startSession({ prd, provider, projectDir, mode });
      setCurrentPrd(prd);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : 'Failed to start session');
    }
  }, []);

  const handleStopBuild = useCallback(async () => {
    try {
      const result = await api.stopSession();
      if (result.stopped) {
        setIsRunning(false);
        setIsPaused(false);
        setCurrentPrd(null);
        // Clear WS state so stale data doesn't linger
        setWsStatus(null);
        setWsAgents(null);
        setWsLogs(null);
      }
    } catch {
      // Force UI to stopped state even on error -- process likely died
      setIsRunning(false);
      setIsPaused(false);
      setCurrentPrd(null);
    }
  }, []);

  const handleLoadSession = useCallback(async (item: { id: string }) => {
    try {
      const detail = await api.getSessionDetail(item.id);
      setViewingSession(detail);
    } catch {
      // Session detail not available
    }
  }, []);

  const handleProviderChange = useCallback((provider: string) => {
    setSelectedProvider(provider);
  }, []);

  const handlePause = useCallback(async () => {
    try {
      await api.pauseSession();
      setIsPaused(true);
    } catch {
      // pause not supported or failed -- ignore
    }
  }, []);

  const handleResume = useCallback(async () => {
    try {
      await api.resumeSession();
      setIsPaused(false);
    } catch {
      // resume not supported or failed -- ignore
    }
  }, []);

  // Derive a PRD summary from the first non-blank line
  const prdSummary = currentPrd
    ? currentPrd.replace(/^#+\s*/gm, '').split('\n').find(l => l.trim().length > 0) || null
    : null;

  return (
    <div className="min-h-screen bg-background relative">
      {/* Background pattern */}
      <div className="pattern-circles" />

      <Header status={status} wsConnected={connected} onProviderChange={handleProviderChange} selectedProvider={selectedProvider} />

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
                provider={selectedProvider}
                onProviderChange={handleProviderChange}
              />
            </div>

            {/* Post-build: report and metrics */}
            {wasRunning && !isRunning && (
              <div className="w-full max-w-3xl mt-4 flex flex-col gap-4">
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setShowReport(!showReport)}
                    className="px-4 py-2 rounded-xl text-sm font-semibold border border-accent-product/30 text-accent-product hover:bg-accent-product/5 transition-all"
                  >
                    {showReport ? 'Hide Report Panel' : 'Report'}
                  </button>
                  <button
                    onClick={() => setShowMetrics(!showMetrics)}
                    className="px-4 py-2 rounded-xl text-sm font-semibold border border-white/30 text-slate hover:text-charcoal hover:bg-white/30 transition-all"
                  >
                    {showMetrics ? 'Hide Metrics' : 'View Metrics'}
                  </button>
                </div>
                <ReportPanel visible={showReport} />
                <MetricsPanel visible={showMetrics} />
              </div>
            )}

            {/* Past session viewer */}
            {viewingSession && (
              <div className="w-full max-w-3xl mt-4">
                <div className="glass p-4 rounded-2xl">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-charcoal uppercase tracking-wider">
                      Session: {viewingSession.id}
                    </h3>
                    <button
                      onClick={() => setViewingSession(null)}
                      className="text-xs text-slate hover:text-charcoal transition-colors px-2 py-1 rounded-lg hover:bg-white/30"
                    >
                      Close
                    </button>
                  </div>
                  <div className="text-[10px] font-mono text-slate mb-3">{viewingSession.path}</div>

                  {/* PRD preview */}
                  {viewingSession.prd && (
                    <div className="mb-3">
                      <div className="text-[10px] text-slate uppercase tracking-wider font-semibold mb-1">PRD</div>
                      <div className="bg-charcoal/[0.03] rounded-lg p-3 font-mono text-xs text-charcoal/80 max-h-32 overflow-y-auto terminal-scroll whitespace-pre-wrap">
                        {viewingSession.prd.slice(0, 500)}{viewingSession.prd.length > 500 ? '...' : ''}
                      </div>
                    </div>
                  )}

                  {/* File tree */}
                  {viewingSession.files.length > 0 && (
                    <div className="mb-3">
                      <div className="text-[10px] text-slate uppercase tracking-wider font-semibold mb-1">
                        Files ({viewingSession.files.length})
                      </div>
                      <div className="bg-charcoal/[0.03] rounded-lg p-3 font-mono text-xs max-h-40 overflow-y-auto terminal-scroll">
                        {viewingSession.files.map((f: FileNode, i: number) => (
                          <div key={i} className="text-charcoal/70">
                            {f.type === 'directory' ? `${f.name}/` : f.name}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Logs */}
                  {viewingSession.logs.length > 0 && (
                    <div>
                      <div className="text-[10px] text-slate uppercase tracking-wider font-semibold mb-1">
                        Logs ({viewingSession.logs.length} lines)
                      </div>
                      <div className="bg-charcoal/[0.03] rounded-lg p-3 font-mono text-[10px] max-h-40 overflow-y-auto terminal-scroll">
                        {viewingSession.logs.map((line: string, i: number) => (
                          <div key={i} className="text-charcoal/70">{line}</div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Session history */}
            <div className="w-full max-w-3xl mt-4">
              <SessionHistory onLoadSession={handleLoadSession} />
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
            {/* Status bar with stop/pause/resume buttons */}
            <ControlBar
              status={status}
              prdSummary={prdSummary}
              onStop={handleStopBuild}
              onPause={handlePause}
              onResume={handleResume}
              isPaused={isPaused}
            />

            {/* Stats overview */}
            <div className="mt-4">
              <StatusOverview status={status} />
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

              {/* Center column: Terminal Output + Metrics tab */}
              <div className="col-span-5 flex flex-col gap-0">
                <div className="flex items-center gap-1 mb-2">
                  <button
                    onClick={() => setActiveTab('terminal')}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                      activeTab === 'terminal'
                        ? 'bg-accent-product text-white'
                        : 'text-slate hover:text-charcoal hover:bg-white/30'
                    }`}
                  >
                    Terminal
                  </button>
                  <button
                    onClick={() => setActiveTab('metrics')}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                      activeTab === 'metrics'
                        ? 'bg-accent-product text-white'
                        : 'text-slate hover:text-charcoal hover:bg-white/30'
                    }`}
                  >
                    Metrics
                  </button>
                </div>
                {activeTab === 'terminal' ? (
                  <TerminalOutput logs={logs} loading={logsLoading} subscribe={subscribe} />
                ) : (
                  <MetricsPanel visible={true} />
                )}
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
