import { useState, useEffect } from 'react';
import { X, Gift, ExternalLink, Sparkles, Palette, Zap, Shield, Keyboard } from 'lucide-react';

const LS_KEY = 'pl_whats_new_version';
const CURRENT_VERSION = '6.73.1';

interface Feature {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  description: string;
}

const FEATURES: Feature[] = [
  {
    icon: Sparkles,
    title: 'Product Tour',
    description:
      'New step-by-step guided tour for first-time users. Highlights key UI areas so you never feel lost.',
  },
  {
    icon: Palette,
    title: 'Contextual Help Tooltips',
    description:
      'Hover over the help icons next to complex features to learn what they do without leaving the page.',
  },
  {
    icon: Keyboard,
    title: 'Enhanced Keyboard Shortcuts',
    description:
      'Press "?" to open the shortcuts overlay. Shortcuts are now grouped by category with search and filtering.',
  },
  {
    icon: Zap,
    title: 'Getting Started Checklist',
    description:
      'A friendly checklist guides you through your first project, from writing a spec to deploying your app.',
  },
  {
    icon: Shield,
    title: 'In-App Documentation',
    description:
      'Browse Quick Start guides, FAQ, and template docs right inside Purple Lab, no context switching required.',
  },
];

export function WhatsNew() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      const lastSeen = localStorage.getItem(LS_KEY);
      if (lastSeen !== CURRENT_VERSION) {
        // Small delay to not clash with product tour
        const t = setTimeout(() => setVisible(true), 1200);
        return () => clearTimeout(t);
      }
    } catch {
      // localStorage unavailable
    }
  }, []);

  const dismiss = () => {
    setVisible(false);
    try {
      localStorage.setItem(LS_KEY, CURRENT_VERSION);
    } catch {
      // ignore
    }
  };

  if (!visible) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30"
      onClick={dismiss}
    >
      <div
        className="bg-card rounded-xl shadow-2xl border border-border w-full max-w-md mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="relative px-6 pt-6 pb-4 text-center border-b border-border bg-gradient-to-b from-primary/5 to-transparent">
          <button
            onClick={dismiss}
            className="absolute top-4 right-4 text-muted hover:text-ink transition-colors p-1 rounded-btn hover:bg-hover"
            title="Close"
          >
            <X size={14} />
          </button>
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-3">
            <Gift size={24} className="text-primary" />
          </div>
          <h2 className="text-lg font-heading font-bold text-ink">What's New</h2>
          <p className="text-xs text-muted-accessible mt-1">
            Purple Lab v{CURRENT_VERSION}
          </p>
        </div>

        {/* Feature list */}
        <div className="px-4 py-4 space-y-3 max-h-[320px] overflow-y-auto terminal-scroll">
          {FEATURES.map((feature) => {
            const Icon = feature.icon;
            return (
              <div
                key={feature.title}
                className="flex items-start gap-3 p-3 rounded-lg hover:bg-hover transition-colors"
              >
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Icon size={16} className="text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-medium text-ink">{feature.title}</h3>
                  <p className="text-xs text-muted-accessible leading-relaxed mt-0.5">
                    {feature.description}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-border">
          <a
            href="https://github.com/asklokesh/loki-mode/blob/main/CHANGELOG.md"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs text-primary hover:text-primary-hover transition-colors"
          >
            Full changelog
            <ExternalLink size={11} />
          </a>
          <button
            onClick={dismiss}
            className="px-5 py-2 text-xs font-medium rounded-btn bg-primary text-white hover:bg-primary-hover transition-colors"
          >
            Got it!
          </button>
        </div>
      </div>
    </div>
  );
}
