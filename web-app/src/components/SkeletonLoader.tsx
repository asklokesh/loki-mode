import { useState, useEffect } from 'react';

// B13-B14: Skeleton loading components with shimmer animation
// Variants: card, list, text, code

interface SkeletonLoaderProps {
  variant: 'card' | 'list' | 'text' | 'code';
  count?: number;
  className?: string;
}

function ShimmerBar({ width, height = '12px', className = '' }: { width: string; height?: string; className?: string }) {
  return (
    <div
      className={`skeleton-shimmer rounded ${className}`}
      style={{ width, height }}
    />
  );
}

function SkeletonCard() {
  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-3">
        <div className="skeleton-shimmer w-10 h-10 rounded-full flex-shrink-0" />
        <div className="flex-1 space-y-2">
          <ShimmerBar width="60%" height="14px" />
          <ShimmerBar width="40%" height="10px" />
        </div>
      </div>
      <ShimmerBar width="100%" height="10px" />
      <ShimmerBar width="85%" height="10px" />
      <ShimmerBar width="70%" height="10px" />
      <div className="flex items-center gap-2 pt-1">
        <ShimmerBar width="60px" height="24px" className="rounded-btn" />
        <ShimmerBar width="60px" height="24px" className="rounded-btn" />
      </div>
    </div>
  );
}

function SkeletonList() {
  return (
    <div className="space-y-1">
      {[...Array(6)].map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-2">
          <div className="skeleton-shimmer w-5 h-5 rounded flex-shrink-0" />
          <ShimmerBar width={`${45 + Math.random() * 35}%`} height="12px" />
          <div className="ml-auto">
            <ShimmerBar width="40px" height="10px" />
          </div>
        </div>
      ))}
    </div>
  );
}

function SkeletonText() {
  return (
    <div className="space-y-2.5 p-4">
      <ShimmerBar width="70%" height="16px" />
      <ShimmerBar width="100%" height="11px" />
      <ShimmerBar width="90%" height="11px" />
      <ShimmerBar width="60%" height="11px" />
      <div className="pt-2" />
      <ShimmerBar width="80%" height="11px" />
      <ShimmerBar width="95%" height="11px" />
      <ShimmerBar width="50%" height="11px" />
    </div>
  );
}

function SkeletonCode() {
  const lineWidths = [45, 60, 75, 30, 0, 80, 55, 65, 40, 70, 50, 35];
  return (
    <div className="p-4 space-y-2 font-mono">
      {lineWidths.map((w, i) => (
        <div key={i} className="flex items-center gap-3">
          <ShimmerBar width="24px" height="10px" className="opacity-40 flex-shrink-0" />
          {w > 0 ? (
            <ShimmerBar width={`${w}%`} height="10px" />
          ) : (
            <div style={{ height: '10px' }} />
          )}
        </div>
      ))}
    </div>
  );
}

export function SkeletonLoader({ variant, count = 1, className = '' }: SkeletonLoaderProps) {
  const [visible, setVisible] = useState(false);

  // Small delay to avoid flash for fast loads
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 100);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  const items = [...Array(count)];

  return (
    <div className={`skeleton-loader-container ${className}`}>
      {items.map((_, i) => {
        switch (variant) {
          case 'card': return <SkeletonCard key={i} />;
          case 'list': return <SkeletonList key={i} />;
          case 'text': return <SkeletonText key={i} />;
          case 'code': return <SkeletonCode key={i} />;
        }
      })}
    </div>
  );
}

// B15: Template grid loading skeleton
export function SkeletonTemplateGrid() {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-4 p-4">
      {[...Array(6)].map((_, i) => (
        <div key={i} className="card p-4 space-y-3">
          <div className="skeleton-shimmer w-12 h-12 rounded-btn" />
          <ShimmerBar width="70%" height="14px" />
          <ShimmerBar width="90%" height="10px" />
          <ShimmerBar width="60%" height="10px" />
        </div>
      ))}
    </div>
  );
}

// Chat loading skeleton
export function SkeletonChat() {
  return (
    <div className="space-y-4 p-4">
      {[...Array(3)].map((_, i) => (
        <div key={i} className={`flex gap-3 ${i % 2 === 0 ? '' : 'flex-row-reverse'}`}>
          <div className="skeleton-shimmer w-8 h-8 rounded-full flex-shrink-0" />
          <div className={`space-y-2 ${i % 2 === 0 ? 'max-w-[70%]' : 'max-w-[60%]'}`}>
            <div className={`skeleton-shimmer rounded-btn p-3 space-y-2 ${
              i % 2 === 0 ? 'rounded-tl-none' : 'rounded-tr-none'
            }`} style={{ minHeight: '48px' }}>
              <ShimmerBar width="100%" height="10px" />
              {i !== 1 && <ShimmerBar width="70%" height="10px" />}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
