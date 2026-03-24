import { useEffect, useState, useRef } from 'react';

// B16: Token usage sparkline in header
// SVG-based tiny line chart showing last 10 data points
// Green=under budget, Yellow=approaching, Red=over

interface TokenSparklineProps {
  tokenHistory: number[];
  budget?: number;
  className?: string;
}

export function TokenSparkline({ tokenHistory, budget = 100000, className = '' }: TokenSparklineProps) {
  const points = tokenHistory.slice(-10);
  if (points.length < 2) return null;

  const width = 64;
  const height = 20;
  const padding = 2;

  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const range = max - min || 1;

  const coords = points.map((val, i) => ({
    x: padding + (i / (points.length - 1)) * (width - padding * 2),
    y: padding + (1 - (val - min) / range) * (height - padding * 2),
  }));

  const pathD = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(' ');

  // Fill area under the line
  const fillD = `${pathD} L ${coords[coords.length - 1].x.toFixed(1)} ${height - padding} L ${coords[0].x.toFixed(1)} ${height - padding} Z`;

  // Color based on current usage vs budget
  const current = points[points.length - 1];
  const ratio = current / budget;
  let strokeColor = '#1FC5A8'; // green / success
  let fillColor = 'rgba(31, 197, 168, 0.15)';
  if (ratio > 1) {
    strokeColor = '#C45B5B'; // red / danger
    fillColor = 'rgba(196, 91, 91, 0.15)';
  } else if (ratio > 0.75) {
    strokeColor = '#D4A03C'; // yellow / warning
    fillColor = 'rgba(212, 160, 60, 0.15)';
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={`inline-block align-middle ${className}`}
      aria-label="Token usage trend"
    >
      <path d={fillD} fill={fillColor} />
      <path d={pathD} fill="none" stroke={strokeColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      {/* Current value dot */}
      <circle
        cx={coords[coords.length - 1].x}
        cy={coords[coords.length - 1].y}
        r="2"
        fill={strokeColor}
      />
    </svg>
  );
}

// Hook to accumulate token history from polling
export function useTokenHistory() {
  const [history, setHistory] = useState<number[]>([]);
  const lastRef = useRef(0);

  const recordTokens = (tokens: number) => {
    if (tokens !== lastRef.current) {
      lastRef.current = tokens;
      setHistory(prev => {
        const next = [...prev, tokens];
        return next.length > 20 ? next.slice(-20) : next;
      });
    }
  };

  return { history, recordTokens };
}
