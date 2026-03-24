import { type ReactNode } from 'react';

export interface PageTransitionProps {
  children: ReactNode;
  className?: string;
}

/**
 * Wraps page content with a fade-in entrance animation on mount.
 * CSS-only -- no JS animation libraries needed.
 */
export function PageTransition({ children, className = '' }: PageTransitionProps) {
  return (
    <div className={`animate-fade-in animation-fill-both ${className}`}>
      {children}
    </div>
  );
}
