import type { PlanResult } from '../api/client';

interface PlanModalProps {
  plan: PlanResult | null;
  loading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function PlanModal({ plan, loading, onConfirm, onCancel }: PlanModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div className="card w-full max-w-lg mx-4 p-6 rounded-card shadow-card-hover">
        <h2 className="text-lg font-bold text-ink mb-4">Build Estimate</h2>

        {loading ? (
          <div className="flex flex-col items-center py-8 gap-3">
            <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-muted">Analyzing spec...</p>
            <div className="flex gap-3 mt-4">
              <button
                onClick={onCancel}
                className="px-4 py-2 text-sm font-medium text-muted hover:text-ink transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={onConfirm}
                className="px-4 py-2 text-sm font-medium text-primary hover:text-primary/80 transition-colors underline"
              >
                Skip analysis, build now
              </button>
            </div>
          </div>
        ) : plan ? (
          <>
            {plan.returncode !== 0 && (
              <div className="mb-4 px-3 py-2 rounded-btn bg-warning/10 border border-warning/20 text-warning text-xs">
                loki plan exited with code {plan.returncode} - showing partial results
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="card rounded-card p-3">
                <div className="text-xs font-semibold text-muted-accessible uppercase tracking-wider mb-1">Complexity</div>
                <div className="text-base font-bold text-ink capitalize">{plan.complexity}</div>
              </div>
              <div className="card rounded-card p-3">
                <div className="text-xs font-semibold text-muted-accessible uppercase tracking-wider mb-1">Est. Cost</div>
                <div className="text-base font-bold text-ink">{plan.cost_estimate}</div>
              </div>
              <div className="card rounded-card p-3">
                <div className="text-xs font-semibold text-muted-accessible uppercase tracking-wider mb-1">Iterations</div>
                <div className="text-base font-bold text-ink">{plan.iterations}</div>
              </div>
              <div className="card rounded-card p-3">
                <div className="text-xs font-semibold text-muted-accessible uppercase tracking-wider mb-1">Phases</div>
                <div className="text-xs text-ink capitalize">{plan.phases.join(', ')}</div>
              </div>
            </div>

            {plan.output_text && (
              <details className="mb-4">
                <summary className="text-xs text-muted cursor-pointer hover:text-ink transition-colors">
                  Raw output
                </summary>
                <pre className="mt-2 text-xs font-mono text-muted-accessible bg-black/5 rounded-card p-3 overflow-auto max-h-40 whitespace-pre-wrap">
                  {plan.output_text}
                </pre>
              </details>
            )}

            <div className="flex gap-3 justify-end">
              <button
                onClick={onCancel}
                className="px-4 py-2 text-sm font-medium text-muted hover:text-ink transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={onConfirm}
                className="px-5 py-2 rounded-card text-sm font-semibold bg-primary text-white hover:bg-primary/90 transition-all shadow-button"
              >
                Start Build
              </button>
            </div>
          </>
        ) : (
          <div className="text-sm text-muted py-4">No plan data available.</div>
        )}
      </div>
    </div>
  );
}
