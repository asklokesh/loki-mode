import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import { useWebSocket, StateUpdate } from '../hooks/useWebSocket';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { ControlBar } from '../components/ControlBar';
import { StatusOverview } from '../components/StatusOverview';
import { PRDInput } from '../components/PRDInput';
import { PhaseVisualizer } from '../components/PhaseVisualizer';
import { AgentDashboard } from '../components/AgentDashboard';
import { TerminalOutput } from '../components/TerminalOutput';
import { QualityGatesPanel } from '../components/QualityGatesPanel';
import { FileBrowser } from '../components/FileBrowser';
import { MemoryViewer } from '../components/MemoryViewer';
import { ReportPanel } from '../components/ReportPanel';
import { MetricsPanel } from '../components/MetricsPanel';
import { SessionHistory } from '../components/SessionHistory';
import { TrustedBy } from '../components/TrustedBy';
import { HowItWorks } from '../components/HowItWorks';
import { TemplateShowcase } from '../components/TemplateShowcase';
import { BenefitCards } from '../components/BenefitCards';
import { Footer } from '../components/Footer';
import type { StatusResponse, Agent, LogEntry } from '../types/api';

const CYCLING_PROMPTS = [
  "Build a SaaS dashboard with user analytics...",
  "Create a REST API with authentication...",
  "Make a landing page with pricing tiers...",
  "Build a chat app with real-time messaging...",
  "Create an e-commerce store with Stripe...",
];

export default function HomePage() {
  const navigate = useNavigate();
  const [startError, setStartError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(() => sessionStorage.getItem('pl_running') === '1');
  const [isPaused, setIsPaused] = useState(false);
  const [currentPrd, setCurrentPrd] = useState<string | null>(() => sessionStorage.getItem('pl_prd'));
  const [wasRunning, setWasRunning] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [showMetrics, setShowMetrics] = useState(false);
  const [activeTab, setActiveTab] = useState<'terminal' | 'metrics'>(
    () => (sessionStorage.getItem('pl_tab') as 'terminal' | 'metrics') || 'terminal'
  );
  const [selectedProvider, setSelectedProvider] = useState(
    () => sessionStorage.getItem('pl_provider') || 'claude'
  );
  const [templatePrd, setTemplatePrd] = useState<string | undefined>(undefined);

  // Quick-start input state
  const [quickPrompt, setQuickPrompt] = useState('');
  const [quickSubmitting, setQuickSubmitting] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [promptIndex, setPromptIndex] = useState(0);
  const [placeholderFading, setPlaceholderFading] = useState(false);
  const quickInputRef = useRef<HTMLInputElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);

  // Cycling placeholder animation
  useEffect(() => {
    const interval = setInterval(() => {
      setPlaceholderFading(true);
      setTimeout(() => {
        setPromptIndex(i => (i + 1) % CYCLING_PROMPTS.length);
        setPlaceholderFading(false);
      }, 300);
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  // Check for template prefill from TemplatesPage navigation
  useEffect(() => {
    const templateFile = sessionStorage.getItem('pl_template');
    if (templateFile) {
      sessionStorage.removeItem('pl_template');
      api.getTemplateContent(templateFile)
        .then(({ content }) => {
          if (content) {
            setTemplatePrd(content);
            setShowAdvanced(true);
          }
        })
        .catch(() => {
          // Template load failed -- ignore, user can still type manually
        });
    }
  }, []);

  // Primary state -- populated by WebSocket state_update pushes
  const [wsStatus, setWsStatus] = useState<StatusResponse | null>(null);
  const [wsAgents, setWsAgents] = useState<Agent[] | null>(null);
  const [wsLogs, setWsLogs] = useState<LogEntry[] | null>(null);

  const handleStateUpdate = useCallback((update: StateUpdate) => {
    if (!update) {
      setWsStatus(null);
      setWsAgents(null);
      setWsLogs(null);
      return;
    }
    setWsStatus(update.status);
    setWsAgents(update.agents);
    setWsLogs(update.logs);
    setIsRunning(update.status.running ?? false);
    setIsPaused(update.status.paused ?? false);
  }, []);

  const { connected, subscribe } = useWebSocket(handleStateUpdate);

  const fetchStatus = useCallback(() => api.getStatus(), []);
  const { data: httpStatus } = usePolling(fetchStatus, 30000, !connected);

  useEffect(() => {
    if (wsStatus === null && httpStatus !== null) {
      setIsRunning(httpStatus.running ?? false);
      setIsPaused(httpStatus.paused ?? false);
    }
  }, [httpStatus, wsStatus]);

  // Persist state to sessionStorage
  useEffect(() => {
    sessionStorage.setItem('pl_running', isRunning ? '1' : '0');
    if (isRunning) setWasRunning(true);
  }, [isRunning]);
  useEffect(() => {
    if (currentPrd) sessionStorage.setItem('pl_prd', currentPrd);
    else sessionStorage.removeItem('pl_prd');
  }, [currentPrd]);
  useEffect(() => { sessionStorage.setItem('pl_provider', selectedProvider); }, [selectedProvider]);
  useEffect(() => { sessionStorage.setItem('pl_tab', activeTab); }, [activeTab]);

  const fetchMemory = useCallback(() => api.getMemorySummary(), []);
  const fetchChecklist = useCallback(() => api.getChecklist(), []);
  const fetchFiles = useCallback(() => api.getFiles(), []);

  const { data: memory, loading: memoryLoading } = usePolling(fetchMemory, 30000, isRunning);
  const { data: checklist, loading: checklistLoading } = usePolling(fetchChecklist, 30000, isRunning);
  const { data: files, loading: filesLoading } = usePolling(fetchFiles, 30000, isRunning);

  const status = wsStatus ?? httpStatus;
  const agents = wsAgents;
  const logs = wsLogs;
  const agentsLoading = wsAgents === null;
  const logsLoading = wsLogs === null;

  // Quick-start handler: one-line prompt -> build
  const handleQuickStart = useCallback(async () => {
    const prompt = quickPrompt.trim();
    if (!prompt || quickSubmitting) return;
    setStartError(null);
    setQuickSubmitting(true);
    setWasRunning(false);
    setShowReport(false);
    setActiveTab('terminal');
    try {
      const result = await api.quickStart(prompt, selectedProvider);
      if (result.started && result.session_id) {
        setCurrentPrd(prompt);
        setIsRunning(true);
        navigate(`/project/${result.session_id}`);
      }
    } catch (e) {
      setStartError(e instanceof Error ? e.message : 'Failed to start build');
    } finally {
      setQuickSubmitting(false);
    }
  }, [quickPrompt, quickSubmitting, selectedProvider, navigate]);

  // Full PRD start handler (used by advanced PRDInput)
  const handleStartBuild = useCallback(async (prd: string, provider: string, projectDir?: string, mode?: string) => {
    setStartError(null);
    setWasRunning(false);
    setShowReport(false);
    setActiveTab('terminal');
    try {
      await api.startSession({ prd, provider, projectDir, mode });
      setCurrentPrd(prd);
      setIsRunning(true);
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
        setWsStatus(null);
        setWsAgents(null);
        setWsLogs(null);
      }
    } catch {
      setIsRunning(false);
      setIsPaused(false);
      setCurrentPrd(null);
    }
    sessionStorage.removeItem('pl_running');
    sessionStorage.removeItem('pl_prd');
    sessionStorage.removeItem('pl_tab');
  }, []);

  const handleLoadSession = useCallback((item: { id: string }) => {
    navigate(`/project/${item.id}`);
  }, [navigate]);

  const handleProviderChange = useCallback((provider: string) => {
    setSelectedProvider(provider);
  }, []);

  const handlePause = useCallback(async () => {
    try { await api.pauseSession(); setIsPaused(true); } catch { /* ignore */ }
  }, []);

  const handleResume = useCallback(async () => {
    try { await api.resumeSession(); setIsPaused(false); } catch { /* ignore */ }
  }, []);

  const prdSummary = currentPrd
    ? currentPrd.replace(/^#+\s*/gm, '').split('\n').find(l => l.trim().length > 0) || null
    : null;

  return (
    <div className="min-h-screen bg-[#FAF9F6] relative">
      <div className="pattern-nodes" />

      <div className="max-w-[1920px] mx-auto px-6 py-6 relative z-10">
        {!isRunning ? (
          <div className="flex flex-col items-center">
            {/* Hero section */}
            <div ref={heroRef} className="text-center mt-12 mb-10">
              <h2 className="font-heading text-h1 text-[#36342E]">
                Describe it. Build it. Ship it.
              </h2>
              <p className="text-[#6B6960] mt-3 text-base max-w-xl mx-auto">
                Type what you want to build. Purple Lab handles the rest --
                from code to containers, autonomously.
              </p>
            </div>

            {/* One-line quick-start input */}
            <div className="w-full max-w-2xl">
              <div className="relative">
                <input
                  ref={quickInputRef}
                  type="text"
                  value={quickPrompt}
                  onChange={(e) => setQuickPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleQuickStart();
                    }
                  }}
                  className="w-full text-xl px-6 py-4 rounded-2xl bg-white border border-[#ECEAE3] shadow-sm focus:outline-none focus:ring-2 focus:ring-[#553DE9]/30 focus:border-[#553DE9]/40 focus:shadow-lg transition-all placeholder:text-transparent"
                  disabled={quickSubmitting}
                  aria-label="Describe what you want to build"
                />
                {/* Cycling placeholder overlay */}
                {!quickPrompt && (
                  <div
                    className="absolute left-6 top-1/2 -translate-y-1/2 text-xl text-[#6B6960]/50 pointer-events-none select-none"
                    aria-hidden="true"
                  >
                    <span
                      key={promptIndex}
                      className={placeholderFading ? 'quick-input-placeholder-exit' : 'quick-input-placeholder'}
                    >
                      {CYCLING_PROMPTS[promptIndex]}
                    </span>
                  </div>
                )}
              </div>

              {/* Start Building button */}
              <div className="mt-4 flex items-center justify-center gap-4">
                <button
                  onClick={handleQuickStart}
                  disabled={!quickPrompt.trim() || quickSubmitting}
                  className={`px-8 py-3 rounded-xl text-base font-semibold transition-all ${
                    !quickPrompt.trim() || quickSubmitting
                      ? 'bg-[#553DE9]/20 text-[#553DE9]/40 cursor-not-allowed'
                      : 'bg-[#553DE9] text-white hover:bg-[#4832c7] shadow-lg shadow-[#553DE9]/25 hover:shadow-xl hover:shadow-[#553DE9]/30 active:scale-[0.98]'
                  }`}
                >
                  {quickSubmitting ? 'Starting...' : 'Start Building'}
                </button>
              </div>

              {/* Error display */}
              {startError && (
                <div className="mt-3 px-4 py-2.5 rounded-xl bg-[#C45B5B]/10 border border-[#C45B5B]/20 text-[#C45B5B] text-sm font-medium text-center">
                  {startError}
                </div>
              )}

              {/* Advanced (full PRD) toggle */}
              <div className="mt-6 text-center">
                <button
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="text-sm text-[#553DE9] hover:text-[#4832c7] font-medium transition-colors"
                >
                  {showAdvanced ? 'Hide advanced options' : 'Advanced (write full PRD)'}
                </button>
              </div>

              {/* Collapsible advanced PRD section */}
              {showAdvanced && (
                <div className="mt-4">
                  <PRDInput
                    onSubmit={handleStartBuild}
                    running={isRunning}
                    error={startError}
                    provider={selectedProvider}
                    onProviderChange={handleProviderChange}
                    initialPrd={templatePrd}
                  />
                </div>
              )}
            </div>

            {/* Post-build actions */}
            {wasRunning && !isRunning && (
              <div className="w-full max-w-3xl mt-6 flex flex-col gap-4">
                <button
                  onClick={async () => {
                    try {
                      const sessions = await api.getSessionsHistory();
                      if (sessions.length > 0) navigate(`/project/${sessions[0].id}`);
                    } catch { /* ignore */ }
                  }}
                  className="w-full px-6 py-4 rounded-card text-base font-bold bg-[#553DE9] text-white hover:bg-[#553DE9]/90 transition-all shadow-lg shadow-[#553DE9]/20"
                >
                  View Project -- Browse Files and Preview
                </button>
                <div className="flex items-center gap-3">
                  <button onClick={() => setShowReport(!showReport)}
                    className="px-4 py-2 rounded-card text-sm font-semibold border border-[#553DE9]/30 text-[#553DE9] hover:bg-[#553DE9]/5 transition-all">
                    {showReport ? 'Hide Report' : 'Report'}
                  </button>
                  <button onClick={() => setShowMetrics(!showMetrics)}
                    className="px-4 py-2 rounded-card text-sm font-semibold border border-[#ECEAE3] text-[#6B6960] hover:text-[#36342E] hover:bg-[#F8F4F0] transition-all">
                    {showMetrics ? 'Hide Metrics' : 'Metrics'}
                  </button>
                </div>
                <ReportPanel visible={showReport} />
                <MetricsPanel visible={showMetrics} />
              </div>
            )}

            <div className="w-full max-w-3xl mt-6">
              <SessionHistory onLoadSession={handleLoadSession} />
            </div>

            <div className="mt-6 text-xs text-[#6B6960] flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${connected ? 'bg-[#1FC5A8]' : 'bg-[#C45B5B]'}`} />
              {connected ? 'Connected to Purple Lab backend' : 'Waiting for backend connection...'}
            </div>

            {/* --- Below the fold sections --- */}

            {/* 1. Trusted By */}
            <TrustedBy />

            {/* 2. How It Works */}
            <HowItWorks />

            {/* 3. Template Showcase */}
            <TemplateShowcase />

            {/* 4. Why Loki Mode (Benefit Cards) */}
            <BenefitCards />

            {/* 5. Call to Action */}
            <section className="w-full max-w-3xl mx-auto py-16">
              <div className="rounded-2xl bg-gradient-to-br from-[#553DE9]/5 via-[#553DE9]/10 to-[#1FC5A8]/5 border border-[#553DE9]/15 p-10 text-center">
                <h2 className="font-heading text-h2 text-[#36342E] mb-3">
                  Ready to build something amazing?
                </h2>
                <p className="text-sm text-[#6B6960] mb-6 max-w-md mx-auto">
                  Go from idea to deployed product in minutes, not months. Let AI handle the heavy lifting.
                </p>
                <div className="flex items-center justify-center gap-3 flex-wrap">
                  <button
                    onClick={() => {
                      heroRef.current?.scrollIntoView({ behavior: 'smooth' });
                      setTimeout(() => quickInputRef.current?.focus(), 500);
                    }}
                    className="px-8 py-3 rounded-xl text-base font-semibold bg-[#553DE9] text-white hover:bg-[#4832c7] shadow-lg shadow-[#553DE9]/25 hover:shadow-xl hover:shadow-[#553DE9]/30 active:scale-[0.98] transition-all"
                  >
                    Start Building
                  </button>
                  <button
                    onClick={() => navigate('/templates')}
                    className="px-8 py-3 rounded-xl text-base font-semibold border border-[#553DE9]/30 text-[#553DE9] hover:bg-[#553DE9]/5 transition-all"
                  >
                    View Templates
                  </button>
                </div>
              </div>
            </section>
          </div>
        ) : (
          <>
            <ErrorBoundary name="ControlBar">
              <ControlBar status={status} prdSummary={prdSummary} onStop={handleStopBuild}
                onPause={handlePause} onResume={handleResume} isPaused={isPaused} />
            </ErrorBoundary>

            <div className="mt-4">
              <ErrorBoundary name="StatusOverview">
                <StatusOverview status={status} />
              </ErrorBoundary>
            </div>

            <div className="mt-4 grid grid-cols-12 gap-6" style={{ height: 'calc(100vh - 340px)', minHeight: '400px' }}>
              <div className="col-span-3 flex flex-col gap-6">
                <ErrorBoundary name="PhaseVisualizer">
                  <PhaseVisualizer currentPhase={status?.phase || 'idle'} iteration={status?.iteration || 0} />
                </ErrorBoundary>
              </div>

              <div className="col-span-5 flex flex-col gap-0 min-h-0">
                <div className="flex items-center gap-1 mb-2 flex-shrink-0">
                  <button onClick={() => setActiveTab('terminal')}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all ${activeTab === 'terminal' ? 'bg-[#553DE9] text-white' : 'text-[#6B6960] hover:text-[#36342E] hover:bg-[#F8F4F0]'}`}>
                    Terminal
                  </button>
                  <button onClick={() => setActiveTab('metrics')}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all ${activeTab === 'metrics' ? 'bg-[#553DE9] text-white' : 'text-[#6B6960] hover:text-[#36342E] hover:bg-[#F8F4F0]'}`}>
                    Metrics
                  </button>
                </div>
                <div className="flex-1 min-h-0">
                  <ErrorBoundary name="Terminal">
                    {activeTab === 'terminal' ? (
                      <TerminalOutput logs={logs} loading={logsLoading} subscribe={subscribe} />
                    ) : (
                      <MetricsPanel visible={true} />
                    )}
                  </ErrorBoundary>
                </div>
              </div>

              <div className="col-span-4 flex flex-col gap-6 overflow-y-auto">
                <ErrorBoundary name="AgentDashboard">
                  <AgentDashboard agents={agents} loading={agentsLoading} />
                </ErrorBoundary>
                <ErrorBoundary name="QualityGates">
                  <QualityGatesPanel checklist={checklist} loading={checklistLoading} />
                </ErrorBoundary>
              </div>
            </div>

            <div className="mt-6 grid grid-cols-12 gap-6">
              <div className="col-span-6">
                <ErrorBoundary name="FileBrowser">
                  <FileBrowser files={files} loading={filesLoading} />
                </ErrorBoundary>
              </div>
              <div className="col-span-6">
                <ErrorBoundary name="MemoryViewer">
                  <MemoryViewer memory={memory} loading={memoryLoading} />
                </ErrorBoundary>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Footer (only shown when not building) */}
      {!isRunning && <Footer />}
    </div>
  );
}
