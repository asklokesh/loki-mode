import { type ReactNode, type CSSProperties } from 'react';
import { useInView } from '../hooks/useInView';

export interface AnimateOnScrollProps {
  children: ReactNode;
  /** Animation class name from animations.css (without 'animate-' prefix -- added automatically). */
  animation?: 'fade-in' | 'fade-in-up' | 'fade-in-down' | 'fade-in-left' | 'fade-in-right' | 'scale-in';
  /** Animation delay in ms. */
  delay?: number;
  /** Animation duration in ms. */
  duration?: number;
  /** IntersectionObserver threshold (0-1). Default: 0.1 */
  threshold?: number;
  /** Extra CSS class names on the wrapper div. */
  className?: string;
}

/**
 * Wrapper component that animates children when scrolled into view.
 * Uses IntersectionObserver via useInView hook.
 */
export function AnimateOnScroll({
  children,
  animation = 'fade-in-up',
  delay = 0,
  duration,
  threshold = 0.1,
  className = '',
}: AnimateOnScrollProps) {
  const { ref, isInView } = useInView<HTMLDivElement>({ threshold, triggerOnce: true });

  const style: CSSProperties = {
    ...(delay > 0 ? { animationDelay: `${delay}ms` } : {}),
    ...(duration ? { animationDuration: `${duration}ms` } : {}),
  };

  // Before entering view, element is invisible. After, animation plays and fill-mode keeps it visible.
  const animClass = isInView
    ? `animate-${animation} animation-fill-both`
    : '';

  return (
    <div
      ref={ref}
      className={`${animClass} ${className}`}
      style={{
        ...style,
        ...(isInView ? {} : { opacity: 0 }),
      }}
    >
      {children}
    </div>
  );
}
