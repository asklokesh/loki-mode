import { useState, useCallback, useEffect } from 'react';
import { api } from '../api/client';
import type { PlanResult } from '../api/client';
import { PlanModal } from './PlanModal';

interface PRDInputProps {
  onSubmit: (prd: string, provider: string, projectDir?: string, mode?: string) => Promise<void>;
  running: boolean;
  error?: string | null;
  provider?: string;
  onProviderChange?: (provider: string) => void;
  initialPrd?: string;
}

interface TemplateItem {
  name: string;
  filename: string;
}

export function PRDInput({ onSubmit, running, error, provider: providerProp, onProviderChange, initialPrd }: PRDInputProps) {
  const [prd, setPrd] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [localProvider, setLocalProvider] = useState('claude');
  const [projectDir, setProjectDir] = useState('');
  // Use controlled provider if provided by parent, otherwise use local state
  const provider = providerProp ?? localProvider;
  const setProvider = (p: string) => {
    setLocalProvider(p);
    onProviderChange?.(p);
  };
  const [showTemplates, setShowTemplates] = useState(false);
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [templateLoadError, setTemplateLoadError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [quickMode, setQuickMode] = useState(false);
  const [planResult, setPlanResult] = useState<PlanResult | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [showPlanModal, setShowPlanModal] = useState(false);

  // Load templates from backend (no hardcoded fallback -- show warning on failure)
  useEffect(() => {
    api.getTemplates()
      .then((list) => {
        setTemplates(list);
        setTemplateLoadError(false);
      })
      .catch(() => {
        setTemplates([]);
        setTemplateLoadError(true);
      });
  }, []);

  // Apply initialPrd prop when provided (e.g. from template selection on TemplatesPage)
  useEffect(() => {
    if (initialPrd) {
      setPrd(initialPrd);
    }
  }, [initialPrd]);

  // On mount: restore draft from localStorage, then check for PRD prefill from CLI
  useEffect(() => {
    // Skip draft restore if initialPrd was provided
    if (initialPrd) return;
    const draft = localStorage.getItem('loki-prd-draft');
    if (draft) {
      setPrd(draft);
    }
    api.getPrdPrefill()
      .then(({ content }) => {
        if (content) {
          setPrd(content);
        }
      })
      .catch(() => {
        // No prefill available -- ignore
      });
  }, [initialPrd]);

  // Auto-save PRD draft to localStorage on change
  useEffect(() => {
    if (prd.trim()) {
      localStorage.setItem('loki-prd-draft', prd);
    } else {
      localStorage.removeItem('loki-prd-draft');
    }
  }, [prd]);

  // PRD content is persisted to sessionStorage by the parent component,
  // so no need to warn on page reload -- content is preserved automatically.

  const handleTemplateSelect = useCallback(async (filename: string, name: string) => {
    setSelectedTemplate(name);
    setShowTemplates(false);
    try {
      const result = await api.getTemplateContent(filename);
      setPrd(result.content);
    } catch {
      setPrd(`# ${name}\n\n## Overview\n\nDescribe your project here...\n\n## Features\n\n- Feature 1\n- Feature 2\n- Feature 3\n\n## Technical Requirements\n\n- Requirement 1\n- Requirement 2\n`);
    }
  }, []);

  const handleEstimate = async () => {
    if (!prd.trim() || planLoading) return;
    setPlanLoading(true);
    setPlanResult(null);
    setShowPlanModal(true);
    try {
      const result = await api.planSession(prd, provider);
      setPlanResult(result);
    } catch {
      setPlanResult({
        complexity: 'unknown',
        cost_estimate: 'N/A',
        iterations: 0,
        phases: [],
        output_text: 'Failed to run loki plan. The CLI may not be available.',
        returncode: 1,
      });
    } finally {
      setPlanLoading(false);
    }
  };

  const handleSubmit = async () => {
    if (!prd.trim() || running || submitting) return;
    setShowPlanModal(false);
    setSubmitting(true);
    try {
      await onSubmit(prd, provider, projectDir.trim() || undefined, quickMode ? 'quick' : undefined);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
    {showPlanModal && (
      <PlanModal
        plan={planResult}
        loading={planLoading}
        onConfirm={handleSubmit}
        onCancel={() => setShowPlanModal(false)}
      />
    )}
    <div className="card p-6 flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-ink uppercase tracking-wider">
          Product Requirements
        </h3>
        <div className="flex items-center gap-2">
          {/* Template selector */}
          <div className="relative">
            <button
              onClick={() => setShowTemplates(!showTemplates)}
              className="text-xs font-medium px-3 py-1.5 rounded-card border border-primary/20 text-primary hover:bg-primary/5 transition-colors"
            >
              {selectedTemplate || 'Templates'}
            </button>

            {showTemplates && (
              <div className="absolute right-0 top-full mt-1 w-56 card rounded-card overflow-hidden z-20 shadow-card-hover">
                <div className="py-1 max-h-64 overflow-y-auto terminal-scroll">
                  {templateLoadError && (
                    <div className="px-3 py-2 text-xs text-warning border-b border-warning/10">
                      Could not load templates from server. Check that the backend is running.
                    </div>
                  )}
                  {!templateLoadError && templates.length === 0 && (
                    <div className="px-3 py-2 text-xs text-muted">Loading...</div>
                  )}
                  {templates.map((t) => (
                    <button
                      key={t.filename}
                      onClick={() => handleTemplateSelect(t.filename, t.name)}
                      className="w-full text-left px-3 py-2 text-sm text-ink hover:bg-primary/5 transition-colors"
                    >
                      {t.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* PRD textarea */}
      <textarea
        value={prd}
        onChange={(e) => setPrd(e.target.value)}
        placeholder="Paste your spec or PRD here, or select a template above to get started..."
        className="flex-1 min-h-[280px] w-full bg-card rounded-card border border-border-light px-4 py-3 text-sm font-mono text-ink placeholder:text-primary/60 resize-none focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/30 transition-all"
        spellCheck={false}
      />

      {/* Project directory field */}
      <div className="mt-3">
        <label className="block text-xs text-muted font-medium mb-1 uppercase tracking-wider">
          Project Directory
        </label>
        <input
          type="text"
          value={projectDir}
          onChange={(e) => setProjectDir(e.target.value)}
          placeholder="Leave blank to auto-create, or type a path (e.g. /Users/you/my-project)"
          className="w-full bg-card rounded-card border border-border-light px-4 py-2 text-sm font-mono text-ink placeholder:text-primary/60/70 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/30 transition-all"
          spellCheck={false}
        />
        <p className="text-xs text-muted-accessible mt-1">
          Type a path or leave blank to auto-create under ~/purple-lab-projects/
        </p>
      </div>

      {/* Error display */}
      {error && (
        <div className="mt-3 px-3 py-2 rounded-btn bg-danger/10 border border-danger/20 text-danger text-xs font-medium">
          {error}
        </div>
      )}

      {/* Control bar */}
      <div className="flex items-center gap-3 mt-4">
        {/* Quick Mode toggle */}
        <button
          onClick={() => setQuickMode(!quickMode)}
          title="Quick Mode: 3 iterations max, faster builds"
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-card text-xs font-semibold border transition-all ${
            quickMode
              ? 'bg-primary/10 border-primary/30 text-primary'
              : 'border-border-light text-muted hover:text-ink hover:bg-card'
          }`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${quickMode ? 'bg-primary' : 'bg-muted/40'}`} />
          Quick
        </button>

        <div className="flex-1" />

        {/* Character count */}
        <span className="text-xs text-muted font-mono">
          {prd.length.toLocaleString()} chars
        </span>

        {/* Submit button -- triggers plan-before-build flow by default */}
        <button
          onClick={handleEstimate}
          disabled={!prd.trim() || running || submitting || planLoading}
          className={`px-6 py-2.5 rounded-card text-sm font-semibold transition-all ${
            !prd.trim() || running || submitting || planLoading
              ? 'bg-primary/10 text-muted cursor-not-allowed'
              : 'bg-primary text-white hover:bg-primary/90 shadow-button'
          }`}
        >
          {planLoading ? 'Analyzing...' : submitting ? 'Starting...' : running ? 'Building...' : 'Start Build'}
        </button>
      </div>
    </div>
    </>
  );
}
