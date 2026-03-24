import { useEffect, useRef, useState, useCallback } from 'react';

export interface UseInViewOptions {
  /** Percentage of element that must be visible (0-1). Default: 0.1 */
  threshold?: number;
  /** Margin around root. Default: '0px' */
  rootMargin?: string;
  /** Only trigger once (stays true after first intersection). Default: true */
  triggerOnce?: boolean;
}

/**
 * Detects when an element enters the viewport using IntersectionObserver.
 * Returns a ref to attach to the target element and a boolean indicating visibility.
 */
export function useInView<T extends HTMLElement = HTMLDivElement>(
  options: UseInViewOptions = {}
): { ref: React.RefObject<T | null>; isInView: boolean } {
  const { threshold = 0.1, rootMargin = '0px', triggerOnce = true } = options;
  const ref = useRef<T | null>(null);
  const [isInView, setIsInView] = useState(false);
  const hasTriggered = useRef(false);

  const handleIntersect = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      const entry = entries[0];
      if (!entry) return;

      if (entry.isIntersecting) {
        setIsInView(true);
        if (triggerOnce) {
          hasTriggered.current = true;
        }
      } else if (!triggerOnce) {
        setIsInView(false);
      }
    },
    [triggerOnce]
  );

  useEffect(() => {
    const node = ref.current;
    if (!node || hasTriggered.current) return;

    const observer = new IntersectionObserver(handleIntersect, {
      threshold,
      rootMargin,
    });

    observer.observe(node);

    return () => {
      observer.disconnect();
    };
  }, [threshold, rootMargin, handleIntersect]);

  return { ref, isInView };
}
