import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Search, File, Folder, FileCode2, FileJson, FileText, FileCode, FileType, Clock } from 'lucide-react';
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

const RECENT_KEY = 'pl_recent_commands';
const MAX_RECENT = 5;

function getRecentIds(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function pushRecent(id: string) {
  try {
    const recent = getRecentIds().filter(r => r !== id);
    recent.unshift(id);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, MAX_RECENT)));
  } catch {
    // ignore storage errors
  }
}

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

/** Fuzzy match: returns indices of matched chars, or null if no match */
function fuzzyMatch(query: string, text: string): number[] | null {
  const qLower = query.toLowerCase();
  const tLower = text.toLowerCase();
  const indices: number[] = [];
  let qi = 0;
  for (let ti = 0; ti < tLower.length && qi < qLower.length; ti++) {
    if (tLower[ti] === qLower[qi]) {
      indices.push(ti);
      qi++;
    }
  }
  return qi === qLower.length ? indices : null;
}

/** Render text with highlighted match indices */
function HighlightedText({ text, indices }: { text: string; indices: number[] }) {
  if (indices.length === 0) return <>{text}</>;
  const set = new Set(indices);
  return (
    <>
      {text.split('').map((char, i) => (
        set.has(i)
          ? <span key={i} className="text-primary font-semibold">{char}</span>
          : <span key={i}>{char}</span>
      ))}
    </>
  );
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

  // D36: Recent commands
  const recentCommands = useMemo(() => {
    const ids = getRecentIds();
    return ids.map(id => commands.find(c => c.id === id)).filter(Boolean) as CommandItem[];
  }, [commands]);

  // D36: Fuzzy filter commands by query with match indices
  const filteredCommands = useMemo(() => {
    if (!query.trim()) return commands.map(cmd => ({ cmd, indices: [] as number[] }));
    const results: { cmd: CommandItem; indices: number[]; score: number }[] = [];
    for (const cmd of commands) {
      const indices = fuzzyMatch(query, cmd.label);
      if (indices) {
        // Score: prefer matches that start earlier and are more contiguous
        const score = indices[0] * 10 + (indices[indices.length - 1] - indices[0]);
        results.push({ cmd, indices, score });
      }
    }
    results.sort((a, b) => a.score - b.score);
    return results.map(r => ({ cmd: r.cmd, indices: r.indices }));
  }, [commands, query]);

  // D36: Settings results (filter settings commands when query present)
  const settingsResults = useMemo(() => {
    if (!query.trim()) return [];
    return filteredCommands.filter(r => r.cmd.category === 'setting');
  }, [filteredCommands, query]);

  // Non-setting commands
  const commandResults = useMemo(() => {
    return filteredCommands.filter(r => r.cmd.category !== 'setting');
  }, [filteredCommands]);

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

  // Build flat list of all selectable items for keyboard navigation
  const showRecent = !query.trim() && recentCommands.length > 0;
  const allItems = useMemo(() => {
    const items: { type: 'recent' | 'command' | 'setting' | 'file'; index: number }[] = [];
    if (showRecent) {
      recentCommands.forEach((_, i) => items.push({ type: 'recent', index: i }));
    }
    commandResults.forEach((_, i) => items.push({ type: 'command', index: i }));
    if (settingsResults.length > 0) {
      settingsResults.forEach((_, i) => items.push({ type: 'setting', index: i }));
    }
    fileResults.forEach((_, i) => items.push({ type: 'file', index: i }));
    return items;
  }, [showRecent, recentCommands, commandResults, settingsResults, fileResults]);

  const totalResults = allItems.length;

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleAction = useCallback((index: number) => {
    const item = allItems[index];
    if (!item) return;
    if (item.type === 'recent') {
      const cmd = recentCommands[item.index];
      if (cmd) { pushRecent(cmd.id); cmd.action(); onClose(); }
    } else if (item.type === 'command') {
      const r = commandResults[item.index];
      if (r) { pushRecent(r.cmd.id); r.cmd.action(); onClose(); }
    } else if (item.type === 'setting') {
      const r = settingsResults[item.index];
      if (r) { pushRecent(r.cmd.id); r.cmd.action(); onClose(); }
    } else if (item.type === 'file') {
      const file = fileResults[item.index];
      if (file && onFileSelect) { onFileSelect(file.path, file.name); onClose(); }
    }
  }, [allItems, recentCommands, commandResults, settingsResults, fileResults, onFileSelect, onClose]);

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

  // Build a running index for highlighting
  let runningIndex = 0;
  const getIndex = () => runningIndex++;

  const hasCommands = commandResults.length > 0;
  const hasSettings = settingsResults.length > 0;
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
            placeholder="Search commands, files, settings..."
            className="flex-1 bg-transparent text-sm outline-none text-ink placeholder:text-muted"
          />
          <kbd className="text-[10px] text-muted bg-hover px-1.5 py-0.5 rounded border border-border font-mono">ESC</kbd>
        </div>
        <div className="max-h-[360px] overflow-y-auto py-1 terminal-scroll">
          {/* D36: Recent commands section (when no query) */}
          {showRecent && (
            <>
              <div className="px-4 py-1.5 text-[10px] font-semibold text-muted uppercase tracking-wider flex items-center gap-1.5">
                <Clock size={10} /> Recent
              </div>
              {recentCommands.map((cmd, i) => {
                const idx = getIndex();
                const Icon = cmd.icon;
                return (
                  <button
                    key={`recent-${cmd.id}`}
                    onClick={() => handleAction(idx)}
                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                      idx === selectedIndex ? 'bg-primary/10 text-primary' : 'text-ink hover:bg-hover'
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

          {/* Commands section */}
          {hasCommands && (
            <>
              <div className="px-4 py-1.5 text-[10px] font-semibold text-muted uppercase tracking-wider">
                Commands
              </div>
              {commandResults.map((r, _i) => {
                const idx = getIndex();
                const Icon = r.cmd.icon;
                return (
                  <button
                    key={r.cmd.id}
                    onClick={() => handleAction(idx)}
                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                      idx === selectedIndex ? 'bg-primary/10 text-primary' : 'text-ink hover:bg-hover'
                    }`}
                  >
                    <Icon size={16} />
                    <span className="flex-1 text-left">
                      {query.trim() ? <HighlightedText text={r.cmd.label} indices={r.indices} /> : r.cmd.label}
                    </span>
                    {r.cmd.shortcut && (
                      <kbd className="text-[10px] text-muted bg-hover px-1.5 py-0.5 rounded border border-border font-mono">{r.cmd.shortcut}</kbd>
                    )}
                  </button>
                );
              })}
            </>
          )}

          {/* D36: Settings results section */}
          {hasSettings && (
            <>
              <div className="px-4 py-1.5 text-[10px] font-semibold text-muted uppercase tracking-wider mt-1">
                Settings
              </div>
              {settingsResults.map((r, _i) => {
                const idx = getIndex();
                const Icon = r.cmd.icon;
                return (
                  <button
                    key={`setting-${r.cmd.id}`}
                    onClick={() => handleAction(idx)}
                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                      idx === selectedIndex ? 'bg-primary/10 text-primary' : 'text-ink hover:bg-hover'
                    }`}
                  >
                    <Icon size={16} />
                    <span className="flex-1 text-left">
                      <HighlightedText text={r.cmd.label} indices={r.indices} />
                    </span>
                    {r.cmd.shortcut && (
                      <kbd className="text-[10px] text-muted bg-hover px-1.5 py-0.5 rounded border border-border font-mono">{r.cmd.shortcut}</kbd>
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
              {fileResults.map((file, _i) => {
                const idx = getIndex();
                const IconComponent = file.type === 'directory'
                  ? Folder
                  : getFileIconComponent(file.name);
                return (
                  <button
                    key={`file-${file.path}`}
                    onClick={() => handleAction(idx)}
                    className={`w-full flex items-center gap-3 px-4 py-2 text-sm transition-colors ${
                      idx === selectedIndex ? 'bg-primary/10 text-primary' : 'text-ink hover:bg-hover'
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
