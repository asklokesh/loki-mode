import { useState, useEffect } from 'react';
import { FileText, Terminal, Eye, MessageSquare, ArrowRight, X } from 'lucide-react';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { useFocusTrap } from '../hooks/useFocusTrap';

const LS_KEY = 'pl_onboarding_complete';

interface Step {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  description: string;
}

const STEPS: Step[] = [
  {
    icon: FileText,
    title: 'Write your PRD',
    description: 'Describe what you want to build, or choose a template to get started quickly.',
  },
  {
    icon: Terminal,
    title: 'Use the terminal',
    description: 'Run commands directly in the integrated terminal to install dependencies or debug.',
  },
  {
    icon: Eye,
    title: 'Preview in real-time',
    description: 'Switch to the Preview tab to see your app running with live reload.',
  },
  {
    icon: MessageSquare,
    title: 'Iterate with AI Chat',
    description: 'Ask the AI to modify, fix, or explain your code in the chat panel.',
  },
];

export function OnboardingOverlay() {
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);

  // K108 + K109: Focus trap and escape key
  const trapRef = useFocusTrap<HTMLDivElement>(visible);
  useEscapeKey(visible, () => { if (visible) dismiss(); });

  useEffect(() => {
    try {
      if (localStorage.getItem(LS_KEY) !== '1') {
        setVisible(true);
      }
    } catch {
      // localStorage unavailable
    }
  }, []);

  const dismiss = () => {
    setVisible(false);
    try {
      localStorage.setItem(LS_KEY, '1');
    } catch {
      // ignore
    }
  };

  const next = () => {
    if (step < STEPS.length - 1) {
      setStep(step + 1);
    } else {
      dismiss();
    }
  };

  if (!visible) return null;

  const current = STEPS[step];
  const Icon = current.icon;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30">
      <div ref={trapRef} className="bg-card rounded-card shadow-card-hover border border-border w-full max-w-sm mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-2">
          <span className="text-[11px] font-mono text-muted-accessible">
            {step + 1} / {STEPS.length}
          </span>
          <button
            onClick={dismiss}
            className="text-muted hover:text-ink transition-colors p-1 rounded-btn hover:bg-hover"
            title="Skip onboarding"
          >
            <X size={14} />
          </button>
        </div>

        {/* Content */}
        <div className="px-5 pb-4 text-center">
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
            <Icon size={24} className="text-primary" />
          </div>
          <h3 className="text-sm font-heading font-bold text-ink mb-1">
            {current.title}
          </h3>
          <p className="text-xs text-muted-accessible leading-relaxed">
            {current.description}
          </p>
        </div>

        {/* Step indicators */}
        <div className="flex items-center justify-center gap-1.5 pb-4">
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={`w-1.5 h-1.5 rounded-full transition-colors ${
                i === step ? 'bg-primary' : 'bg-border'
              }`}
            />
          ))}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-border">
          <button
            onClick={dismiss}
            className="text-xs text-muted hover:text-ink transition-colors"
          >
            Skip
          </button>
          <button
            onClick={next}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium rounded-btn bg-primary text-white hover:bg-primary-hover transition-colors"
          >
            {step < STEPS.length - 1 ? (
              <>
                Next
                <ArrowRight size={12} />
              </>
            ) : (
              'Get Started'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
