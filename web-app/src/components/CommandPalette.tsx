import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, File, Folder, FileCode2, FileJson, FileText, FileCode, FileType } from 'lucide-react';
import { api } from '../api/client';
import type { FileSearchResult } from '../types/api';

interface CommandItem {
  id: string;
  label: string;
  category: 'file' | 'command' | 'setting' | 'ai';
  icon: React.ComponentType<{size?: number}>;
  action: () => void;
  shortcut?: string;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  commands: CommandItem[];
  sessionId?: string;
  onFileSelect?: (path: string, name: string) => void;
}

export type { CommandItem };

function getFileIconComponent(name: string): React.ComponentType<{size?: number}> {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const icons: Record<string, React.ComponentType<{size?: number}>> = {
    js: FileCode2,
    ts: FileCode2,
    tsx: FileCode2,
    jsx: FileCode2,
    py: FileCode2,
    go: FileCode2,
    rs: FileCode2,
    rb: FileCode2,
    sh: FileCode2,
    html: FileCode,
    css: FileType,
    json: FileJson,
    md: FileText,
  };
  return icons[ext] || File;
}

export function CommandPalette({ isOpen, onClose, commands, sessionId, onFileSelect }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [fileResults, setFileResults] = useState<FileSearchResult[]>([]);
  const [fileSearching, setFileSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setFileResults([]);
      setFileSearching(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Filter commands by query
  const filteredCommands = commands.filter(cmd =>
    cmd.label.toLowerCase().includes(query.toLowerCase())
  );

  // Search files when query changes (debounced)
  useEffect(() => {
    if (!sessionId || !query.trim()) {
      setFileResults([]);
      setFileSearching(false);
      return;
    }

    setFileSearching(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      try {
        const results = await api.searchFiles(sessionId, query);
        // Only include files, not directories, for file search results
        setFileResults(results.filter(r => r.type === 'file'));
      } catch {
        setFileResults([]);
      }
      setFileSearching(false);
    }, 200);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, sessionId]);

  // Combined results: commands first, then file results
  const totalResults = filteredCommands.length + fileResults.length;

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleAction = useCallback((index: number) => {
    if (index < filteredCommands.length) {
      filteredCommands[index].action();
      onClose();
    } else {
      const fileIndex = index - filteredCommands.length;
      const file = fileResults[fileIndex];
      if (file && onFileSelect) {
        onFileSelect(file.path, file.name);
        onClose();
      }
    }
  }, [filteredCommands, fileResults, onFileSelect, onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, totalResults - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && totalResults > 0) {
      handleAction(selectedIndex);
    } else if (e.key === 'Escape') {
      onClose();
    }
  }, [totalResults, selectedIndex, handleAction, onClose]);

  if (!isOpen) return null;

  const hasCommands = filteredCommands.length > 0;
  const hasFiles = fileResults.length > 0;
  const showFileSearching = fileSearching && query.trim().length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-lg bg-card rounded-xl shadow-2xl border border-border overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <Search size={18} className="text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search commands, files, actions..."
            className="flex-1 bg-transparent text-sm outline-none text-ink placeholder:text-muted"
          />
          <kbd className="text-[10px] text-muted bg-hover px-1.5 py-0.5 rounded border border-border font-mono">ESC</kbd>
        </div>
        <div className="max-h-[360px] overflow-y-auto py-1 terminal-scroll">
          {/* Commands section */}
          {hasCommands && (
            <>
              <div className="px-4 py-1.5 text-[10px] font-semibold text-muted uppercase tracking-wider">
                Commands
              </div>
              {filteredCommands.map((cmd, i) => {
                const Icon = cmd.icon;
                return (
                  <button
                    key={cmd.id}
                    onClick={() => { cmd.action(); onClose(); }}
                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                      i === selectedIndex ? 'bg-primary/10 text-primary' : 'text-ink hover:bg-hover'
                    }`}
                  >
                    <Icon size={16} />
                    <span className="flex-1 text-left">{cmd.label}</span>
                    {cmd.shortcut && (
                      <kbd className="text-[10px] text-muted bg-hover px-1.5 py-0.5 rounded border border-border font-mono">{cmd.shortcut}</kbd>
                    )}
                  </button>
                );
              })}
            </>
          )}

          {/* File results section */}
          {hasFiles && (
            <>
              <div className="px-4 py-1.5 text-[10px] font-semibold text-muted uppercase tracking-wider mt-1">
                Files
              </div>
              {fileResults.map((file, i) => {
                const globalIndex = filteredCommands.length + i;
                const IconComponent = file.type === 'directory'
                  ? Folder
                  : getFileIconComponent(file.name);
                return (
                  <button
                    key={`file-${file.path}`}
                    onClick={() => handleAction(globalIndex)}
                    className={`w-full flex items-center gap-3 px-4 py-2 text-sm transition-colors ${
                      globalIndex === selectedIndex ? 'bg-primary/10 text-primary' : 'text-ink hover:bg-hover'
                    }`}
                  >
                    <IconComponent size={14} />
                    <span className="flex-1 text-left font-mono text-xs truncate">{file.name}</span>
                    <span className="text-[10px] text-muted truncate max-w-[200px]">{file.path}</span>
                  </button>
                );
              })}
            </>
          )}

          {/* Loading indicator for file search */}
          {showFileSearching && !hasFiles && (
            <div className="px-4 py-2 text-xs text-muted animate-pulse">
              Searching files...
            </div>
          )}

          {/* No results */}
          {totalResults === 0 && !showFileSearching && (
            <div className="px-4 py-8 text-center text-sm text-muted">No results found</div>
          )}
        </div>
      </div>
    </div>
  );
}
