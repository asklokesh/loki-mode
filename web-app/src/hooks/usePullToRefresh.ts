import { useRef, useCallback, useEffect, useState } from 'react';

interface PullToRefreshOptions {
  onRefresh: () => Promise<void>;
  threshold?: number;
  enabled?: boolean;
}

/**
 * Hook for pull-to-refresh gesture. Touch events only (not mouse).
 * Returns a ref to attach to the scrollable container and state for UI.
 */
export function usePullToRefresh<T extends HTMLElement>({
  onRefresh,
  threshold = 80,
  enabled = true,
}: PullToRefreshOptions) {
  const ref = useRef<T>(null);
  const [pulling, setPulling] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);

  const startY = useRef(0);
  const isPulling = useRef(false);

  const handleTouchStart = useCallback(
    (e: TouchEvent) => {
      if (!enabled || refreshing) return;
      const el = ref.current;
      // Only allow pull when scrolled to top
      if (el && el.scrollTop <= 0) {
        startY.current = e.touches[0].clientY;
        isPulling.current = true;
      }
    },
    [enabled, refreshing],
  );

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      if (!enabled || !isPulling.current || refreshing) return;
      const dy = e.touches[0].clientY - startY.current;

      if (dy > 0) {
        // Apply resistance (diminishing returns)
        const distance = Math.min(dy * 0.5, 120);
        setPullDistance(distance);
        setPulling(true);
      } else {
        isPulling.current = false;
        setPulling(false);
        setPullDistance(0);
      }
    },
    [enabled, refreshing],
  );

  const handleTouchEnd = useCallback(async () => {
    if (!enabled || !isPulling.current) return;
    isPulling.current = false;

    if (pullDistance >= threshold) {
      setRefreshing(true);
      setPullDistance(0);
      setPulling(false);
      try {
        await onRefresh();
      } finally {
        setRefreshing(false);
      }
    } else {
      setPullDistance(0);
      setPulling(false);
    }
  }, [enabled, pullDistance, threshold, onRefresh]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;

    el.addEventListener('touchstart', handleTouchStart, { passive: true });
    el.addEventListener('touchmove', handleTouchMove, { passive: true });
    el.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      el.removeEventListener('touchstart', handleTouchStart);
      el.removeEventListener('touchmove', handleTouchMove);
      el.removeEventListener('touchend', handleTouchEnd);
    };
  }, [enabled, handleTouchStart, handleTouchMove, handleTouchEnd]);

  return { ref, pulling, refreshing, pullDistance };
}
