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
import {
  MessageSquare,
  Hammer,
  Rocket,
  ArrowDown,
  Heart,
  ExternalLink,
} from 'lucide-react';
import type { StatusResponse, Agent, LogEntry } from '../types/api';

const CYCLING_PROMPTS = [
  "Build a SaaS dashboard with user analytics...",
  "Create a REST API with authentication...",
  "Make a landing page with pricing tiers...",
  "Build a chat app with real-time messaging...",
  "Create an e-commerce store with Stripe...",
];

// A7: Rotating suggestion chip sets
const SUGGESTION_SETS = [
  [
    "Build a SaaS dashboard",
    "Create a REST API",
    "Design a landing page",
  ],
  [
    "Build a chat application",
    "Create a CLI tool",
    "Make a Discord bot",
  ],
  [
    "Build an e-commerce store",
    "Create a mobile app",
    "Design a portfolio site",
  ],
];

// A4: Showcase projects
const SHOWCASE_PROJECTS = [
  { name: 'SaaS Dashboard', stack: ['React', 'Tailwind', 'Chart.js'], gradient: 'showcase-gradient-1', time: '~3 min' },
  { name: 'REST API', stack: ['Node.js', 'Express', 'PostgreSQL'], gradient: 'showcase-gradient-2', time: '~2 min' },
  { name: 'Discord Bot', stack: ['Discord.js', 'TypeScript'], gradient: 'showcase-gradient-3', time: '~2 min' },
  { name: 'CLI Tool', stack: ['Node.js', 'Commander'], gradient: 'showcase-gradient-4', time: '~1 min' },
  { name: 'Landing Page', stack: ['React', 'Tailwind', 'Framer'], gradient: 'showcase-gradient-5', time: '~2 min' },
  { name: 'Mobile App', stack: ['React Native', 'Expo'], gradient: 'showcase-gradient-6', time: '~4 min' },
];

// A3: Animated counter hook
function useAnimatedCounter(target: number, duration: number = 1200) {
  const [count, setCount] = useState(0);
  const [started, setStarted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting && !started) setStarted(true); },
      { threshold: 0.3 }
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [started]);

  useEffect(() => {
    if (!started) return;
    const start = performance.now();
    const step = (now: number) => {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
      setCount(Math.round(eased * target));
      if (progress < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, [started, target, duration]);

  return { count, ref };
}

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

  // A7: Suggestion chip rotation
  const [suggestionSetIndex, setSuggestionSetIndex] = useState(0);
  const [chipsFading, setChipsFading] = useState(false);

  // A4: Showcase scroll ref
  const showcaseRef = useRef<HTMLDivElement>(null);
  const showcaseIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // A3: Animated counters
  const projectsCounter = useAnimatedCounter(500);
  const templatesCounter = useAnimatedCounter(50);
  const providersCounter = useAnimatedCounter(5);

  // A11: Showcase section ref for scroll-to
  const showcaseSectionRef = useRef<HTMLDivElement>(null);

  // Cycling placeholder animation (A2: slower + pause)
  useEffect(() => {
    const interval = setInterval(() => {
      setPlaceholderFading(true);
      setTimeout(() => {
        setPromptIndex(i => (i + 1) % CYCLING_PROMPTS.length);
        setPlaceholderFading(false);
      }, 400);
    }, 4000); // Slower: 4s between prompts
    return () => clearInterval(interval);
  }, []);

  // A7: Rotate suggestion chips every 10 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      setChipsFading(true);
      setTimeout(() => {
        setSuggestionSetIndex(i => (i + 1) % SUGGESTION_SETS.length);
        setChipsFading(false);
      }, 300);
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  // A4: Auto-scroll showcase
  useEffect(() => {
    if (!showcaseRef.current) return;
    const el = showcaseRef.current;
    let paused = false;

    const startScroll = () => {
      showcaseIntervalRef.current = setInterval(() => {
        if (paused) return;
        const maxScroll = el.scrollWidth - el.clientWidth;
        if (el.scrollLeft >= maxScroll - 2) {
          el.scrollTo({ left: 0, behavior: 'smooth' });
        } else {
          el.scrollBy({ left: 260, behavior: 'smooth' });
        }
      }, 3000);
    };

    const onEnter = () => { paused = true; };
    const onLeave = () => { paused = false; };

    el.addEventListener('mouseenter', onEnter);
    el.addEventListener('mouseleave', onLeave);
    startScroll();

    return () => {
      if (showcaseIntervalRef.current) clearInterval(showcaseIntervalRef.current);
      el.removeEventListener('mouseenter', onEnter);
      el.removeEventListener('mouseleave', onLeave);
    };
  }, [isRunning]); // re-attach when switching views

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

  // A7: Handle suggestion chip click
  const handleChipClick = useCallback((text: string) => {
    setQuickPrompt(text);
    quickInputRef.current?.focus();
  }, []);

  // A11: Scroll to showcase
  const scrollToShowcase = useCallback(() => {
    showcaseSectionRef.current?.scrollIntoView({ behavior: 'smooth' });
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
            {/* A1: Hero section with constellation background */}
            <div className="hero-bg w-full rounded-3xl pt-8 pb-12 mb-2">
              <div className="text-center mt-12 mb-10 relative z-10">
                {/* A8: Warm welcome message */}
                <p className="text-[#6B6960] text-sm font-medium mb-3 tracking-wide uppercase">
                  Ready to build something amazing?
                </p>

                {/* A6: Gradient text on heading */}
                <h2 className="font-heading text-h1 gradient-text">
                  What do you want to build?
                </h2>
                <p className="text-[#6B6960] mt-3 text-base max-w-xl mx-auto">
                  Describe it in plain English. Purple Lab writes the code,
                  runs the tests, and ships it -- autonomously.
                </p>
              </div>

              {/* One-line quick-start input */}
              <div className="w-full max-w-2xl mx-auto relative z-10">
                <div className="relative">
                  {/* A9: input-glow class for purple focus shadow */}
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
                    className="input-glow w-full text-xl px-6 py-4 rounded-2xl bg-white border border-[#ECEAE3] shadow-sm focus:outline-none focus:ring-2 focus:ring-[#553DE9]/30 focus:border-[#553DE9]/40 transition-all placeholder:text-transparent"
                    disabled={quickSubmitting}
                    aria-label="Describe what you want to build"
                  />
                  {/* A2: Enhanced cycling placeholder with blinking cursor */}
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
                      <span className="typing-cursor">|</span>
                    </div>
                  )}
                </div>

                {/* A10: Keyboard shortcut hint */}
                <div className="mt-2 text-center">
                  <span className="text-xs text-[#6B6960]/60">
                    Press <kbd className="px-1.5 py-0.5 rounded bg-[#ECEAE3] text-[#36342E] text-xs font-mono">Enter</kbd> to start building
                  </span>
                </div>

                {/* Start Building button */}
                <div className="mt-3 flex items-center justify-center gap-4">
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

                {/* A7: Floating action hints / suggestion chips */}
                <div className="mt-5 flex items-center justify-center gap-2 flex-wrap min-h-[36px]">
                  {SUGGESTION_SETS[suggestionSetIndex].map((text) => (
                    <button
                      key={text}
                      onClick={() => handleChipClick(text)}
                      className={`chip-glow px-4 py-1.5 rounded-full text-sm font-medium border border-[#ECEAE3] bg-white text-[#6B6960] hover:text-[#553DE9] hover:border-[#553DE9]/30 transition-all cursor-pointer ${
                        chipsFading ? 'opacity-0' : 'opacity-100'
                      }`}
                    >
                      {text}
                    </button>
                  ))}
                </div>

                {/* Error display */}
                {startError && (
                  <div className="mt-3 px-4 py-2.5 rounded-xl bg-[#C45B5B]/10 border border-[#C45B5B]/20 text-[#C45B5B] text-sm font-medium text-center">
                    {startError}
                  </div>
                )}

                {/* Advanced (full PRD) toggle + A11: See examples link */}
                <div className="mt-6 text-center flex items-center justify-center gap-4">
                  <button
                    onClick={() => setShowAdvanced(!showAdvanced)}
                    className="text-sm text-[#553DE9] hover:text-[#4832c7] font-medium transition-colors"
                  >
                    {showAdvanced ? 'Hide advanced options' : 'Advanced (write full PRD)'}
                  </button>
                  <span className="text-[#ECEAE3]">|</span>
                  <button
                    onClick={scrollToShowcase}
                    className="text-sm text-[#6B6960] hover:text-[#553DE9] font-medium transition-colors flex items-center gap-1"
                  >
                    See examples <ArrowDown className="w-3.5 h-3.5" />
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
            </div>

            {/* A3: Social Proof Section */}
            <div className="w-full max-w-3xl mt-8">
              <div className="border-t border-[#ECEAE3] pt-8">
                <p className="text-center text-sm text-[#6B6960] font-medium tracking-wide uppercase mb-6">
                  Trusted by developers building the future
                </p>
                <div className="flex items-center justify-center gap-12">
                  <div ref={projectsCounter.ref} className="text-center counter-animate">
                    <div className="text-3xl font-bold text-[#36342E]">{projectsCounter.count}+</div>
                    <div className="text-sm text-[#6B6960] mt-1">Projects Built</div>
                  </div>
                  <div className="w-px h-10 bg-[#ECEAE3]" />
                  <div ref={templatesCounter.ref} className="text-center counter-animate">
                    <div className="text-3xl font-bold text-[#36342E]">{templatesCounter.count}+</div>
                    <div className="text-sm text-[#6B6960] mt-1">Templates</div>
                  </div>
                  <div className="w-px h-10 bg-[#ECEAE3]" />
                  <div ref={providersCounter.ref} className="text-center counter-animate">
                    <div className="text-3xl font-bold text-[#36342E]">{providersCounter.count}</div>
                    <div className="text-sm text-[#6B6960] mt-1">AI Providers</div>
                  </div>
                </div>
              </div>
            </div>

            {/* A4: Featured Showcase Carousel */}
            <div ref={showcaseSectionRef} className="w-full max-w-4xl mt-12">
              <h3 className="text-lg font-semibold text-[#36342E] mb-4 text-center">
                What people are building
              </h3>
              <div
                ref={showcaseRef}
                className="showcase-scroll flex gap-4 overflow-x-auto pb-4 px-2"
              >
                {SHOWCASE_PROJECTS.map((project) => (
                  <div
                    key={project.name}
                    className={`showcase-card ${project.gradient} rounded-2xl p-6 min-w-[240px] w-[240px] text-white`}
                  >
                    <h4 className="font-bold text-lg mb-2">{project.name}</h4>
                    <div className="flex flex-wrap gap-1.5 mb-3">
                      {project.stack.map((tech) => (
                        <span
                          key={tech}
                          className="px-2 py-0.5 rounded-full text-xs font-medium bg-white/20 backdrop-blur-sm"
                        >
                          {tech}
                        </span>
                      ))}
                    </div>
                    <p className="text-sm text-white/80">Built in {project.time}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* A5: How It Works Section */}
            <div className="w-full max-w-3xl mt-14 mb-8">
              <h3 className="text-lg font-semibold text-[#36342E] mb-8 text-center">
                How it works
              </h3>
              <div className="flex items-start justify-between relative">
                {/* Dotted connector lines */}
                <div className="absolute top-6 left-[calc(16.67%+24px)] right-[calc(16.67%+24px)] step-connector" />

                {/* Step 1: Describe */}
                <div className="flex flex-col items-center text-center flex-1 relative z-10">
                  <div className="w-12 h-12 rounded-full bg-[#553DE9]/10 flex items-center justify-center mb-3">
                    <MessageSquare className="w-5 h-5 text-[#553DE9]" />
                  </div>
                  <div className="text-xs font-bold text-[#553DE9] mb-1">Step 1</div>
                  <h4 className="font-semibold text-[#36342E] mb-1">Describe</h4>
                  <p className="text-sm text-[#6B6960] max-w-[180px]">
                    Tell Purple Lab what to build in plain English
                  </p>
                </div>

                {/* Step 2: Build */}
                <div className="flex flex-col items-center text-center flex-1 relative z-10">
                  <div className="w-12 h-12 rounded-full bg-[#553DE9]/10 flex items-center justify-center mb-3">
                    <Hammer className="w-5 h-5 text-[#553DE9]" />
                  </div>
                  <div className="text-xs font-bold text-[#553DE9] mb-1">Step 2</div>
                  <h4 className="font-semibold text-[#36342E] mb-1">Build</h4>
                  <p className="text-sm text-[#6B6960] max-w-[180px]">
                    AI writes code, runs tests, and reviews quality
                  </p>
                </div>

                {/* Step 3: Ship */}
                <div className="flex flex-col items-center text-center flex-1 relative z-10">
                  <div className="w-12 h-12 rounded-full bg-[#553DE9]/10 flex items-center justify-center mb-3">
                    <Rocket className="w-5 h-5 text-[#553DE9]" />
                  </div>
                  <div className="text-xs font-bold text-[#553DE9] mb-1">Step 3</div>
                  <h4 className="font-semibold text-[#36342E] mb-1">Ship</h4>
                  <p className="text-sm text-[#6B6960] max-w-[180px]">
                    Deploy to Vercel, Netlify, or GitHub in one click
                  </p>
                </div>
              </div>
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

            {/* A12: Footer */}
            <footer className="w-full max-w-4xl mt-16 mb-8 pt-8 border-t border-[#ECEAE3]">
              <div className="flex items-center justify-between text-sm text-[#6B6960]">
                <div className="flex items-center gap-1.5">
                  Built with <Heart className="w-3.5 h-3.5 text-[#D63384]" /> by{' '}
                  <a
                    href="https://www.autonomi.dev/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[#553DE9] hover:text-[#4832c7] font-medium inline-flex items-center gap-1"
                  >
                    Autonomi <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
                <div className="flex items-center gap-4">
                  <a
                    href="https://github.com/asklokesh/loki-mode"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-[#553DE9] transition-colors"
                  >
                    GitHub
                  </a>
                  <a
                    href="https://www.npmjs.com/package/loki-mode"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-[#553DE9] transition-colors"
                  >
                    npm
                  </a>
                </div>
              </div>
            </footer>
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
    </div>
  );
}
