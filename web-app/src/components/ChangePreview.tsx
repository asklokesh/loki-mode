import { useState, useCallback } from 'react';
import {
  X, Check, CheckCheck, Ban, FileCode2, FilePlus, FileX, ChevronRight,
  Plus, Minus,
} from 'lucide-react';
import type { ChangePreviewData, FileDiff, DiffLine } from '../types/api';

interface ChangePreviewProps {
  data: ChangePreviewData;
  onAcceptAll: () => void;
  onAcceptSelected: (paths: string[]) => void;
  onReject: () => void;
  onClose: () => void;
}

function DiffLineView({ line }: { line: DiffLine }) {
  const bgClass =
    line.type === 'add'
      ? 'bg-success/10'
      : line.type === 'delete'
      ? 'bg-danger/10'
      : '';
  const textClass =
    line.type === 'add'
      ? 'text-success'
      : line.type === 'delete'
      ? 'text-danger'
      : 'text-muted';
  const prefix =
    line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' ';
  const lineNum =
    line.type === 'delete' ? line.old_line : line.new_line;

  return (
    <div className={`flex font-mono text-xs leading-5 ${bgClass}`}>
      <span className="w-12 text-right pr-2 text-muted/60 select-none flex-shrink-0 border-r border-border">
        {lineNum || ''}
      </span>
      <span className={`w-5 text-center select-none flex-shrink-0 ${textClass} font-bold`}>
        {prefix}
      </span>
      <span className={`flex-1 whitespace-pre-wrap break-all pl-1 ${
        line.type === 'context' ? 'text-ink/70' : textClass
      }`}>
        {line.content}
      </span>
    </div>
  );
}

function FileDiffView({ file, isSelected, onToggle }: {
  file: FileDiff;
  isSelected: boolean;
  onToggle: () => void;
}) {
  const [expanded, setExpanded] = useState(true);

  const actionIcon =
    file.action === 'add'
      ? <FilePlus size={14} className="text-success" />
      : file.action === 'delete'
      ? <FileX size={14} className="text-danger" />
      : <FileCode2 size={14} className="text-blue-500" />;

  const actionLabel =
    file.action === 'add' ? 'New' : file.action === 'delete' ? 'Deleted' : 'Modified';

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      {/* File header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-hover/50">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={onToggle}
          className="w-3.5 h-3.5 rounded border-border accent-primary cursor-pointer"
        />
        <button
          onClick={() => setExpanded(v => !v)}
          className="flex items-center gap-1 flex-1 min-w-0 text-left"
        >
          <ChevronRight
            size={14}
            className={`text-muted transition-transform flex-shrink-0 ${expanded ? 'rotate-90' : ''}`}
          />
          {actionIcon}
          <span className="text-xs font-mono text-ink truncate">{file.path}</span>
        </button>
        <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded ${
          file.action === 'add'
            ? 'bg-success/10 text-success'
            : file.action === 'delete'
            ? 'bg-danger/10 text-danger'
            : 'bg-blue-500/10 text-blue-500'
        }`}>
          {actionLabel}
        </span>
        {file.additions > 0 && (
          <span className="flex items-center gap-0.5 text-[11px] text-success">
            <Plus size={10} />
            {file.additions}
          </span>
        )}
        {file.deletions > 0 && (
          <span className="flex items-center gap-0.5 text-[11px] text-danger">
            <Minus size={10} />
            {file.deletions}
          </span>
        )}
      </div>

      {/* Diff content */}
      {expanded && file.hunks.length > 0 && (
        <div className="border-t border-border max-h-[300px] overflow-y-auto terminal-scroll">
          {file.hunks.map((hunk, hi) => (
            <div key={hi}>
              {hi > 0 && (
                <div className="px-3 py-1 bg-hover/30 text-[11px] text-muted font-mono border-y border-border">
                  @@ -{hunk.old_start},{hunk.old_count} +{hunk.new_start},{hunk.new_count} @@
                </div>
              )}
              {hunk.lines.map((line, li) => (
                <DiffLineView key={`${hi}-${li}`} line={line} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ChangePreview({ data, onAcceptAll, onAcceptSelected, onReject, onClose }: ChangePreviewProps) {
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(
    () => new Set(data.files.map(f => f.path))
  );
  const [activeFileIndex, setActiveFileIndex] = useState(0);

  const toggleFile = useCallback((path: string) => {
    setSelectedFiles(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    if (selectedFiles.size === data.files.length) {
      setSelectedFiles(new Set());
    } else {
      setSelectedFiles(new Set(data.files.map(f => f.path)));
    }
  }, [selectedFiles.size, data.files]);

  const handleAcceptSelected = useCallback(() => {
    onAcceptSelected(Array.from(selectedFiles));
  }, [selectedFiles, onAcceptSelected]);

  if (data.files.length === 0) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
        <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
        <div className="relative bg-card rounded-xl shadow-2xl border border-border p-8 max-w-md" onClick={e => e.stopPropagation()}>
          <p className="text-sm text-ink text-center">No pending changes to preview.</p>
          <button
            onClick={onClose}
            className="mt-4 w-full py-2 text-sm font-medium rounded-btn border border-border text-muted hover:text-ink hover:bg-hover transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        className="relative bg-card rounded-xl shadow-2xl border border-border w-full max-w-5xl max-h-[85vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border flex-shrink-0">
          <FileCode2 size={18} className="text-primary" />
          <h3 className="text-sm font-bold text-ink flex-1">Change Preview</h3>
          <div className="flex items-center gap-2 text-xs text-muted">
            <span className="flex items-center gap-1 text-success">
              <Plus size={12} />
              {data.total_additions}
            </span>
            <span className="flex items-center gap-1 text-danger">
              <Minus size={12} />
              {data.total_deletions}
            </span>
            <span>{data.files.length} file{data.files.length !== 1 ? 's' : ''}</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-hover text-muted hover:text-ink transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content: file list sidebar + diff view */}
        <div className="flex flex-1 min-h-0">
          {/* File list sidebar */}
          <div className="w-56 flex-shrink-0 border-r border-border overflow-y-auto terminal-scroll bg-hover/30">
            <div className="px-3 py-2 border-b border-border">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedFiles.size === data.files.length}
                  onChange={toggleAll}
                  className="w-3.5 h-3.5 rounded border-border accent-primary"
                />
                <span className="text-[11px] font-medium text-muted">Select All</span>
              </label>
            </div>
            {data.files.map((file, i) => {
              const actionColor =
                file.action === 'add'
                  ? 'text-success'
                  : file.action === 'delete'
                  ? 'text-danger'
                  : 'text-blue-500';
              return (
                <button
                  key={file.path}
                  onClick={() => setActiveFileIndex(i)}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                    i === activeFileIndex ? 'bg-primary/10 text-primary' : 'text-ink hover:bg-hover'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selectedFiles.has(file.path)}
                    onChange={() => toggleFile(file.path)}
                    onClick={e => e.stopPropagation()}
                    className="w-3 h-3 rounded border-border accent-primary flex-shrink-0"
                  />
                  <span className="text-xs font-mono truncate flex-1">{file.path.split('/').pop()}</span>
                  <span className={`text-[10px] flex-shrink-0 ${actionColor}`}>
                    {file.action === 'add' ? '+' : file.action === 'delete' ? '-' : 'M'}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Diff view */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3 terminal-scroll">
            {data.files[activeFileIndex] && (
              <FileDiffView
                file={data.files[activeFileIndex]}
                isSelected={selectedFiles.has(data.files[activeFileIndex].path)}
                onToggle={() => toggleFile(data.files[activeFileIndex].path)}
              />
            )}
          </div>
        </div>

        {/* Footer actions */}
        <div className="flex items-center gap-2 px-4 py-3 border-t border-border bg-hover/30 flex-shrink-0">
          <button
            onClick={onReject}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-btn border border-danger/30 text-danger hover:bg-danger/10 transition-colors"
          >
            <Ban size={14} />
            Reject
          </button>
          <div className="flex-1" />
          <button
            onClick={handleAcceptSelected}
            disabled={selectedFiles.size === 0}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-btn border border-primary/30 text-primary hover:bg-primary/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Check size={14} />
            Accept Selected ({selectedFiles.size})
          </button>
          <button
            onClick={onAcceptAll}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-btn bg-primary text-white hover:bg-primary-hover transition-colors"
          >
            <CheckCheck size={14} />
            Accept All
          </button>
        </div>
      </div>
    </div>
  );
}
