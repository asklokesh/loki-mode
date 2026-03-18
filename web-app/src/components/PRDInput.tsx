import { useState, useCallback } from 'react';

// Template definitions matching ~/git/loki-mode/templates/
const TEMPLATES = [
  { name: 'SaaS Starter', filename: 'saas-starter.md' },
  { name: 'CLI Tool', filename: 'cli-tool.md' },
  { name: 'REST API (Auth)', filename: 'rest-api-auth.md' },
  { name: 'Full Stack Demo', filename: 'full-stack-demo.md' },
  { name: 'Discord Bot', filename: 'discord-bot.md' },
  { name: 'Chrome Extension', filename: 'chrome-extension.md' },
  { name: 'Blog Platform', filename: 'blog-platform.md' },
  { name: 'E-Commerce', filename: 'e-commerce.md' },
  { name: 'Mobile App', filename: 'mobile-app.md' },
  { name: 'AI Chatbot', filename: 'ai-chatbot.md' },
  { name: 'API Only', filename: 'api-only.md' },
  { name: 'Simple Todo', filename: 'simple-todo-app.md' },
  { name: 'Static Landing', filename: 'static-landing-page.md' },
] as const;

interface PRDInputProps {
  onSubmit: (prd: string, provider: string) => void;
  running: boolean;
}

export function PRDInput({ onSubmit, running }: PRDInputProps) {
  const [prd, setPrd] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [provider, setProvider] = useState('claude');
  const [showTemplates, setShowTemplates] = useState(false);

  const handleTemplateSelect = useCallback(async (filename: string, name: string) => {
    setSelectedTemplate(name);
    setShowTemplates(false);
    // In a real deployment, this would fetch from the API
    // For now, set a placeholder that indicates which template was chosen
    setPrd(`# ${name}\n\n<!-- Template: ${filename} -->\n<!-- Paste your PRD content here or load from the Loki Mode templates directory -->\n\n## Overview\n\nDescribe your project here...\n\n## Features\n\n- Feature 1\n- Feature 2\n- Feature 3\n\n## Technical Requirements\n\n- Requirement 1\n- Requirement 2\n`);
  }, []);

  const handleSubmit = () => {
    if (!prd.trim()) return;
    onSubmit(prd, provider);
  };

  return (
    <div className="glass p-6 flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-charcoal uppercase tracking-wider">
          PRD Input
        </h3>
        <div className="flex items-center gap-2">
          {/* Template selector */}
          <div className="relative">
            <button
              onClick={() => setShowTemplates(!showTemplates)}
              className="text-xs font-medium px-3 py-1.5 rounded-xl border border-primary/20 text-primary hover:bg-primary/5 transition-colors"
            >
              {selectedTemplate || 'Templates'}
            </button>

            {showTemplates && (
              <div className="absolute right-0 top-full mt-1 w-56 glass-subtle rounded-xl overflow-hidden z-20 shadow-glass">
                <div className="py-1">
                  {TEMPLATES.map((t) => (
                    <button
                      key={t.filename}
                      onClick={() => handleTemplateSelect(t.filename, t.name)}
                      className="w-full text-left px-3 py-2 text-sm text-charcoal hover:bg-primary/5 transition-colors"
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
        placeholder="Paste your PRD here, or select a template above to get started..."
        className="flex-1 min-h-[200px] w-full bg-white/40 rounded-xl border border-white/30 px-4 py-3 text-sm font-mono text-charcoal placeholder:text-primary-wash resize-none focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/30 transition-all"
        spellCheck={false}
      />

      {/* Control bar */}
      <div className="flex items-center gap-3 mt-4">
        {/* Provider selector */}
        <div className="flex items-center gap-1 glass-subtle rounded-xl p-1">
          {['claude', 'codex', 'gemini'].map((p) => (
            <button
              key={p}
              onClick={() => setProvider(p)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                provider === p
                  ? 'bg-primary text-white shadow-sm'
                  : 'text-slate hover:text-charcoal hover:bg-white/40'
              }`}
            >
              {p === 'claude' ? 'Claude' : p === 'codex' ? 'Codex' : 'Gemini'}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {/* Character count */}
        <span className="text-xs text-slate font-mono">
          {prd.length.toLocaleString()} chars
        </span>

        {/* Submit button */}
        <button
          onClick={handleSubmit}
          disabled={!prd.trim() || running}
          className={`px-6 py-2 rounded-xl text-sm font-semibold transition-all ${
            !prd.trim() || running
              ? 'bg-surface/50 text-slate cursor-not-allowed'
              : 'bg-primary text-white hover:bg-primary-light shadow-glass-subtle'
          }`}
        >
          {running ? 'Running...' : 'Start Build'}
        </button>
      </div>
    </div>
  );
}
