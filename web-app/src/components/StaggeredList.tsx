import { Children, type ReactNode, type CSSProperties } from 'react';
import { useInView } from '../hooks/useInView';

export interface StaggeredListProps {
  children: ReactNode;
  /** Animation type for each child. Default: 'fade-in-up' */
  animation?: 'fade-in-up' | 'scale-in' | 'fade-in';
  /** Delay between each child in ms. Default: 50 */
  stagger?: number;
  /** Extra class names on each child wrapper. */
  childClassName?: string;
  /** Extra class names on the outer container. */
  className?: string;
  /** IntersectionObserver threshold. Default: 0.05 */
  threshold?: number;
}

/**
 * Renders children with staggered entrance animations.
 * Each child gets an increasing delay so they appear one after another.
 * Animation only triggers when the container scrolls into view.
 */
export function StaggeredList({
  children,
  animation = 'fade-in-up',
  stagger = 50,
  childClassName = '',
  className = '',
  threshold = 0.05,
}: StaggeredListProps) {
  const { ref, isInView } = useInView<HTMLDivElement>({ threshold, triggerOnce: true });
  const items = Children.toArray(children);

  return (
    <div ref={ref} className={className}>
      {items.map((child, index) => {
        const style: CSSProperties = {
          animationDelay: `${index * stagger}ms`,
          ...(isInView ? {} : { opacity: 0 }),
        };

        const animClass = isInView
          ? `animate-${animation} animation-fill-both`
          : '';

        return (
          <div key={index} className={`${animClass} ${childClassName}`} style={style}>
            {child}
          </div>
        );
      })}
    </div>
  );
}
