import { useState, useCallback, useRef } from 'react';

/**
 * Hook to prevent double-click submissions.
 * Wraps an async handler to disable the action during execution.
 *
 * Usage:
 *   const { isSubmitting, guardedSubmit } = useSubmitGuard(async () => {
 *     await api.startBuild();
 *   });
 *   <button onClick={guardedSubmit} disabled={isSubmitting}>
 *     {isSubmitting ? 'Working...' : 'Start Build'}
 *   </button>
 */
export function useSubmitGuard(handler: () => Promise<void>) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const guardedSubmit = useCallback(async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await handlerRef.current();
    } finally {
      setIsSubmitting(false);
    }
  }, [isSubmitting]);

  return { isSubmitting, guardedSubmit };
}
