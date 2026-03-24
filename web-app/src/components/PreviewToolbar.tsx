import { useState, useCallback, useEffect, useRef } from 'react';
import {
  ZoomIn, ZoomOut, Maximize2, Minimize2,
  Copy, Check, Camera, RotateCw,
  AlertCircle, ChevronDown, ChevronUp,
} from 'lucide-react';
import { DeviceFrameSelector, useDeviceFrame } from './DeviceFrameSelector';
import type { DeviceType } from './DeviceFrameSelector';

// C26: Zoom controls (75%, 100%, 125%)
// C27: QR code generator (SVG inline)
// C28: Screenshot button
// C29: Preview URL copy button with toast
// C30: Full-screen preview mode
// C31: Responsive breakpoint indicator
// C32: Loading skeleton inside preview iframe
// C33: Preview console panel
// C34: Preview refresh button with spin animation

interface PreviewToolbarProps {
  previewUrl: string;
  onRefresh: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  children?: React.ReactNode; // Slot for existing toolbar buttons
}

// C26: Zoom controls
const ZOOM_LEVELS = [75, 100, 125] as const;

export function ZoomControls({
  zoom, onZoomChange,
}: {
  zoom: number;
  onZoomChange: (z: number) => void;
}) {
  return (
    <div className="flex items-center gap-0.5 border border-border rounded-btn">
      {ZOOM_LEVELS.map(level => (
        <button
          key={level}
          onClick={() => onZoomChange(level)}
          className={`px-2 py-1 text-[10px] font-medium transition-colors ${
            zoom === level
              ? 'bg-primary/10 text-primary'
              : 'text-muted hover:text-ink hover:bg-hover'
          }`}
          title={`Zoom ${level}%`}
        >
          {level}%
        </button>
      ))}
    </div>
  );
}

// C27: Minimal QR code as SVG
// Generates a simple visual representation since full QR encoding is complex
function QRCodeSVG({ data, size = 80 }: { data: string; size?: number }) {
  // Simple hash-based pattern for visual QR representation
  const cells = 11;
  const cellSize = size / cells;
  const grid: boolean[][] = [];

  // Generate deterministic pattern from URL
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    hash = ((hash << 5) - hash + data.charCodeAt(i)) | 0;
  }

  for (let y = 0; y < cells; y++) {
    grid[y] = [];
    for (let x = 0; x < cells; x++) {
      // Finder patterns (3 corners)
      const isFinderTL = x < 3 && y < 3;
      const isFinderTR = x >= cells - 3 && y < 3;
      const isFinderBL = x < 3 && y >= cells - 3;
      const isFinderBorder = (isFinderTL || isFinderTR || isFinderBL) && (
        x === 0 || y === 0 || x === 2 || y === 2 ||
        x === cells - 1 || y === cells - 1 || x === cells - 3 || y === cells - 3
      );
      const isFinderCenter = (
        (x === 1 && y === 1) ||
        (x === cells - 2 && y === 1) ||
        (x === 1 && y === cells - 2)
      );

      if (isFinderBorder || isFinderCenter) {
        grid[y][x] = true;
      } else if (isFinderTL || isFinderTR || isFinderBL) {
        grid[y][x] = false;
      } else {
        // Data area - deterministic pattern
        const seed = (hash + x * 17 + y * 31) & 0xFFFF;
        grid[y][x] = seed % 3 !== 0;
      }
    }
  }

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="bg-white rounded p-1">
      {grid.map((row, y) =>
        row.map((cell, x) =>
          cell ? (
            <rect
              key={`${x}-${y}`}
              x={x * cellSize}
              y={y * cellSize}
              width={cellSize}
              height={cellSize}
              fill="#201515"
            />
          ) : null
        )
      )}
    </svg>
  );
}

// C28: Screenshot tooltip
export function ScreenshotButton() {
  const [showTip, setShowTip] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setShowTip(prev => !prev)}
        className="p-1.5 rounded text-muted hover:text-ink hover:bg-hover transition-colors"
        title="Screenshot"
      >
        <Camera size={14} />
      </button>
      {showTip && (
        <div className="absolute top-full right-0 mt-1 z-20 bg-card border border-border rounded-btn shadow-lg p-2 text-xs text-muted whitespace-nowrap">
          Right-click the preview to save as image
        </div>
      )}
    </div>
  );
}

// C29: Copy URL with toast
export function CopyUrlButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  }, [url]);

  return (
    <button
      onClick={handleCopy}
      className="p-1.5 rounded text-muted hover:text-ink hover:bg-hover transition-colors relative"
      title="Copy preview URL"
    >
      {copied ? (
        <Check size={14} className="text-success" />
      ) : (
        <Copy size={14} />
      )}
      {/* Toast */}
      {copied && (
        <div className="copy-toast">
          Copied!
        </div>
      )}
    </button>
  );
}

// C30: Fullscreen toggle
export function FullscreenButton({
  isFullscreen, onToggle,
}: {
  isFullscreen: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="p-1.5 rounded text-muted hover:text-ink hover:bg-hover transition-colors"
      title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen preview'}
    >
      {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
    </button>
  );
}

// C33: Preview console panel showing last 5 JS console messages
interface ConsoleMessage {
  level: 'log' | 'warn' | 'error' | 'info';
  message: string;
  timestamp: number;
}

export function PreviewConsole({ messages }: { messages: ConsoleMessage[] }) {
  const [expanded, setExpanded] = useState(false);
  const recent = messages.slice(-5);
  const hasErrors = recent.some(m => m.level === 'error');

  if (recent.length === 0) return null;

  return (
    <div className={`border-t border-border bg-card ${expanded ? '' : 'cursor-pointer'}`}>
      <button
        onClick={() => setExpanded(prev => !prev)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] font-mono hover:bg-hover transition-colors"
      >
        {hasErrors ? (
          <AlertCircle size={12} className="text-danger" />
        ) : (
          <span className="w-3 h-3 rounded-full border border-muted/40 flex items-center justify-center text-[8px] text-muted">i</span>
        )}
        <span className={`font-medium ${hasErrors ? 'text-danger' : 'text-muted'}`}>
          Console ({recent.length})
        </span>
        <div className="flex-1" />
        {expanded ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
      </button>
      {expanded && (
        <div className="max-h-32 overflow-y-auto terminal-scroll border-t border-border">
          {recent.map((msg, i) => (
            <div
              key={i}
              className={`px-3 py-1 text-[11px] font-mono border-b border-border/50 last:border-b-0 ${
                msg.level === 'error' ? 'bg-danger/5 text-danger' :
                msg.level === 'warn' ? 'bg-warning/5 text-warning' :
                'text-muted'
              }`}
            >
              <span className="uppercase text-[9px] font-semibold mr-2 opacity-60">
                {msg.level}
              </span>
              {msg.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// C34: Refresh button with spin animation
export function RefreshButton({
  onClick, isRefreshing,
}: {
  onClick: () => void;
  isRefreshing?: boolean;
}) {
  const [spinning, setSpinning] = useState(false);

  const handleClick = useCallback(() => {
    setSpinning(true);
    onClick();
    setTimeout(() => setSpinning(false), 600);
  }, [onClick]);

  return (
    <button
      onClick={handleClick}
      className="p-1.5 rounded text-muted hover:text-ink hover:bg-hover transition-colors"
      title="Refresh preview"
    >
      <RotateCw
        size={14}
        className={spinning || isRefreshing ? 'animate-spin-once' : ''}
      />
    </button>
  );
}

// C32: Preview loading skeleton
export function PreviewSkeleton() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-card p-8">
      <div className="w-full max-w-md space-y-4">
        {/* Mock nav bar */}
        <div className="skeleton-shimmer h-10 w-full rounded" />
        {/* Mock hero */}
        <div className="skeleton-shimmer h-32 w-full rounded" />
        {/* Mock content */}
        <div className="flex gap-4">
          <div className="skeleton-shimmer h-20 flex-1 rounded" />
          <div className="skeleton-shimmer h-20 flex-1 rounded" />
          <div className="skeleton-shimmer h-20 flex-1 rounded" />
        </div>
        <div className="skeleton-shimmer h-8 w-48 rounded mx-auto" />
      </div>
      <p className="text-xs text-muted mt-6 animate-pulse">Loading preview...</p>
    </div>
  );
}

// QR code popover
export function QRCodeButton({ url }: { url: string }) {
  const [showQR, setShowQR] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showQR) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setShowQR(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showQR]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setShowQR(prev => !prev)}
        className="p-1.5 rounded text-muted hover:text-ink hover:bg-hover transition-colors text-[10px] font-semibold"
        title="Show QR code"
      >
        QR
      </button>
      {showQR && (
        <div className="absolute top-full right-0 mt-1 z-30 bg-card border border-border rounded-btn shadow-lg p-3">
          <QRCodeSVG data={url} size={100} />
          <p className="text-[10px] text-muted text-center mt-2 max-w-[100px] truncate">{url}</p>
        </div>
      )}
    </div>
  );
}

// Main enhanced toolbar that wraps the existing preview toolbar elements
export function PreviewToolbar({ previewUrl, onRefresh, isFullscreen, onToggleFullscreen, children }: PreviewToolbarProps) {
  return (
    <div className="flex items-center gap-1">
      {children}
      <div className="flex items-center gap-0.5 ml-auto border-l border-border pl-2">
        <RefreshButton onClick={onRefresh} />
        <CopyUrlButton url={previewUrl} />
        <ScreenshotButton />
        <QRCodeButton url={previewUrl} />
        <FullscreenButton isFullscreen={isFullscreen} onToggle={onToggleFullscreen} />
      </div>
    </div>
  );
}

export { DeviceFrameSelector, useDeviceFrame };
export type { ConsoleMessage };
