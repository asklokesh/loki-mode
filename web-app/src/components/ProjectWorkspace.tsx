import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import Editor from '@monaco-editor/react';
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels';
import {
  FileCode2, FileCode, FileType, FileJson, FileText,
  Folder, FolderOpen, File, ChevronDown, ChevronRight,
  X, FilePlus, FolderPlus,
  ArrowLeft as PreviewBack, ArrowRight as PreviewForward,
  RotateCw, ExternalLink,
  Eye, EyeOff, TestTube2, BookOpen, Trash2, Plus,
  Square, Pause, Play,
  Code2, Eye as PreviewIcon, Settings2, KeyRound, FileText as PrdIcon,
  AlertTriangle,
  Server, Package, Terminal, Rocket, GitBranch,
  RefreshCw, PanelLeftClose, PanelLeftOpen, PanelBottomClose, PanelBottomOpen, Maximize2, Minimize2,
  LayoutDashboard,
} from 'lucide-react';
import { api } from '../api/client';
import { useWebSocket } from '../hooks/useWebSocket';
import { IconButton } from './ui/IconButton';
import { Button } from './ui/Button';
import { ContextMenu } from './ui/ContextMenu';
import { ErrorBoundary } from './ErrorBoundary';
import { Skeleton, SkeletonEditor } from './ui/Skeleton';
import { ActivityPanel } from './ActivityPanel';
import { BuildProgressBar } from './BuildProgressBar';
import { useKeyboardShortcuts, KeyboardShortcutsModal, ShortcutsHelpButton } from './KeyboardShortcuts';
import { CommandPalette } from './CommandPalette';
import type { CommandItem } from './CommandPalette';
import type { FileNode } from '../types/api';
import type { SessionDetail } from '../api/client';

interface ProjectWorkspaceProps {
  session: SessionDetail;
  onClose: () => void;
}

function getFileIcon(name: string, type: string, isOpen?: boolean): React.ReactNode {
  if (type === 'directory') return isOpen ? <FolderOpen size={14} /> : <Folder size={14} />;
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const icons: Record<string, React.ReactNode> = {
    js: <FileCode2 size={14} className="text-yellow-600" />,
    ts: <FileCode2 size={14} className="text-blue-500" />,
    tsx: <FileCode2 size={14} className="text-blue-400" />,
    jsx: <FileCode2 size={14} className="text-yellow-500" />,
    py: <FileCode2 size={14} className="text-green-600" />,
    html: <FileCode size={14} className="text-orange-500" />,
    css: <FileType size={14} className="text-purple-500" />,
    json: <FileJson size={14} className="text-green-500" />,
    md: <FileText size={14} className="text-muted" />,
    go: <FileCode2 size={14} className="text-cyan-600" />,
    rs: <FileCode2 size={14} className="text-orange-600" />,
    rb: <FileCode2 size={14} className="text-red-500" />,
    sh: <FileCode2 size={14} className="text-green-600" />,
  };
  return icons[ext] || <File size={14} />;
}

function getMonacoLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    js: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    py: 'python',
    html: 'html', htm: 'html',
    css: 'css', scss: 'scss', less: 'less',
    json: 'json',
    md: 'markdown',
    go: 'go',
    rs: 'rust',
    sh: 'shell', bash: 'shell',
    yml: 'yaml', yaml: 'yaml',
    xml: 'xml', svg: 'xml',
    sql: 'sql',
    java: 'java',
    kt: 'kotlin',
    rb: 'ruby',
    dockerfile: 'dockerfile',
  };
  const lower = filename.toLowerCase();
  if (lower === 'dockerfile') return 'dockerfile';
  if (lower === 'makefile') return 'makefile';
  return map[ext] || 'plaintext';
}

function findFileSize(files: FileNode[], path: string): number | undefined {
  for (const f of files) {
    if (f.path === path) return f.size;
    if (f.children) {
      const found = findFileSize(f.children, path);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FileTree({
  nodes, selectedPath, onSelect, onDelete, onContextMenu, depth = 0,
}: {
  nodes: FileNode[]; selectedPath: string | null;
  onSelect: (path: string, name: string) => void;
  onDelete?: (path: string, name: string) => void;
  onContextMenu?: (e: React.MouseEvent, path: string, name: string, type: string) => void;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const set = new Set<string>();
    if (depth < 2) nodes.filter(n => n.type === 'directory').forEach(n => set.add(n.path));
    return set;
  });

  return (
    <div role={depth === 0 ? 'tree' : 'group'}>
      {nodes.map((node) => {
        const isDir = node.type === 'directory';
        const isOpen = expanded.has(node.path);
        const isSelected = node.path === selectedPath;
        return (
          <div key={node.path} className="group/file">
            <button
              role="treeitem"
              aria-label={node.name}
              aria-selected={isSelected}
              {...(isDir ? { 'aria-expanded': isOpen } : {})}
              onContextMenu={(e) => {
                e.preventDefault();
                onContextMenu?.(e, node.path, node.name, node.type);
              }}
              onClick={() => {
                if (isDir) {
                  setExpanded(prev => {
                    const next = new Set(prev);
                    next.has(node.path) ? next.delete(node.path) : next.add(node.path);
                    return next;
                  });
                } else {
                  onSelect(node.path, node.name);
                }
              }}
              className={`w-full text-left flex items-center gap-1.5 px-2 py-1 text-xs font-mono rounded transition-colors ${
                isSelected ? 'bg-primary/10 text-primary' : 'text-ink/70 hover:bg-hover'
              }`}
              style={{ paddingLeft: `${depth * 14 + 8}px` }}
            >
              {isDir ? (
                <span className="w-3 flex items-center justify-center flex-shrink-0 text-muted">
                  {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </span>
              ) : (
                <span className="w-3 flex-shrink-0" />
              )}
              <span className={`w-5 flex items-center justify-center flex-shrink-0 ${isDir ? 'text-primary' : ''}`}>
                {getFileIcon(node.name, node.type, isOpen)}
              </span>
              <span className="truncate">{node.name}{isDir ? '/' : ''}</span>
              {!isDir && node.size != null && node.size > 0 && (
                <span className="text-xs text-muted ml-auto flex-shrink-0">{formatSize(node.size)}</span>
              )}
              {!isDir && onDelete && (
                <span
                  role="button"
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(node.path, node.name);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.stopPropagation(); onDelete(node.path, node.name); }
                  }}
                  className="text-muted hover:text-danger ml-1 flex-shrink-0 opacity-0 group-hover/file:opacity-100 transition-opacity cursor-pointer"
                  title="Delete file"
                >
                  <X size={12} />
                </span>
              )}
            </button>
            {isDir && isOpen && node.children && (
              <FileTree nodes={node.children} selectedPath={selectedPath} onSelect={onSelect} onDelete={onDelete} onContextMenu={onContextMenu} depth={depth + 1} />
            )}
          </div>
        );
      })}
    </div>
  );
}

interface OpenTab {
  path: string;
  name: string;
  content: string;
  modified: boolean;
}

function flattenFiles(nodes: FileNode[], prefix = ''): { path: string; name: string }[] {
  const result: { path: string; name: string }[] = [];
  for (const n of nodes) {
    if (n.type === 'file') result.push({ path: n.path, name: n.name });
    if (n.children) result.push(...flattenFiles(n.children, n.path + '/'));
  }
  return result;
}

type WorkspaceTab = 'code' | 'preview' | 'config' | 'secrets' | 'prd' | 'dashboard';

function SecretsPanel() {
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showValues, setShowValues] = useState<Set<string>>(new Set());

  const fetchSecrets = useCallback(async () => {
    try {
      const data = await api.getSecrets();
      setSecrets(data);
    } catch {
      // ignore fetch errors
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchSecrets(); }, [fetchSecrets]);

  const handleAdd = async () => {
    const trimmedKey = newKey.trim();
    if (!trimmedKey) return;
    if (!/^[A-Z_][A-Z0-9_]*$/.test(trimmedKey)) {
      setError('Key must be a valid ENV_VAR name (uppercase letters, digits, underscores)');
      return;
    }
    setError(null);
    try {
      await api.setSecret(trimmedKey, newValue);
      setNewKey('');
      setNewValue('');
      await fetchSecrets();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to set secret');
    }
  };

  const handleDelete = async (key: string) => {
    if (!window.confirm(`Delete secret "${key}"?`)) return;
    try {
      await api.deleteSecret(key);
      await fetchSecrets();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete secret');
    }
  };

  const toggleShow = (key: string) => {
    setShowValues(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const secretKeys = Object.keys(secrets);

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton variant="text" width="180px" height="16px" />
        <Skeleton variant="block" width="100%" height="60px" />
        <Skeleton variant="block" width="100%" height="80px" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="p-6 overflow-y-auto">
        <h3 className="text-h3 font-heading text-ink mb-2">Environment Secrets</h3>

        {/* Warning banner */}
        <div className="flex items-start gap-2 px-4 py-3 rounded-btn border border-warning/30 bg-warning/5 mb-6">
          <AlertTriangle size={16} className="text-warning flex-shrink-0 mt-0.5" />
          <p className="text-xs text-warning leading-relaxed">
            Secrets are stored locally in plaintext and injected as environment variables during builds.
            They are never committed to the project repository.
          </p>
        </div>

        {/* Existing secrets table */}
        {secretKeys.length > 0 && (
          <div className="card mb-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-4 py-2 text-xs font-semibold text-muted-accessible uppercase tracking-wider">Key</th>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-muted-accessible uppercase tracking-wider">Value</th>
                  <th className="w-20 px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {secretKeys.map(key => (
                  <tr key={key} className="border-b border-border last:border-b-0">
                    <td className="px-4 py-2.5 font-mono text-xs text-ink">{key}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-muted-accessible">
                      <span className="flex items-center gap-2">
                        <span>{showValues.has(key) ? secrets[key] : '***'}</span>
                        <button
                          onClick={() => toggleShow(key)}
                          className="text-muted hover:text-ink transition-colors"
                          title={showValues.has(key) ? 'Hide value' : 'Show value'}
                        >
                          {showValues.has(key) ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        onClick={() => handleDelete(key)}
                        className="text-muted hover:text-danger transition-colors"
                        title="Delete secret"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {secretKeys.length === 0 && (
          <div className="card p-4 mb-6">
            <p className="text-sm text-muted-accessible text-center py-4">
              No secrets configured yet. Add your first secret below.
            </p>
          </div>
        )}

        {/* Add secret form */}
        <div className="card p-4">
          <label className="block text-xs font-semibold text-muted-accessible uppercase tracking-wider mb-3">Add Secret</label>
          {error && (
            <div className="text-xs text-danger mb-3 px-1">{error}</div>
          )}
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="block text-xs text-muted-accessible mb-1">Key</label>
              <input
                type="text"
                value={newKey}
                onChange={e => setNewKey(e.target.value.toUpperCase())}
                placeholder="API_KEY"
                className="w-full px-3 py-2 text-sm font-mono bg-hover border border-border rounded-btn text-ink placeholder:text-muted"
              />
            </div>
            <div className="flex-1">
              <label className="block text-xs text-muted-accessible mb-1">Value</label>
              <input
                type="password"
                value={newValue}
                onChange={e => setNewValue(e.target.value)}
                placeholder="secret value"
                className="w-full px-3 py-2 text-sm font-mono bg-hover border border-border rounded-btn text-ink placeholder:text-muted"
              />
            </div>
            <button
              onClick={handleAdd}
              disabled={!newKey.trim()}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-btn border border-primary bg-primary/10 text-primary hover:bg-primary/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Plus size={14} />
              Add
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ProjectWorkspace({ session, onClose }: ProjectWorkspaceProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string>('');
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [activeWorkspaceTab, setActiveWorkspaceTab] = useState<WorkspaceTab>('code');
  const [isModified, setIsModified] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [sessionData, setSessionData] = useState<SessionDetail>(session);
  const editorRef = useRef<unknown>(null);
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [showQuickOpen, setShowQuickOpen] = useState(false);
  const [quickOpenQuery, setQuickOpenQuery] = useState('');
  const quickOpenRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLIFrameElement>(null);
  const [previewKey, setPreviewKey] = useState(0);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    path: string;
    name: string;
    type: 'file' | 'directory';
  } | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [bottomPanelVisible, setBottomPanelVisible] = useState(true);
  const [zenMode, setZenMode] = useState(false);
  const [dashboardView, setDashboardView] = useState('overview');
  const dashboardPort = 57374;
  const [dashboardAvailable, setDashboardAvailable] = useState<boolean | null>(null);

  const toggleZenMode = useCallback(() => {
    setZenMode(prev => {
      const next = !prev;
      setSidebarVisible(!next);
      setBottomPanelVisible(!next);
      return next;
    });
  }, []);

  const [buildMode, setBuildMode] = useState<'quick' | 'standard' | 'max'>(() => {
    return (sessionStorage.getItem(`pl_buildmode_${sessionData.id}`) as 'quick' | 'standard' | 'max') || 'standard';
  });
  const [selectedProvider, setSelectedProvider] = useState(() => {
    return sessionStorage.getItem(`pl_provider_${sessionData.id}`) || 'claude';
  });
  const [actionOutput, setActionOutput] = useState<string | null>(null);
  const [actionState, setActionState] = useState<{
    type: 'review' | 'test' | 'explain';
    loading: boolean;
    startTime: number;
    elapsed: number;
  } | null>(null);
  const [isBuilding, setIsBuilding] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [buildStatus, setBuildStatus] = useState<{
    phase: string;
    iteration: number;
    maxIterations: number;
    cost: number;
    startTime: number;
  }>({ phase: 'idle', iteration: 0, maxIterations: 10, cost: 0, startTime: 0 });
  const [filesChangedIndicator, setFilesChangedIndicator] = useState(false);
  const [externalChangeFile, setExternalChangeFile] = useState<string | null>(null);
  const filesChangedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  // Subscribe to WebSocket for file_changed events
  const { subscribe } = useWebSocket();

  const refreshSession = useCallback(async () => {
    try {
      const updated = await api.getSessionDetail(sessionData.id);
      setSessionData(updated);
    } catch {
      // ignore refresh errors
    }
  }, [sessionData.id]);

  const handleStop = useCallback(async () => {
    try {
      await api.stopSession();
      setIsBuilding(false);
      setIsPaused(false);
    } catch { /* ignore */ }
  }, []);

  const handlePause = useCallback(async () => {
    try {
      await api.pauseSession();
      setIsPaused(true);
    } catch { /* ignore */ }
  }, []);

  const handleResume = useCallback(async () => {
    try {
      await api.resumeSession();
      setIsPaused(false);
    } catch { /* ignore */ }
  }, []);

  // Poll session status for build controls, provider, and progress
  useEffect(() => {
    const check = async () => {
      try {
        const status = await api.getStatus();
        setIsBuilding(status.running);
        setIsPaused(status.paused);
        if (status.provider) setSelectedProvider(status.provider);
        setBuildStatus({
          phase: status.phase || 'idle',
          iteration: status.iteration || 0,
          maxIterations: status.max_iterations || 10,
          cost: status.cost || 0,
          startTime: status.start_time ? status.start_time * 1000 : 0,
        });
      } catch { /* ignore */ }
    };
    check();
    const interval = setInterval(check, isBuilding ? 3000 : 10000);
    return () => clearInterval(interval);
  }, [isBuilding]);

  // Elapsed time counter for action progress
  useEffect(() => {
    if (!actionState?.loading) return;
    const interval = setInterval(() => {
      setActionState(prev => prev ? { ...prev, elapsed: Math.floor((Date.now() - prev.startTime) / 1000) } : null);
    }, 1000);
    return () => clearInterval(interval);
  }, [actionState?.loading]);

  // Smart preview detection
  const [previewInfo, setPreviewInfo] = useState<{
    type: string;
    preview_url: string | null;
    entry_file: string | null;
    dev_command: string | null;
    port: number | null;
    description: string;
  } | null>(null);

  useEffect(() => {
    api.getPreviewInfo(sessionData.id).then(setPreviewInfo).catch(() => {});
  }, [sessionData.id]);

  // Dev server state
  const [devServer, setDevServer] = useState<{
    running: boolean;
    status: string;
    port: number | null;
    command: string | null;
    url: string | null;
    framework: string | null;
    output: string[];
    portless_url?: string;
    auto_fix_status?: string | null;
    auto_fix_attempts?: number;
  } | null>(null);
  const [devServerStarting, setDevServerStarting] = useState(false);
  const [fixingError, setFixingError] = useState(false);
  const [devServerError, setDevServerError] = useState<string | null>(null);
  const [customDevCommand, setCustomDevCommand] = useState('');

  // File watcher: listen for file_changed WebSocket events
  useEffect(() => {
    const unsub = subscribe('file_changed', (data: unknown) => {
      const payload = data as { paths?: string[]; event_types?: string[] };
      if (!payload.paths || payload.paths.length === 0) return;

      // Show "files changed" indicator briefly
      setFilesChangedIndicator(true);
      if (filesChangedTimerRef.current) clearTimeout(filesChangedTimerRef.current);
      filesChangedTimerRef.current = setTimeout(() => setFilesChangedIndicator(false), 2000);

      // Refresh file tree
      refreshSession();

      // Check if currently open file was changed externally
      if (selectedFile) {
        const changedPaths = payload.paths;
        if (changedPaths.some(p => p === selectedFile || selectedFile.endsWith(p))) {
          setExternalChangeFile(selectedFile);
        }
      }

      // BUG-E2E-003: Refresh iframe on file changes for the preview tab.
      // When dev server is running with HMR (react/vite/next/nuxt), the dev
      // server handles live reload automatically. For non-HMR servers or when
      // no dev server is running, we force an iframe key change to trigger reload.
      if (activeWorkspaceTab === 'preview') {
        const hmrFrameworks = ['react', 'vite', 'next', 'nuxt', 'svelte', 'remix'];
        const hasHMR = devServer?.running && devServer?.framework &&
          hmrFrameworks.some(f => devServer.framework!.toLowerCase().includes(f));
        if (!hasHMR) {
          setPreviewKey(k => k + 1);
        }
      }
    });

    return () => {
      unsub();
      if (filesChangedTimerRef.current) clearTimeout(filesChangedTimerRef.current);
    };
  }, [subscribe, selectedFile, activeWorkspaceTab, devServer?.running, refreshSession]);

  const handleReloadExternalFile = useCallback(async () => {
    if (!externalChangeFile || !sessionData.id) return;
    try {
      const result = await api.getSessionFileContent(sessionData.id, externalChangeFile);
      setFileContent(result.content);
      setEditorContent(result.content);
      setIsModified(false);
      setOpenTabs(prev => prev.map(t =>
        t.path === externalChangeFile ? { ...t, content: result.content, modified: false } : t
      ));
    } catch {
      // ignore reload errors
    }
    setExternalChangeFile(null);
  }, [externalChangeFile, sessionData.id]);

  // Poll dev server status when preview tab is active
  useEffect(() => {
    if (activeWorkspaceTab !== 'preview') return;
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await api.devserver.status(sessionData.id);
        if (!cancelled) setDevServer(status);
      } catch {
        // ignore
      }
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [activeWorkspaceTab, sessionData.id]);

  // Check if Loki Dashboard is available when dashboard tab is active
  useEffect(() => {
    if (activeWorkspaceTab !== 'dashboard') return;
    fetch(`http://127.0.0.1:${dashboardPort}/health`)
      .then(r => setDashboardAvailable(r.ok))
      .catch(() => setDashboardAvailable(false));
  }, [activeWorkspaceTab]);

  // (auto-start moved after handleStartDevServer declaration)

  const handleStartDevServer = useCallback(async (command?: string) => {
    setDevServerStarting(true);
    setDevServerError(null);
    try {
      const result = await api.devserver.start(sessionData.id, command);
      if (result.status === 'error') {
        setDevServerError(result.message || 'Failed to start dev server');
      } else {
        // Refresh status
        const status = await api.devserver.status(sessionData.id);
        setDevServer(status);
      }
    } catch (e) {
      setDevServerError(e instanceof Error ? e.message : 'Failed to start dev server');
    }
    setDevServerStarting(false);
  }, [sessionData.id]);

  // Auto-start dev server when project loads (if not already running)
  const autoStartAttempted = useRef(false);
  useEffect(() => {
    if (autoStartAttempted.current) return;
    if (!previewInfo?.dev_command) return;
    if (devServer?.running || devServer?.status === 'starting') return;
    if (devServerStarting) return;

    autoStartAttempted.current = true;
    handleStartDevServer(previewInfo.dev_command);
  }, [previewInfo?.dev_command, devServer?.running, devServer?.status, devServerStarting, handleStartDevServer]);

  const handleStopDevServer = useCallback(async () => {
    try {
      await api.devserver.stop(sessionData.id);
      const status = await api.devserver.status(sessionData.id);
      setDevServer(status);
    } catch {
      // ignore
    }
  }, [sessionData.id]);

  // Fix dev server error via AI
  const handleFixError = useCallback(async () => {
    setFixingError(true);
    try {
      const result = await api.fixProject(sessionData.id);
      if (result.task_id) {
        // Poll until fix completes, then refresh dev server status
        const maxPolls = 150;
        let pollCount = 0;
        let poll: { complete: boolean };
        do {
          await new Promise(r => setTimeout(r, 2000));
          poll = await api.chatPoll(sessionData.id, result.task_id);
          pollCount++;
        } while (!poll.complete && pollCount < maxPolls);
        // Refresh dev server status after fix
        const status = await api.devserver.status(sessionData.id);
        setDevServer(status);
      }
    } catch (e) {
      setDevServerError(e instanceof Error ? e.message : 'Fix failed');
    }
    setFixingError(false);
  }, [sessionData.id]);

  // Determine preview URL: point iframe directly to dev server (avoids proxy path issues with asset URLs)
  const devServerProxyUrl = devServer?.running && devServer?.port
    ? (devServer.framework === 'expo'
        ? `/api/sessions/${encodeURIComponent(sessionData.id)}/expo-qr`
        : (devServer.portless_url || `http://localhost:${devServer.port}/`))
    : null;
  const defaultPreviewUrl = previewInfo?.preview_url || `/api/sessions/${encodeURIComponent(sessionData.id)}/preview/index.html`;
  const effectivePreviewUrl = devServerProxyUrl || defaultPreviewUrl;

  // Preview history state
  const [previewHistory, setPreviewHistory] = useState<string[]>([]);
  const [previewHistoryIndex, setPreviewHistoryIndex] = useState(0);

  // Reset preview history when dev server or previewInfo changes
  useEffect(() => {
    const url = devServerProxyUrl || previewInfo?.preview_url;
    if (url) {
      setPreviewHistory([url]);
      setPreviewHistoryIndex(0);
    }
  }, [devServerProxyUrl, previewInfo?.preview_url]);

  const currentPreviewUrl = previewHistory[previewHistoryIndex] || effectivePreviewUrl;
  const [previewInputUrl, setPreviewInputUrl] = useState(currentPreviewUrl);

  const handleContextMenu = useCallback((e: React.MouseEvent, path: string, name: string, type: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, path, name, type: type as 'file' | 'directory' });
  }, []);

  const handlePreviewBack = useCallback(() => {
    if (previewHistoryIndex > 0) {
      setPreviewHistoryIndex(i => i - 1);
      setPreviewKey(k => k + 1);
    }
  }, [previewHistoryIndex]);

  const handlePreviewForward = useCallback(() => {
    if (previewHistoryIndex < previewHistory.length - 1) {
      setPreviewHistoryIndex(i => i + 1);
      setPreviewKey(k => k + 1);
    }
  }, [previewHistoryIndex, previewHistory.length]);

  const navigatePreview = useCallback((url: string) => {
    // Resolve relative paths against the dev server base URL, not Purple Lab
    let resolvedUrl = url;
    if (url.startsWith('/') && devServerProxyUrl) {
      try {
        const base = new URL(devServerProxyUrl);
        resolvedUrl = `${base.origin}${url}`;
      } catch {
        // If devServerProxyUrl isn't a full URL, try with localhost
        const port = devServer?.port;
        if (port) {
          resolvedUrl = `http://localhost:${port}${url}`;
        }
      }
    }
    setPreviewHistory(prev => [...prev.slice(0, previewHistoryIndex + 1), resolvedUrl]);
    setPreviewHistoryIndex(i => i + 1);
    setPreviewKey(k => k + 1);
  }, [previewHistoryIndex, devServerProxyUrl, devServer?.port]);

  // Sync previewInputUrl when navigating history -- show path only, not full URL
  useEffect(() => {
    try {
      const url = new URL(currentPreviewUrl, window.location.origin);
      setPreviewInputUrl(url.pathname + url.search + url.hash || '/');
    } catch {
      setPreviewInputUrl(currentPreviewUrl);
    }
  }, [currentPreviewUrl]);

  const handleReview = useCallback(async () => {
    setActionState({ type: 'review', loading: true, startTime: Date.now(), elapsed: 0 });
    setActionOutput(null);
    try {
      const result = await api.reviewProject(sessionData.id);
      setActionOutput(result.output);
    } catch (e) {
      setActionOutput(`Error: ${e instanceof Error ? e.message : 'Unknown'}`);
    } finally {
      setActionState(null);
    }
  }, [sessionData.id]);

  const handleTest = useCallback(async () => {
    setActionState({ type: 'test', loading: true, startTime: Date.now(), elapsed: 0 });
    setActionOutput(null);
    try {
      const result = await api.testProject(sessionData.id);
      setActionOutput(result.output);
    } catch (e) {
      setActionOutput(`Error: ${e instanceof Error ? e.message : 'Unknown'}`);
    } finally {
      setActionState(null);
    }
  }, [sessionData.id]);

  const handleExplain = useCallback(async () => {
    setActionState({ type: 'explain', loading: true, startTime: Date.now(), elapsed: 0 });
    setActionOutput(null);
    try {
      const result = await api.explainProject(sessionData.id);
      setActionOutput(result.output);
    } catch (e) {
      setActionOutput(`Error: ${e instanceof Error ? e.message : 'Unknown'}`);
    } finally {
      setActionState(null);
    }
  }, [sessionData.id]);

  const handleDeleteFile = useCallback(async (path: string, name: string) => {
    const confirmed = window.confirm(`Delete "${name}"?`);
    if (!confirmed) return;
    try {
      await api.deleteSessionFile(sessionData.id, path);
      if (selectedFile === path) {
        setSelectedFile(null);
        setSelectedFileName('');
        setFileContent(null);
        setEditorContent(null);
        setIsModified(false);
      }
      await refreshSession();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      window.alert(`Delete failed: ${msg}`);
    }
  }, [sessionData.id, selectedFile, refreshSession]);

  const getContextMenuItems = useCallback((menu: NonNullable<typeof contextMenu>) => {
    if (menu.type === 'file') {
      return [
        { label: 'Review', icon: Eye, onClick: () => { handleReview(); } },
        { label: 'Generate Tests', icon: TestTube2, onClick: () => { handleTest(); } },
        { label: 'Explain', icon: BookOpen, onClick: () => { handleExplain(); } },
        { label: 'Delete', icon: Trash2, onClick: () => { handleDeleteFile(menu.path, menu.name); }, variant: 'danger' as const },
      ];
    }
    return [
      { label: 'Review Project', icon: Eye, onClick: () => { handleReview(); } },
      { label: 'Run Tests', icon: TestTube2, onClick: () => { handleTest(); } },
    ];
  }, [handleReview, handleTest, handleExplain, handleDeleteFile]);

  const handleFileSelect = useCallback(async (path: string, name: string) => {
    // Clear external-change notification when switching files
    setExternalChangeFile(null);

    if (isModified && selectedFile && editorContent !== null) {
      setOpenTabs(prev => prev.map(t =>
        t.path === selectedFile ? { ...t, content: editorContent, modified: true } : t
      ));
    }

    const existingTab = openTabs.find(t => t.path === path);
    if (existingTab) {
      setSelectedFile(path);
      setSelectedFileName(name);
      setFileContent(existingTab.content);
      setEditorContent(existingTab.content);
      setIsModified(existingTab.modified);
      return;
    }

    setSelectedFile(path);
    setSelectedFileName(name);
    setFileLoading(true);
    setIsModified(false);
    try {
      const result = sessionData.id
        ? await api.getSessionFileContent(sessionData.id, path)
        : await api.getFileContent(path);
      setFileContent(result.content);
      setEditorContent(result.content);
      setOpenTabs(prev => [...prev, { path, name, content: result.content, modified: false }]);
    } catch {
      setFileContent('[Error loading file]');
      setEditorContent('[Error loading file]');
    } finally {
      setFileLoading(false);
    }
  }, [sessionData.id, isModified, selectedFile, editorContent, openTabs]);

  const handleSave = useCallback(async () => {
    if (!selectedFile || editorContent === null || !sessionData.id) return;
    setIsSaving(true);
    try {
      await api.saveSessionFile(sessionData.id, selectedFile, editorContent);
      setFileContent(editorContent);
      setIsModified(false);
      setOpenTabs(prev => prev.map(t =>
        t.path === selectedFile ? { ...t, content: editorContent, modified: false } : t
      ));
      const ext = selectedFile.split('.').pop()?.toLowerCase() || '';
      if (['html', 'css', 'js', 'jsx', 'ts', 'tsx'].includes(ext)) {
        setPreviewKey(k => k + 1);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      window.alert(`Save failed: ${msg}`);
    } finally {
      setIsSaving(false);
    }
  }, [selectedFile, editorContent, sessionData.id]);

  const handleCloseTab = useCallback((path: string) => {
    const tab = openTabs.find(t => t.path === path);
    if (tab?.modified) {
      if (!window.confirm('Unsaved changes. Close anyway?')) return;
    }
    setOpenTabs(prev => prev.filter(t => t.path !== path));
    if (selectedFile === path) {
      const remaining = openTabs.filter(t => t.path !== path);
      if (remaining.length > 0) {
        const next = remaining[remaining.length - 1];
        setSelectedFile(next.path);
        setSelectedFileName(next.name);
        setFileContent(next.content);
        setEditorContent(next.content);
        setIsModified(next.modified);
      } else {
        setSelectedFile(null);
        setSelectedFileName('');
        setFileContent(null);
        setEditorContent(null);
        setIsModified(false);
      }
    }
  }, [openTabs, selectedFile]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (isModified && selectedFile) handleSave();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
        e.preventDefault();
        setShowQuickOpen(prev => !prev);
        setQuickOpenQuery('');
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCommandPaletteOpen(v => !v);
      }
      if (e.key === 'Escape' && showQuickOpen) {
        setShowQuickOpen(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isModified, selectedFile, handleSave, showQuickOpen]);

  useEffect(() => {
    if (showQuickOpen && quickOpenRef.current) quickOpenRef.current.focus();
  }, [showQuickOpen]);

  const allFiles = flattenFiles(sessionData.files);
  const filteredFiles = quickOpenQuery
    ? allFiles.filter(f => f.path.toLowerCase().includes(quickOpenQuery.toLowerCase()))
    : allFiles;

  useEffect(() => {
    const indexFile = sessionData.files.find(f => f.name === 'index.html' && f.type === 'file');
    if (indexFile) {
      handleFileSelect(indexFile.path, indexFile.name);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleEditorChange = useCallback((value: string | undefined) => {
    if (value !== undefined) {
      setEditorContent(value);
      setIsModified(value !== fileContent);
    }
  }, [fileContent]);

  const handleEditorMount = useCallback((editor: unknown) => {
    editorRef.current = editor;
  }, []);

  const handleCreateFile = useCallback(async () => {
    const name = window.prompt('New file name (e.g. src/utils.ts):');
    if (!name || !name.trim()) return;
    try {
      await api.createSessionFile(sessionData.id, name.trim());
      await refreshSession();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      window.alert(`Create file failed: ${msg}`);
    }
  }, [sessionData.id, refreshSession]);

  const handleCreateFolder = useCallback(async () => {
    const name = window.prompt('New folder name (e.g. src/components):');
    if (!name || !name.trim()) return;
    try {
      await api.createSessionDirectory(sessionData.id, name.trim());
      await refreshSession();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      window.alert(`Create folder failed: ${msg}`);
    }
  }, [sessionData.id, refreshSession]);

  const fileSize = selectedFile ? findFileSize(sessionData.files, selectedFile) : undefined;
  const fileExt = selectedFileName.split('.').pop()?.toUpperCase() || '';

  const { showHelp, setShowHelp } = useKeyboardShortcuts({
    onToggleBuild: () => {
      if (isBuilding) {
        handleStop();
      }
    },
  });

  const paletteCommands: CommandItem[] = useMemo(() => [
    { id: 'preview', label: 'Open Preview', category: 'command' as const, icon: Eye, action: () => setActiveWorkspaceTab('preview'), shortcut: '' },
    { id: 'code', label: 'Open Code Editor', category: 'command' as const, icon: Code2, action: () => setActiveWorkspaceTab('code') },
    { id: 'terminal', label: 'Open Terminal', category: 'command' as const, icon: Terminal, action: () => setBottomPanelVisible(true) },
    { id: 'dashboard', label: 'Open Dashboard', category: 'command' as const, icon: LayoutDashboard, action: () => setActiveWorkspaceTab('dashboard') },
    { id: 'deploy', label: 'Deploy Project', category: 'command' as const, icon: Rocket, action: () => setActiveWorkspaceTab('deploy' as any) },
    { id: 'git', label: 'Git Status', category: 'command' as const, icon: GitBranch, action: () => setActiveWorkspaceTab('dashboard') },
    { id: 'settings', label: 'Settings / Config', category: 'setting' as const, icon: Settings2, action: () => setActiveWorkspaceTab('config') },
    { id: 'quick-open', label: 'Quick Open File', category: 'file' as const, icon: FileCode2, action: () => { setShowQuickOpen(true); setQuickOpenQuery(''); }, shortcut: 'Cmd+P' },
    { id: 'zen', label: 'Toggle Zen Mode', category: 'setting' as const, icon: Maximize2, action: () => toggleZenMode() },
    { id: 'sidebar', label: 'Toggle File Tree', category: 'setting' as const, icon: PanelLeftClose, action: () => setSidebarVisible(v => !v) },
  ], [setActiveWorkspaceTab, toggleZenMode]);

  // Derive build phase from session status for the progress bar
  const buildPhase = useMemo(() => {
    if (!isBuilding) return 'idle';
    const status = (buildStatus.phase || sessionData.status || '').toLowerCase();
    if (status.includes('plan') || status.includes('bootstrap')) return 'planning';
    if (status.includes('review') || status.includes('council')) return 'reviewing';
    if (status.includes('test') || status.includes('verify')) return 'testing';
    if (status.includes('complete') || status.includes('fulfilled')) return 'complete';
    return 'building';
  }, [isBuilding, buildStatus.phase, sessionData.status]);

  return (
    <div className="flex flex-col h-full relative">
      {/* Header */}
      <div className="bg-card px-3 py-2 flex items-center gap-3 flex-shrink-0 border-b border-border">
        <button onClick={() => {
          if (isModified) {
            const discard = window.confirm('Unsaved changes. Discard?');
            if (!discard) return;
          }
          onClose();
        }}
          className="text-xs font-medium px-3 py-1.5 rounded-btn border border-border text-muted hover:text-ink hover:bg-hover transition-colors">
          Back
        </button>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-bold text-ink truncate">{sessionData.id}</h2>
          <p className="text-xs font-mono text-muted-accessible truncate">{sessionData.path}</p>
        </div>
        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
          sessionData.status === 'completed' || sessionData.status === 'completion_promise_fulfilled'
            ? 'bg-success/10 text-success' : 'bg-muted/10 text-muted'
        }`}>{sessionData.status}</span>

        {/* Layout toggle buttons */}
        <div className="flex items-center gap-0.5 border-l border-border pl-2 ml-1">
          <button
            onClick={() => setSidebarVisible(v => !v)}
            title={sidebarVisible ? 'Hide file tree' : 'Show file tree'}
            className="p-1.5 rounded hover:bg-hover text-muted hover:text-ink transition-colors"
          >
            {sidebarVisible ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
          </button>
          <button
            onClick={() => setBottomPanelVisible(v => !v)}
            title={bottomPanelVisible ? 'Hide terminal/chat' : 'Show terminal/chat'}
            className="p-1.5 rounded hover:bg-hover text-muted hover:text-ink transition-colors"
          >
            {bottomPanelVisible ? <PanelBottomClose size={16} /> : <PanelBottomOpen size={16} />}
          </button>
          <button
            onClick={toggleZenMode}
            title={zenMode ? 'Exit zen mode' : 'Zen mode (hide all panels)'}
            className={`p-1.5 rounded hover:bg-hover transition-colors ${zenMode ? 'text-primary' : 'text-muted hover:text-ink'}`}
          >
            {zenMode ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        </div>

        {/* Start Build button when not building */}
        {!isBuilding && (
          <Button
            variant="primary"
            size="sm"
            icon={Play}
            onClick={async () => {
              try {
                const prd = sessionData.prd || '';
                if (!prd.trim()) {
                  window.alert('No PRD found for this project. Go to Home to start a new build.');
                  return;
                }
                await api.startSession({ prd, provider: selectedProvider, projectDir: sessionData.path });
                setIsBuilding(true);
              } catch (e) {
                window.alert(`Failed to start: ${e instanceof Error ? e.message : 'Unknown error'}`);
              }
            }}
            title="Start build for this project"
          >
            Build
          </Button>
        )}

        {/* Stop/Pause/Resume controls */}
        {isBuilding && (
          <div className="flex items-center gap-1 border-l border-border pl-3 ml-1">
            {isPaused ? (
              <Button variant="ghost" size="sm" icon={Play} onClick={handleResume} title="Resume build">
                Resume
              </Button>
            ) : (
              <Button variant="ghost" size="sm" icon={Pause} onClick={handlePause} title="Pause build">
                Pause
              </Button>
            )}
            <Button variant="danger" size="sm" icon={Square} onClick={handleStop} title="Stop build">
              Stop
            </Button>
          </div>
        )}

        {/* Action buttons */}
        <IconButton icon={Eye} label="Review project" size="sm" onClick={handleReview} disabled={!!actionState?.loading} />
        <IconButton icon={TestTube2} label="Run tests" size="sm" onClick={handleTest} disabled={!!actionState?.loading} />
        <IconButton icon={BookOpen} label="Explain project" size="sm" onClick={handleExplain} disabled={!!actionState?.loading} />
        <ShortcutsHelpButton onClick={() => setShowHelp(true)} />
      </div>

      {/* Build progress bar */}
      <BuildProgressBar
        phase={buildPhase}
        iteration={buildStatus.iteration}
        maxIterations={buildStatus.maxIterations}
        cost={buildStatus.cost}
        startTime={buildStatus.startTime}
        isRunning={isBuilding}
      />

      {/* Workspace: vertical split - top: editor, bottom: activity panel */}
      <div className="flex-1 min-h-0">
        <PanelGroup orientation="vertical">
          <Panel defaultSize={70} minSize={40}>
            {/* Horizontal split: file tree | tabbed content */}
            <PanelGroup orientation="horizontal" className="h-full">
              {/* Sidebar: file tree */}
              {sidebarVisible && (
              <Panel defaultSize={20} minSize={15}>
                <div className="h-full flex flex-col border-r border-border bg-card">
                  <div className="px-3 py-2 border-b border-border flex items-center gap-2">
                    <span className="text-xs text-muted-accessible uppercase tracking-wider font-semibold flex-1">
                      Files
                      {filesChangedIndicator && (
                        <span className="ml-2 text-[10px] font-normal text-primary animate-pulse">
                          changed
                        </span>
                      )}
                    </span>
                    <button
                      onClick={handleCreateFile}
                      title="New File"
                      className="flex items-center gap-1 text-xs text-muted-accessible hover:text-primary px-2.5 py-1 rounded border border-border hover:border-primary/30 transition-colors"
                    >
                      <FilePlus size={12} /> New
                    </button>
                    <button
                      onClick={handleCreateFolder}
                      title="New Folder"
                      className="flex items-center gap-1 text-xs text-muted-accessible hover:text-primary px-2.5 py-1 rounded border border-border hover:border-primary/30 transition-colors"
                    >
                      <FolderPlus size={12} /> New
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto terminal-scroll">
                    {sessionData.files.length > 0 ? (
                      <FileTree
                        nodes={sessionData.files}
                        selectedPath={selectedFile}
                        onSelect={handleFileSelect}
                        onDelete={handleDeleteFile}
                        onContextMenu={handleContextMenu}
                      />
                    ) : (
                      <div className="flex flex-col items-center justify-center p-6 text-center h-full">
                        <FolderOpen size={28} className="text-muted/40 mb-2" />
                        <p className="text-xs text-muted font-medium">No files yet</p>
                        <p className="text-[11px] text-muted/70 mt-0.5">Start a build to generate your project.</p>
                      </div>
                    )}
                  </div>
                </div>
              </Panel>
              )}

              {sidebarVisible && <PanelResizeHandle className="w-1 bg-border hover:bg-primary/30 transition-colors cursor-col-resize" />}

              {/* Main content area with workspace tabs */}
              <Panel defaultSize={80} minSize={40}>
                <div className="h-full flex flex-col min-w-0">
                  {/* Workspace tabs */}
                  <div className="flex items-center border-b border-border bg-hover px-1 flex-shrink-0" role="tablist">
                    {([
                      { id: 'code' as const, label: 'Code', icon: Code2 },
                      { id: 'preview' as const, label: 'Preview', icon: PreviewIcon },
                      { id: 'config' as const, label: 'Config', icon: Settings2 },
                      { id: 'secrets' as const, label: 'Secrets', icon: KeyRound },
                      { id: 'prd' as const, label: 'PRD', icon: PrdIcon },
                      { id: 'dashboard' as const, label: 'Dashboard', icon: LayoutDashboard },
                    ]).map(tab => (
                      <button
                        key={tab.id}
                        role="tab"
                        aria-selected={activeWorkspaceTab === tab.id}
                        onClick={() => setActiveWorkspaceTab(tab.id)}
                        className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium border-b-2 transition-colors ${
                          activeWorkspaceTab === tab.id
                            ? 'border-primary text-primary'
                            : 'border-transparent text-muted hover:text-ink hover:border-border'
                        }`}
                      >
                        <tab.icon size={14} />
                        {tab.label}
                      </button>
                    ))}
                  </div>

                  {/* Tab content */}
                  <div className="flex-1 min-h-0" role="tabpanel">
                    {activeWorkspaceTab === 'code' && (
                      <div className="h-full flex flex-col min-w-0">
                        {/* File tab bar */}
                        {openTabs.length > 0 && (
                          <div className="flex items-center border-b border-border bg-hover overflow-x-auto flex-shrink-0">
                            {openTabs.map(tab => (
                              <button
                                key={tab.path}
                                onClick={() => handleFileSelect(tab.path, tab.name)}
                                className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-mono border-r border-border whitespace-nowrap transition-colors ${
                                  tab.path === selectedFile
                                    ? 'bg-card text-ink'
                                    : 'text-muted hover:text-ink hover:bg-card'
                                }`}
                              >
                                <span className="w-4 flex items-center justify-center">
                                  {getFileIcon(tab.name, 'file')}
                                </span>
                                {tab.name}
                                {tab.modified && <span className="w-1.5 h-1.5 rounded-full bg-primary" />}
                                <span
                                  role="button"
                                  tabIndex={-1}
                                  title="Close tab"
                                  onClick={(e) => { e.stopPropagation(); handleCloseTab(tab.path); }}
                                  onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); handleCloseTab(tab.path); } }}
                                  className="text-muted hover:text-danger ml-1 cursor-pointer"
                                >
                                  <X size={12} />
                                </span>
                              </button>
                            ))}
                          </div>
                        )}

                        {selectedFile ? (
                          <>
                            <div className="px-4 py-1.5 border-b border-border flex items-center gap-2 flex-shrink-0 bg-hover">
                              <span className="text-xs font-mono text-secondary truncate">{selectedFile}</span>
                              {isSaving && (
                                <span className="text-xs text-primary animate-pulse flex-shrink-0">Saving...</span>
                              )}
                              <span className="ml-auto text-xs text-muted/50 font-mono">
                                {fileSize != null ? formatSize(fileSize) : ''}
                              </span>
                              <span className="text-xs text-muted font-mono uppercase">{fileExt}</span>
                              {isModified && (
                                <button
                                  onClick={handleSave}
                                  className="text-xs font-medium px-2 py-0.5 rounded border border-primary/40 bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                                >
                                  Save
                                </button>
                              )}
                            </div>
                            {/* External file change notification */}
                            {externalChangeFile === selectedFile && (
                              <div className="px-4 py-1.5 border-b border-border flex items-center gap-2 flex-shrink-0 bg-warning/10">
                                <RefreshCw size={12} className="text-warning" />
                                <span className="text-xs text-warning font-medium">File changed externally</span>
                                <div className="ml-auto flex items-center gap-1.5">
                                  <button
                                    onClick={handleReloadExternalFile}
                                    className="text-xs font-medium px-2 py-0.5 rounded border border-warning/40 bg-warning/10 text-warning hover:bg-warning/20 transition-colors"
                                  >
                                    Reload
                                  </button>
                                  <button
                                    onClick={() => setExternalChangeFile(null)}
                                    className="text-xs font-medium px-2 py-0.5 rounded border border-border text-muted hover:text-ink hover:bg-hover transition-colors"
                                  >
                                    Dismiss
                                  </button>
                                </div>
                              </div>
                            )}
                            <div className="flex-1 min-h-0">
                              {fileLoading ? (
                                <SkeletonEditor />
                              ) : (
                                <ErrorBoundary name="Editor">
                                <Editor
                                  value={editorContent ?? ''}
                                  language={getMonacoLanguage(selectedFileName)}
                                  theme="vs"
                                  onChange={handleEditorChange}
                                  onMount={handleEditorMount}
                                  options={{
                                    minimap: { enabled: false },
                                    fontSize: 13,
                                    lineNumbers: 'on',
                                    wordWrap: 'on',
                                    scrollBeyondLastLine: false,
                                    automaticLayout: true,
                                    padding: { top: 8 },
                                    renderLineHighlight: 'line',
                                    smoothScrolling: true,
                                    cursorBlinking: 'smooth',
                                    folding: true,
                                    bracketPairColorization: { enabled: true },
                                  }}
                                />
                                </ErrorBoundary>
                              )}
                            </div>
                          </>
                        ) : (
                          <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
                            <FileCode2 size={32} className="text-muted/30 mb-3" />
                            <p className="text-sm text-muted">Select a file to view its contents</p>
                            <p className="text-xs text-muted/60 mt-1">
                              Use the file tree or press <kbd className="px-1.5 py-0.5 text-[10px] font-mono bg-hover border border-border rounded">Cmd+P</kbd> to quick open
                            </p>
                          </div>
                        )}
                      </div>
                    )}

                    {activeWorkspaceTab === 'preview' && (
                      <ErrorBoundary name="Preview">
                      <div className="h-full flex flex-col">
                        {/* Preview toolbar */}
                        <div className="px-3 py-1.5 border-b border-border flex items-center gap-2 bg-hover">
                          {(devServer?.running || previewInfo?.preview_url) ? (
                            <>
                              <IconButton icon={PreviewBack} label="Back" size="sm" onClick={handlePreviewBack} disabled={previewHistoryIndex <= 0} />
                              <IconButton icon={PreviewForward} label="Forward" size="sm" onClick={handlePreviewForward} disabled={previewHistoryIndex >= previewHistory.length - 1} />
                              <IconButton icon={RotateCw} label="Refresh" size="sm" onClick={() => setPreviewKey(k => k + 1)} />
                              <input
                                value={previewInputUrl}
                                onChange={e => setPreviewInputUrl(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') navigatePreview(previewInputUrl); }}
                                className="flex-1 px-3 py-1 text-xs font-mono bg-card border border-border rounded-btn"
                              />
                              <IconButton icon={ExternalLink} label="Open in new tab" size="sm" onClick={() => window.open(currentPreviewUrl, '_blank')} />
                              {devServer?.running && (
                                <button
                                  onClick={handleStopDevServer}
                                  className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded border border-danger/40 bg-danger/10 text-danger hover:bg-danger/20 transition-colors"
                                >
                                  <Square size={12} />
                                  Stop
                                </button>
                              )}
                            </>
                          ) : previewInfo ? (
                            <div className="flex-1 flex items-center gap-2 text-sm text-muted">
                              <span className="font-medium text-ink">{previewInfo.description}</span>
                            </div>
                          ) : (
                            <div className="flex-1 flex items-center text-sm text-muted">
                              Detecting project type...
                            </div>
                          )}
                        </div>

                        {/* Dev server status bar */}
                        {devServer && devServer.status !== 'stopped' && (
                          <div className={`px-3 py-1 border-b flex items-center gap-2 text-xs ${
                            devServer.running ? 'bg-green-50 border-green-200 text-green-700' :
                            devServer.status === 'starting' ? 'bg-yellow-50 border-yellow-200 text-yellow-700' :
                            devServer.status === 'error' ? 'bg-red-50 border-red-200 text-red-700' :
                            'bg-gray-50 border-border text-muted'
                          }`}>
                            <span className={`w-2 h-2 rounded-full ${
                              devServer.running ? 'bg-green-500' :
                              devServer.status === 'starting' ? 'bg-yellow-500 animate-pulse' :
                              devServer.status === 'error' ? 'bg-red-500' :
                              'bg-gray-400'
                            }`} />
                            {devServer.running && devServer.portless_url && (
                              <span>Running at {devServer.portless_url}</span>
                            )}
                            {devServer.running && devServer.port && !devServer.portless_url && (
                              <span>Running on port {devServer.port}</span>
                            )}
                            {devServer.status === 'starting' && (
                              <span>Starting dev server...</span>
                            )}
                            {devServer.status === 'error' && !devServer.auto_fix_status && (
                              <span>Dev server crashed</span>
                            )}
                            {devServer.status === 'error' && devServer.auto_fix_status && (
                              <span>Auto-fixing: {devServer.auto_fix_status}</span>
                            )}
                            {devServer.command && (
                              <span className="text-xs font-mono opacity-60 ml-auto truncate max-w-xs">{devServer.command}</span>
                            )}
                          </div>
                        )}

                        {/* Content: iframe when running, controls when not */}
                        {devServer?.running ? (
                          <div className="flex-1 bg-white">
                            <iframe
                              key={previewKey}
                              ref={previewRef}
                              src={currentPreviewUrl}
                              title="Project Preview"
                              className="w-full h-full border-0"
                              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                            />
                          </div>
                        ) : previewInfo?.preview_url ? (
                          <div className="flex-1 bg-white">
                            <iframe
                              key={previewKey}
                              ref={previewRef}
                              src={currentPreviewUrl}
                              title="Project Preview"
                              className="w-full h-full border-0"
                              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                            />
                          </div>
                        ) : previewInfo ? (
                          <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center">
                            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                              {previewInfo.type === 'api' || previewInfo.type === 'python-api' ? (
                                <Server size={28} className="text-primary" />
                              ) : previewInfo.type === 'library' ? (
                                <Package size={28} className="text-primary" />
                              ) : previewInfo.type === 'go-app' || previewInfo.type === 'rust-app' ? (
                                <Terminal size={28} className="text-primary" />
                              ) : (
                                <FolderOpen size={28} className="text-primary" />
                              )}
                            </div>
                            <div>
                              <h3 className="text-lg font-heading text-ink mb-1">{previewInfo.type.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</h3>
                              <p className="text-sm text-muted">{previewInfo.description}</p>
                            </div>

                            {/* Dev server controls -- always shown so users can start a dev server */}
                            <div className="card p-4 max-w-md w-full space-y-3">
                              {previewInfo.dev_command && (
                                <>
                                  <p className="text-xs font-semibold text-muted-accessible uppercase tracking-wider">Dev Server</p>
                                  <div className="flex items-center gap-2">
                                    <code className="text-sm font-mono text-primary bg-hover px-3 py-2 rounded-btn flex-1 text-left truncate">
                                      {previewInfo.dev_command}
                                    </code>
                                    <button
                                      onClick={() => handleStartDevServer(previewInfo.dev_command || undefined)}
                                      disabled={devServerStarting}
                                      className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-btn bg-primary text-white hover:bg-primary/90 transition-colors disabled:opacity-50"
                                    >
                                      <Play size={12} />
                                      {devServerStarting ? 'Starting...' : 'Start'}
                                    </button>
                                  </div>
                                </>
                              )}

                              {/* Custom command input */}
                              <div className={previewInfo.dev_command ? "pt-2 border-t border-border" : ""}>
                                <p className="text-xs text-muted mb-2">{previewInfo.dev_command ? 'Or use a custom command:' : 'Start a dev server:'}</p>
                                <div className="flex items-center gap-2">
                                  <input
                                    value={customDevCommand}
                                    onChange={e => setCustomDevCommand(e.target.value)}
                                    onKeyDown={e => { if (e.key === 'Enter' && customDevCommand.trim()) handleStartDevServer(customDevCommand.trim()); }}
                                    placeholder="e.g. npm run dev"
                                    className="flex-1 px-3 py-1.5 text-xs font-mono bg-card border border-border rounded-btn"
                                  />
                                  <button
                                    onClick={() => customDevCommand.trim() && handleStartDevServer(customDevCommand.trim())}
                                    disabled={devServerStarting || !customDevCommand.trim()}
                                    className="px-3 py-1.5 text-xs font-medium rounded-btn border border-primary/40 bg-primary/10 text-primary hover:bg-primary/20 transition-colors disabled:opacity-50"
                                  >
                                    Run
                                  </button>
                                </div>
                              </div>
                            </div>

                            {/* Error display */}
                            {devServerError && (
                              <div className="card p-3 max-w-md w-full border-danger/30 bg-danger/5">
                                <p className="text-xs text-danger font-medium mb-1">Dev server error</p>
                                <p className="text-xs text-danger/80">{devServerError}</p>
                              </div>
                            )}

                            {/* Error with output: show crash info, fix button, and restart */}
                            {devServer?.status === 'error' && (
                              <div className="card p-3 max-w-md w-full border-danger/30 bg-danger/5">
                                <div className="flex items-center justify-between mb-2">
                                  <p className="text-xs text-danger font-medium">Dev server crashed</p>
                                  <div className="flex items-center gap-2">
                                    <button
                                      onClick={handleFixError}
                                      disabled={fixingError}
                                      className="text-xs px-2 py-1 rounded border border-primary/40 bg-primary/10 text-primary hover:bg-primary/20 transition-colors disabled:opacity-50"
                                    >
                                      {fixingError ? 'Fixing...' : 'Fix Error'}
                                    </button>
                                    <button
                                      onClick={() => handleStartDevServer(previewInfo.dev_command || customDevCommand || undefined)}
                                      className="text-xs px-2 py-1 rounded border border-danger/40 text-danger hover:bg-danger/10 transition-colors"
                                    >
                                      Restart
                                    </button>
                                  </div>
                                </div>
                                {/* Auto-fix status indicator */}
                                {devServer.auto_fix_status && (
                                  <div className="flex items-center gap-2 mb-2 px-2 py-1 rounded bg-primary/5 border border-primary/20">
                                    <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                                    <span className="text-[11px] text-primary font-medium">
                                      Auto-fix: {devServer.auto_fix_status}
                                    </span>
                                    {devServer.auto_fix_attempts !== undefined && devServer.auto_fix_attempts > 0 && (
                                      <span className="text-[10px] text-muted ml-auto">
                                        Attempt {devServer.auto_fix_attempts}/3
                                      </span>
                                    )}
                                  </div>
                                )}
                                {devServer.output.length > 0 && (
                                  <pre className="text-[11px] font-mono text-danger/70 bg-danger/5 p-2 rounded max-h-32 overflow-y-auto whitespace-pre-wrap">
                                    {devServer.output.slice(-10).join('\n')}
                                  </pre>
                                )}
                              </div>
                            )}

                            {previewInfo.port && !devServer?.running && (
                              <p className="text-xs text-muted">
                                Server will run on port {previewInfo.port}
                              </p>
                            )}
                          </div>
                        ) : (
                          <div className="flex-1 flex items-center justify-center text-muted text-sm">
                            Detecting project type...
                          </div>
                        )}
                      </div>
                      </ErrorBoundary>
                    )}

                    {activeWorkspaceTab === 'config' && (
                      <div className="h-full flex flex-col">
                        <div className="p-6 overflow-y-auto">
                          <h3 className="text-h3 font-heading text-ink mb-4">Project Configuration</h3>
                          <div className="space-y-4">
                            <div className="card p-4">
                              <label className="block text-xs font-semibold text-muted-accessible uppercase tracking-wider mb-2">Provider</label>
                              <p className="text-xs text-muted mb-2">Current session: <span className="font-semibold text-ink capitalize">{selectedProvider}</span></p>
                              <div className="flex gap-2">
                                {['claude', 'codex', 'gemini'].map(p => (
                                  <button
                                    key={p}
                                    onClick={() => {
                                      setSelectedProvider(p);
                                      sessionStorage.setItem(`pl_provider_${sessionData.id}`, p);
                                      api.setProvider(p).catch(() => {});
                                    }}
                                    className={`px-4 py-2 rounded-btn text-sm font-medium border transition-colors capitalize ${
                                      selectedProvider === p
                                        ? 'border-primary bg-primary/10 text-primary'
                                        : 'border-border text-secondary hover:bg-hover'
                                    }`}
                                  >
                                    {p}
                                  </button>
                                ))}
                              </div>
                            </div>
                            <div className="card p-4">
                              <label className="block text-xs font-semibold text-muted-accessible uppercase tracking-wider mb-2">Build Mode</label>
                              <div className="flex gap-2">
                                {(['quick', 'standard', 'max'] as const).map(m => (
                                  <button
                                    key={m}
                                    onClick={() => { setBuildMode(m); sessionStorage.setItem(`pl_buildmode_${sessionData.id}`, m); }}
                                    className={`px-4 py-2 rounded-btn text-sm font-medium border transition-colors capitalize ${
                                      buildMode === m
                                        ? 'border-primary bg-primary/10 text-primary'
                                        : 'border-border text-secondary hover:bg-hover'
                                    }`}
                                  >
                                    {m}
                                  </button>
                                ))}
                              </div>
                            </div>
                            <div className="card p-4">
                              <label className="block text-xs font-semibold text-muted-accessible uppercase tracking-wider mb-2">Project Path</label>
                              <input
                                value={sessionData.path}
                                readOnly
                                className="w-full px-3 py-2 text-sm font-mono bg-hover border border-border rounded-btn text-ink"
                              />
                            </div>
                            <div className="card p-4">
                              <label className="block text-xs font-semibold text-muted-accessible uppercase tracking-wider mb-2">Session ID</label>
                              <input
                                value={sessionData.id}
                                readOnly
                                className="w-full px-3 py-2 text-sm font-mono bg-hover border border-border rounded-btn text-ink"
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {activeWorkspaceTab === 'secrets' && (
                      <SecretsPanel />
                    )}

                    {activeWorkspaceTab === 'prd' && (
                      <div className="h-full flex flex-col">
                        <div className="p-6 overflow-y-auto">
                          <h3 className="text-h3 font-heading text-ink mb-4">Product Requirements</h3>
                          {sessionData.prd ? (
                            <pre className="text-sm font-mono text-ink whitespace-pre-wrap bg-hover border border-border rounded-card p-4 leading-relaxed">
                              {sessionData.prd}
                            </pre>
                          ) : (
                            <div className="text-sm text-muted text-center py-8">
                              No PRD found for this project.
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {activeWorkspaceTab === 'dashboard' && (
                      dashboardAvailable === false ? (
                        <div className="h-full flex flex-col items-center justify-center text-center p-8 gap-4">
                          <LayoutDashboard size={48} className="text-muted/30" />
                          <h3 className="text-lg font-heading font-bold text-ink">Dashboard Not Running</h3>
                          <p className="text-sm text-muted max-w-md">
                            The Loki Dashboard provides task boards, RARV timeline, quality gates, and cost tracking.
                            Start it to see project analytics.
                          </p>
                          <button
                            onClick={async () => {
                              setDashboardAvailable(null);
                              try {
                                const r = await fetch(`http://127.0.0.1:${dashboardPort}/health`);
                                setDashboardAvailable(r.ok);
                              } catch {
                                setDashboardAvailable(false);
                              }
                            }}
                            className="px-4 py-2 text-sm font-medium rounded-btn bg-primary text-white hover:bg-primary-hover"
                          >
                            Check Again
                          </button>
                        </div>
                      ) : (
                        <div className="h-full flex flex-col">
                          {/* Dashboard sub-nav */}
                          <div className="flex items-center gap-1 px-3 py-2 border-b border-border bg-hover flex-shrink-0">
                            {[
                              { id: 'overview', label: 'Overview' },
                              { id: 'tasks', label: 'Tasks' },
                              { id: 'timeline', label: 'RARV Timeline' },
                              { id: 'quality', label: 'Quality' },
                              { id: 'cost', label: 'Cost' },
                            ].map(view => (
                              <button
                                key={view.id}
                                onClick={() => setDashboardView(view.id)}
                                className={`px-3 py-1.5 text-xs font-medium rounded-btn transition-colors ${
                                  dashboardView === view.id ? 'bg-primary/10 text-primary' : 'text-muted hover:text-ink hover:bg-hover'
                                }`}
                              >
                                {view.label}
                              </button>
                            ))}
                            <div className="flex-1" />
                            <a
                              href={`http://127.0.0.1:${dashboardPort}/`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-muted hover:text-primary flex items-center gap-1"
                            >
                              Open full dashboard <ExternalLink size={12} />
                            </a>
                          </div>
                          {/* Embedded iframe */}
                          <iframe
                            src={`http://127.0.0.1:${dashboardPort}/#${dashboardView}`}
                            className="flex-1 w-full border-none"
                            title="Loki Dashboard"
                            sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
                          />
                        </div>
                      )
                    )}
                  </div>
                </div>
              </Panel>
            </PanelGroup>
          </Panel>

          {bottomPanelVisible && <PanelResizeHandle className="h-1 bg-border hover:bg-primary/30 cursor-row-resize" />}

          {bottomPanelVisible && (
            <Panel defaultSize={30} minSize={15} collapsible>
              <ErrorBoundary name="ActivityPanel">
                <ActivityPanel
                  logs={null}
                  logsLoading={false}
                  agents={null}
                  checklist={null}
                  sessionId={session.id}
                  isRunning={sessionData.status === 'running' || sessionData.status === 'in_progress'}
                  buildMode={buildMode}
                />
              </ErrorBoundary>
            </Panel>
          )}
        </PanelGroup>
      </div>

      {/* Action progress indicator */}
      {actionState?.loading && (
        <div className="absolute inset-x-0 bottom-0 z-20 bg-card border-t border-border p-4">
          <div className="flex items-center gap-3">
            <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            <span className="text-sm font-medium text-ink">
              {actionState.type === 'review' ? 'Reviewing project' : actionState.type === 'test' ? 'Generating tests' : 'Analyzing project'}...
            </span>
            <span className="text-xs font-mono text-muted">{actionState.elapsed}s</span>
          </div>
        </div>
      )}

      {/* Action output overlay */}
      {actionOutput && (
        <div className="absolute inset-x-0 bottom-0 z-20 bg-card border-t border-border p-4 max-h-64 overflow-y-auto">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-ink">Action Output</span>
            <IconButton icon={X} label="Close" size="sm" onClick={() => setActionOutput(null)} />
          </div>
          <pre className="text-xs font-mono text-ink whitespace-pre-wrap">{actionOutput}</pre>
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={getContextMenuItems(contextMenu)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Quick Open modal (Cmd+P) */}
      {showQuickOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]" role="dialog" aria-modal="true" aria-label="Quick open file search" onClick={() => setShowQuickOpen(false)}>
          <div className="bg-card rounded-card shadow-2xl border border-border w-full max-w-lg" onClick={e => e.stopPropagation()}>
            <input
              ref={quickOpenRef}
              type="text"
              value={quickOpenQuery}
              onChange={e => setQuickOpenQuery(e.target.value)}
              placeholder="Search files by name..."
              className="w-full px-4 py-3 text-sm font-mono border-b border-border outline-none rounded-t-card bg-transparent"
              onKeyDown={e => {
                if (e.key === 'Enter' && filteredFiles.length > 0) {
                  handleFileSelect(filteredFiles[0].path, filteredFiles[0].name);
                  setShowQuickOpen(false);
                }
                if (e.key === 'Escape') setShowQuickOpen(false);
              }}
            />
            <div className="max-h-64 overflow-y-auto">
              {filteredFiles.slice(0, 20).map(f => (
                <button
                  key={f.path}
                  onClick={() => {
                    handleFileSelect(f.path, f.name);
                    setShowQuickOpen(false);
                  }}
                  className="w-full text-left px-4 py-2 text-xs font-mono hover:bg-primary/5 flex items-center gap-2"
                >
                  <span className="w-5 flex items-center justify-center">
                    {getFileIcon(f.name, 'file')}
                  </span>
                  <span className="text-ink">{f.name}</span>
                  <span className="text-muted ml-auto truncate text-xs">{f.path}</span>
                </button>
              ))}
              {filteredFiles.length === 0 && (
                <div className="px-4 py-3 text-xs text-muted">No matching files</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Keyboard shortcuts modal */}
      <KeyboardShortcutsModal open={showHelp} onClose={() => setShowHelp(false)} />

      {/* Command palette (Cmd+K) */}
      <CommandPalette isOpen={commandPaletteOpen} onClose={() => setCommandPaletteOpen(false)} commands={paletteCommands} />
    </div>
  );
}
