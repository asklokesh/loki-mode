import { useRef, useCallback, useEffect } from 'react';

interface SwipeGestureOptions {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  threshold?: number;
  enabled?: boolean;
}

/**
 * Hook for swipe left/right gesture detection on touch devices.
 * Attaches to a ref element and fires callbacks on swipe.
 */
export function useSwipeGesture<T extends HTMLElement>({
  onSwipeLeft,
  onSwipeRight,
  threshold = 50,
  enabled = true,
}: SwipeGestureOptions) {
  const ref = useRef<T>(null);
  const startX = useRef(0);
  const startY = useRef(0);
  const currentX = useRef(0);
  const swiping = useRef(false);

  const handleTouchStart = useCallback(
    (e: TouchEvent) => {
      if (!enabled) return;
      const touch = e.touches[0];
      startX.current = touch.clientX;
      startY.current = touch.clientY;
      currentX.current = touch.clientX;
      swiping.current = true;
    },
    [enabled],
  );

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      if (!enabled || !swiping.current) return;
      const touch = e.touches[0];
      currentX.current = touch.clientX;

      // Apply visual feedback (slight translateX)
      const dx = currentX.current - startX.current;
      const dy = touch.clientY - startY.current;

      // If vertical scroll is dominant, cancel swipe
      if (Math.abs(dy) > Math.abs(dx)) {
        swiping.current = false;
        if (ref.current) ref.current.style.transform = '';
        return;
      }

      if (ref.current && Math.abs(dx) > 10) {
        // Limit visual offset to 60px
        const offset = Math.max(-60, Math.min(60, dx * 0.3));
        ref.current.style.transform = `translateX(${offset}px)`;
        ref.current.style.transition = 'none';
      }
    },
    [enabled],
  );

  const handleTouchEnd = useCallback(() => {
    if (!enabled || !swiping.current) return;
    swiping.current = false;

    // Reset visual feedback
    if (ref.current) {
      ref.current.style.transform = '';
      ref.current.style.transition = '';
    }

    const dx = currentX.current - startX.current;

    if (dx > threshold && onSwipeRight) {
      onSwipeRight();
    } else if (dx < -threshold && onSwipeLeft) {
      onSwipeLeft();
    }
  }, [enabled, threshold, onSwipeLeft, onSwipeRight]);

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

  return ref;
}
