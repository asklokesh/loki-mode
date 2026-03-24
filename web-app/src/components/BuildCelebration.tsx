import { useState, useEffect, useRef } from 'react';
import { CheckCircle2 } from 'lucide-react';

// B15: Build completion celebration animation
// Shows green checkmark with scale+burst animation, auto-dismisses after 3s

interface BuildCelebrationProps {
  phase: string;
  buildTime?: number; // seconds
  onDismiss?: () => void;
}

export function BuildCelebration({ phase, buildTime, onDismiss }: BuildCelebrationProps) {
  const [show, setShow] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const prevPhaseRef = useRef(phase);

  useEffect(() => {
    // Trigger when phase transitions to 'complete'
    if (phase === 'complete' && prevPhaseRef.current !== 'complete') {
      setShow(true);
      setDismissed(false);

      const timer = setTimeout(() => {
        setShow(false);
        setDismissed(true);
        onDismiss?.();
      }, 3000);

      return () => clearTimeout(timer);
    }

    // Reset when phase changes away from complete
    if (phase !== 'complete') {
      setDismissed(false);
    }

    prevPhaseRef.current = phase;
  }, [phase, onDismiss]);

  if (!show || dismissed) return null;

  const formatBuildTime = (seconds: number) => {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s}s`;
  };

  return (
    <div className="build-celebration-overlay" onClick={() => { setShow(false); setDismissed(true); onDismiss?.(); }}>
      <div className="build-celebration-content" onClick={e => e.stopPropagation()}>
        <div className="build-celebration-icon">
          <CheckCircle2 size={48} className="text-success" />
        </div>
        <div className="build-celebration-burst" />
        <h3 className="text-lg font-heading font-bold text-ink mt-4">
          Your app is ready!
        </h3>
        <p className="text-sm text-muted mt-1">
          {buildTime
            ? `Built in ${formatBuildTime(buildTime)}. Time to see it in action.`
            : 'Everything looks great. Go take a look.'}
        </p>
      </div>
    </div>
  );
}
