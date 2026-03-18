import { useCallback } from 'react';
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
  const { connected } = useWebSocket();

  const fetchStatus = useCallback(() => api.getStatus(), []);
  const fetchAgents = useCallback(() => api.getAgents(), []);
  const fetchLogs = useCallback(() => api.getLogs(200), []);
  const fetchMemory = useCallback(() => api.getMemorySummary(), []);
  const fetchChecklist = useCallback(() => api.getChecklist(), []);
  const fetchFiles = useCallback(() => api.getFiles(), []);

  const { data: status } = usePolling(fetchStatus, 2000);
  const { data: agents, loading: agentsLoading } = usePolling(fetchAgents, 3000);
  const { data: logs, loading: logsLoading } = usePolling(fetchLogs, 2000);
  const { data: memory, loading: memoryLoading } = usePolling(fetchMemory, 5000);
  const { data: checklist, loading: checklistLoading } = usePolling(fetchChecklist, 5000);
  const { data: files, loading: filesLoading } = usePolling(fetchFiles, 10000);

  const isRunning = status?.running || false;

  const handleStartBuild = useCallback((_prd: string, _provider: string) => {
    // In a full integration, this would POST to the API to start a Loki Mode session.
    // The dashboard API currently reads from .loki/ filesystem state,
    // so starting is done via CLI: `loki start --provider <provider> <prd-file>`
    console.log('Start build requested. Use CLI: loki start --provider <provider> <prd-path>');
  }, []);

  return (
    <div className="min-h-screen bg-background relative">
      {/* Background pattern */}
      <div className="pattern-circles" />

      <Header status={status} wsConnected={connected} />

      <main className="max-w-[1920px] mx-auto px-6 py-6 relative z-10">
        {/* Status bar */}
        <ControlBar status={status} />

        {/* Stats overview */}
        <div className="mt-4">
          <StatusOverview status={status} />
        </div>

        {/* Main layout: 3-column grid */}
        <div className="mt-6 grid grid-cols-12 gap-6" style={{ minHeight: 'calc(100vh - 280px)' }}>
          {/* Left column: PRD Input + Phase */}
          <div className="col-span-3 flex flex-col gap-6">
            <PRDInput onSubmit={handleStartBuild} running={isRunning} />
            <PhaseVisualizer
              currentPhase={status?.phase || 'idle'}
              iteration={status?.iteration || 0}
            />
          </div>

          {/* Center column: Terminal Output */}
          <div className="col-span-5 flex flex-col">
            <TerminalOutput logs={logs} loading={logsLoading} />
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
      </main>
    </div>
  );
}
