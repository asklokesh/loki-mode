import { useState, useEffect, useCallback } from 'react';
import {
  FileCode2, FileType, FileJson, FileText, File as FileIcon,
  Save, Share2, Timer, Zap, Copy, Check,
} from 'lucide-react';

// B18: Auto-save indicator
// B20: Bottom status bar with file type icon, line count, cursor position
// B23: Share build button
// B24: Build speed metric

interface StatusBarProps {
  selectedFile: string | null;
  fileName: string;
  isModified: boolean;
  isSaving: boolean;
  lastSavedAt: number | null;
  lineCount: number;
  cursorLine: number;
  cursorColumn: number;
  buildTime?: number; // seconds
  sessionId?: string;
  prd?: string;
}

function getFileTypeIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, { icon: typeof FileIcon; color: string; label: string }> = {
    js: { icon: FileCode2, color: 'text-yellow-600', label: 'JavaScript' },
    jsx: { icon: FileCode2, color: 'text-yellow-500', label: 'JSX' },
    ts: { icon: FileCode2, color: 'text-blue-500', label: 'TypeScript' },
    tsx: { icon: FileCode2, color: 'text-blue-400', label: 'TSX' },
    py: { icon: FileCode2, color: 'text-green-600', label: 'Python' },
    html: { icon: FileCode2, color: 'text-orange-500', label: 'HTML' },
    css: { icon: FileType, color: 'text-purple-500', label: 'CSS' },
    json: { icon: FileJson, color: 'text-green-500', label: 'JSON' },
    md: { icon: FileText, color: 'text-muted', label: 'Markdown' },
    go: { icon: FileCode2, color: 'text-cyan-600', label: 'Go' },
    rs: { icon: FileCode2, color: 'text-orange-600', label: 'Rust' },
  };
  return map[ext] || { icon: FileIcon, color: 'text-muted', label: ext.toUpperCase() || 'Plain Text' };
}

function formatTimeSince(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 2) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ago`;
}

function formatBuildDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

export function StatusBar({
  selectedFile, fileName, isModified, isSaving, lastSavedAt,
  lineCount, cursorLine, cursorColumn,
  buildTime, sessionId, prd,
}: StatusBarProps) {
  const [timeSince, setTimeSince] = useState('');
  const [copied, setCopied] = useState(false);

  // Update "saved X ago" every 5s
  useEffect(() => {
    if (!lastSavedAt) return;
    const update = () => setTimeSince(formatTimeSince(lastSavedAt));
    update();
    const interval = setInterval(update, 5000);
    return () => clearInterval(interval);
  }, [lastSavedAt]);

  // B23: Share build summary
  const handleShare = useCallback(async () => {
    const summary = [
      `Built with Loki Mode`,
      sessionId ? `Session: ${sessionId}` : '',
      buildTime ? `Build time: ${formatBuildDuration(buildTime)}` : '',
      prd ? `\nProject: ${prd.substring(0, 100)}${prd.length > 100 ? '...' : ''}` : '',
      `\nhttps://autonomi.dev`,
    ].filter(Boolean).join('\n');

    try {
      await navigator.clipboard.writeText(summary);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  }, [sessionId, buildTime, prd]);

  if (!selectedFile) return null;

  const fileType = getFileTypeIcon(fileName);
  const FileTypeIcon = fileType.icon;

  // B24: Rough estimate - manual coding takes ~5-10x longer
  const manualEstimate = buildTime ? buildTime * 5 : 0;
  const speedMultiple = buildTime && manualEstimate > 0 ? (manualEstimate / buildTime).toFixed(1) : null;

  return (
    <div className="flex items-center gap-3 px-3 py-1 bg-card border-t border-border text-[11px] font-mono text-muted select-none flex-shrink-0">
      {/* File type icon + label */}
      <span className="flex items-center gap-1.5">
        <FileTypeIcon size={12} className={fileType.color} />
        <span>{fileType.label}</span>
      </span>

      <span className="text-border">|</span>

      {/* Line count */}
      <span>{lineCount} lines</span>

      <span className="text-border">|</span>

      {/* Cursor position */}
      <span>Ln {cursorLine}, Col {cursorColumn}</span>

      {/* Save indicator */}
      <span className="text-border">|</span>
      <span className="flex items-center gap-1">
        <Save size={11} />
        {isSaving ? (
          <span className="text-primary animate-pulse">Saving...</span>
        ) : isModified ? (
          <span className="text-warning">Unsaved</span>
        ) : lastSavedAt ? (
          <span className="text-success">Saved {timeSince}</span>
        ) : (
          <span>Saved</span>
        )}
      </span>

      <div className="flex-1" />

      {/* B24: Build speed metric */}
      {buildTime != null && buildTime > 0 && (
        <span className="flex items-center gap-1 text-success">
          <Timer size={11} />
          <span>Built in {formatBuildDuration(buildTime)}</span>
          {speedMultiple && (
            <span className="text-muted ml-1">
              <Zap size={10} className="inline" /> {speedMultiple}x faster
            </span>
          )}
        </span>
      )}

      {/* B23: Share button */}
      {sessionId && (
        <>
          <span className="text-border">|</span>
          <button
            onClick={handleShare}
            className="flex items-center gap-1 hover:text-primary transition-colors"
            title="Copy build summary to clipboard"
          >
            {copied ? (
              <>
                <Check size={11} className="text-success" />
                <span className="text-success">Copied!</span>
              </>
            ) : (
              <>
                <Share2 size={11} />
                <span>Share</span>
              </>
            )}
          </button>
        </>
      )}
    </div>
  );
}

// Toast notification for share
export function ShareToast({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div className="share-toast">
      <Copy size={14} />
      <span>Build summary copied to clipboard!</span>
    </div>
  );
}
