import { useState, useEffect, useCallback, useRef } from 'react';
import { X, ArrowRight, ArrowLeft, SkipForward, Sparkles } from 'lucide-react';

const LS_KEY = 'pl_product_tour_complete';

interface TourStep {
  target: string;
  title: string;
  description: string;
  position: 'top' | 'bottom' | 'left' | 'right';
}

interface ProductTourProps {
  steps?: TourStep[];
  onComplete?: () => void;
}

const DEFAULT_STEPS: TourStep[] = [
  {
    target: '[data-tour="input-box"]',
    title: 'Describe what you want to build',
    description:
      'Type a plain-English description of your project here. The more detail you give, the better the result. You can also paste a spec / PRD or select a template.',
    position: 'bottom',
  },
  {
    target: '[data-tour="template-gallery"]',
    title: 'Start from a template',
    description:
      'Browse ready-made templates for SaaS apps, landing pages, dashboards, and more. Each template gives you a head start with a proven structure.',
    position: 'bottom',
  },
  {
    target: '[data-tour="build-progress"]',
    title: 'Watch your project come to life',
    description:
      'Once you start a build, this bar tracks each phase: planning, building, testing, and reviewing. You will see real-time progress and cost estimates.',
    position: 'bottom',
  },
  {
    target: '[data-tour="preview-tab"]',
    title: 'Preview your running app',
    description:
      'Switch to the Preview tab to see your application running live. Changes appear in real time as the AI iterates on your code.',
    position: 'bottom',
  },
  {
    target: '[data-tour="deploy-tab"]',
    title: 'Deploy with one click',
    description:
      'When you are happy with the result, head to the Deploy tab to push your project live. Supports Vercel, Netlify, Railway, and more.',
    position: 'bottom',
  },
];

function getSpotlightRect(selector: string): DOMRect | null {
  const el = document.querySelector(selector);
  if (!el) return null;
  return el.getBoundingClientRect();
}

function getTooltipStyle(
  rect: DOMRect | null,
  position: TourStep['position'],
): React.CSSProperties {
  if (!rect) {
    return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
  }

  const gap = 16;
  const style: React.CSSProperties = { position: 'fixed', zIndex: 60 };

  switch (position) {
    case 'bottom':
      style.top = rect.bottom + gap;
      style.left = rect.left + rect.width / 2;
      style.transform = 'translateX(-50%)';
      break;
    case 'top':
      style.bottom = window.innerHeight - rect.top + gap;
      style.left = rect.left + rect.width / 2;
      style.transform = 'translateX(-50%)';
      break;
    case 'left':
      style.top = rect.top + rect.height / 2;
      style.right = window.innerWidth - rect.left + gap;
      style.transform = 'translateY(-50%)';
      break;
    case 'right':
      style.top = rect.top + rect.height / 2;
      style.left = rect.right + gap;
      style.transform = 'translateY(-50%)';
      break;
  }

  return style;
}

export function ProductTour({ steps = DEFAULT_STEPS, onComplete }: ProductTourProps) {
  const [active, setActive] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [spotlightRect, setSpotlightRect] = useState<DOMRect | null>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    try {
      if (localStorage.getItem(LS_KEY) !== '1') {
        // Delay to let the page render first
        const timeout = setTimeout(() => setActive(true), 800);
        return () => clearTimeout(timeout);
      }
    } catch {
      // localStorage unavailable
    }
  }, []);

  // Track the target element position
  useEffect(() => {
    if (!active || !steps[currentStep]) return;

    const update = () => {
      const rect = getSpotlightRect(steps[currentStep].target);
      setSpotlightRect(rect);
      rafRef.current = requestAnimationFrame(update);
    };
    update();

    return () => cancelAnimationFrame(rafRef.current);
  }, [active, currentStep, steps]);

  const dismiss = useCallback(() => {
    setActive(false);
    try {
      localStorage.setItem(LS_KEY, '1');
    } catch {
      // ignore
    }
    onComplete?.();
  }, [onComplete]);

  const next = useCallback(() => {
    if (currentStep < steps.length - 1) {
      setCurrentStep((s) => s + 1);
    } else {
      dismiss();
    }
  }, [currentStep, steps.length, dismiss]);

  const prev = useCallback(() => {
    setCurrentStep((s) => Math.max(0, s - 1));
  }, []);

  // Escape key to dismiss
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
      if (e.key === 'ArrowRight') next();
      if (e.key === 'ArrowLeft') prev();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [active, dismiss, next, prev]);

  if (!active || !steps[currentStep]) return null;

  const step = steps[currentStep];
  const padding = 8;

  return (
    <div className="fixed inset-0 z-[55]" aria-modal="true" role="dialog">
      {/* Overlay with spotlight cutout */}
      <svg
        className="absolute inset-0 w-full h-full"
        onClick={dismiss}
        style={{ zIndex: 55 }}
      >
        <defs>
          <mask id="tour-spotlight">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            {spotlightRect && (
              <rect
                x={spotlightRect.left - padding}
                y={spotlightRect.top - padding}
                width={spotlightRect.width + padding * 2}
                height={spotlightRect.height + padding * 2}
                rx="8"
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect
          x="0"
          y="0"
          width="100%"
          height="100%"
          fill="rgba(0,0,0,0.55)"
          mask="url(#tour-spotlight)"
        />
      </svg>

      {/* Spotlight border glow */}
      {spotlightRect && (
        <div
          className="absolute border-2 border-primary rounded-lg pointer-events-none shadow-[0_0_20px_rgba(85,61,233,0.3)]"
          style={{
            left: spotlightRect.left - padding,
            top: spotlightRect.top - padding,
            width: spotlightRect.width + padding * 2,
            height: spotlightRect.height + padding * 2,
            zIndex: 56,
          }}
        />
      )}

      {/* Tooltip card */}
      <div
        className="w-80 bg-card rounded-xl shadow-2xl border border-border p-0 overflow-hidden"
        style={{ ...getTooltipStyle(spotlightRect, step.position), zIndex: 57 }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 pt-4 pb-1">
          <div className="flex items-center gap-2">
            <Sparkles size={14} className="text-primary" />
            <span className="text-[11px] font-mono text-muted-accessible">
              Step {currentStep + 1} of {steps.length}
            </span>
          </div>
          <button
            onClick={dismiss}
            className="text-muted hover:text-ink transition-colors p-1 rounded-btn hover:bg-hover"
            title="Skip tour"
          >
            <X size={14} />
          </button>
        </div>

        {/* Content */}
        <div className="px-4 pb-3">
          <h3 className="text-sm font-heading font-bold text-ink mb-1">
            {step.title}
          </h3>
          <p className="text-xs text-muted-accessible leading-relaxed">
            {step.description}
          </p>
        </div>

        {/* Progress dots */}
        <div className="flex items-center justify-center gap-1.5 pb-3">
          {steps.map((_, i) => (
            <button
              key={i}
              onClick={() => setCurrentStep(i)}
              className={`w-2 h-2 rounded-full transition-all ${
                i === currentStep
                  ? 'bg-primary scale-110'
                  : i < currentStep
                    ? 'bg-primary/40'
                    : 'bg-border'
              }`}
              aria-label={`Go to step ${i + 1}`}
            />
          ))}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-border bg-hover/30">
          <button
            onClick={dismiss}
            className="flex items-center gap-1 text-xs text-muted hover:text-ink transition-colors"
          >
            <SkipForward size={12} />
            Skip tour
          </button>
          <div className="flex items-center gap-2">
            {currentStep > 0 && (
              <button
                onClick={prev}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-btn text-ink hover:bg-hover transition-colors"
              >
                <ArrowLeft size={12} />
                Back
              </button>
            )}
            <button
              onClick={next}
              className="flex items-center gap-1 px-4 py-1.5 text-xs font-medium rounded-btn bg-primary text-white hover:bg-primary-hover transition-colors"
            >
              {currentStep < steps.length - 1 ? (
                <>
                  Next
                  <ArrowRight size={12} />
                </>
              ) : (
                "Let's go!"
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
