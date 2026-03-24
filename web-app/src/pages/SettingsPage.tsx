import { useState, useEffect } from 'react';
import { ExternalLink, Check } from 'lucide-react';
import { Card } from '../components/ui/Card';
import { api } from '../api/client';

const PROVIDERS = [
  { id: 'claude', name: 'Claude', description: 'Anthropic Claude Code -- full features' },
  { id: 'codex', name: 'Codex', description: 'OpenAI Codex CLI -- degraded mode' },
  { id: 'gemini', name: 'Gemini', description: 'Google Gemini CLI -- degraded mode' },
] as const;

export default function SettingsPage() {
  const [selectedProvider, setSelectedProvider] = useState('claude');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [version, setVersion] = useState('');

  useEffect(() => {
    api.getCurrentProvider()
      .then((info) => setSelectedProvider(info.provider))
      .catch(() => {});
    api.getStatus()
      .then((s) => setVersion(s.version || ''))
      .catch(() => {});
  }, []);

  const handleProviderChange = async (provider: string) => {
    setSelectedProvider(provider);
    // K105: Optimistic UI -- show "Saved" immediately
    setSaved(true);
    setSaving(true);
    try {
      await api.setProvider(provider);
    } catch {
      // ignore
    } finally {
      setSaving(false);
      setTimeout(() => setSaved(false), 2000);
    }
  };

  return (
    <div className="max-w-[800px] mx-auto px-6 max-md:px-4 py-8">
      <h1 className="font-heading text-h1 max-md:text-h2 text-[#36342E] mb-8">Settings</h1>

      {/* Provider section */}
      <section className="mb-10">
        <h2 className="text-sm font-semibold text-[#36342E] uppercase tracking-wide mb-4">
          Provider
        </h2>
        <div className="flex flex-col gap-3">
          {PROVIDERS.map((p) => (
            <Card
              key={p.id}
              hover
              onClick={() => handleProviderChange(p.id)}
              className={
                selectedProvider === p.id
                  ? 'ring-2 ring-[#553DE9] border-[#553DE9]'
                  : ''
              }
            >
              <div className="flex items-center gap-3">
                <div
                  className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                    selectedProvider === p.id
                      ? 'border-[#553DE9]'
                      : 'border-[#ECEAE3]'
                  }`}
                >
                  {selectedProvider === p.id && (
                    <div className="w-2 h-2 rounded-full bg-[#553DE9]" />
                  )}
                </div>
                <div>
                  <p className="text-sm font-medium text-[#36342E]">{p.name}</p>
                  <p className="text-xs text-[#6B6960]">{p.description}</p>
                </div>
              </div>
            </Card>
          ))}
        </div>
        {saving && !saved && (
          <p className="text-xs text-[#6B6960] mt-2">Saving...</p>
        )}
        {saved && (
          <p className="flex items-center gap-1 text-xs text-[#1FC5A8] mt-2 font-medium">
            <Check size={12} /> Saved
          </p>
        )}
      </section>

      {/* About section */}
      <section>
        <h2 className="text-sm font-semibold text-[#36342E] uppercase tracking-wide mb-4">
          About
        </h2>
        <Card>
          <div className="flex flex-col gap-3">
            {version && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-[#6B6960]">Version</span>
                <span className="text-sm font-medium text-[#36342E]">v{version}</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-sm text-[#6B6960]">Documentation</span>
              <a
                href="https://www.autonomi.dev/docs"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-[#553DE9] hover:underline"
              >
                autonomi.dev/docs <ExternalLink size={12} />
              </a>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-[#6B6960]">GitHub</span>
              <a
                href="https://github.com/asklokesh/loki-mode"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-[#553DE9] hover:underline"
              >
                asklokesh/loki-mode <ExternalLink size={12} />
              </a>
            </div>
          </div>
        </Card>
      </section>
    </div>
  );
}
