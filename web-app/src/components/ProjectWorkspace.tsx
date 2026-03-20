import { useState, useCallback, useEffect, useRef } from 'react';
import Editor from '@monaco-editor/react';
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels';
import { api } from '../api/client';
import type { FileNode } from '../types/api';
import type { SessionDetail } from '../api/client';

interface ProjectWorkspaceProps {
  session: SessionDetail;
  onClose: () => void;
}

function getLanguageClass(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    js: 'text-yellow-600', ts: 'text-blue-500', tsx: 'text-blue-400', jsx: 'text-yellow-500',
    py: 'text-green-600', rb: 'text-red-500', go: 'text-cyan-600',
    html: 'text-orange-500', css: 'text-purple-500', json: 'text-green-500',
    md: 'text-slate', yaml: 'text-green-400', yml: 'text-green-400',
    sh: 'text-green-600', bash: 'text-green-600',
    rs: 'text-orange-600', java: 'text-red-600', kt: 'text-purple-600',
    sql: 'text-blue-600', svg: 'text-orange-400',
  };
  return map[ext] || 'text-charcoal/80';
}

function getFileIcon(name: string, type: string): string {
  if (type === 'directory') return '[ ]';
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const icons: Record<string, string> = {
    js: 'JS', ts: 'TS', tsx: 'TX', jsx: 'JX', py: 'PY', html: '<>', css: '##',
    json: '{}', md: 'MD', yml: 'YL', yaml: 'YL', sh: 'SH', go: 'GO',
    rs: 'RS', rb: 'RB', java: 'JV', kt: 'KT', sql: 'SQ', svg: 'SV',
    png: 'IM', jpg: 'IM', gif: 'IM', ico: 'IC',
  };
  return icons[ext] || '..';
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
  // Handle special filenames
  const lower = filename.toLowerCase();
  if (lower === 'dockerfile') return 'dockerfile';
  if (lower === 'makefile') return 'makefile';
  return map[ext] || 'plaintext';
}

function hasHtmlFile(files: FileNode[]): boolean {
  for (const f of files) {
    if (f.type === 'file' && f.name.endsWith('.html')) return true;
    if (f.children && hasHtmlFile(f.children)) return true;
  }
  return false;
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
  nodes, selectedPath, onSelect, onDelete, depth = 0,
}: {
  nodes: FileNode[]; selectedPath: string | null;
  onSelect: (path: string, name: string) => void;
  onDelete?: (path: string, name: string) => void;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const set = new Set<string>();
    if (depth < 2) nodes.filter(n => n.type === 'directory').forEach(n => set.add(n.path));
    return set;
  });

  return (
    <div>
      {nodes.map((node) => {
        const isDir = node.type === 'directory';
        const isOpen = expanded.has(node.path);
        const isSelected = node.path === selectedPath;
        return (
          <div key={node.path} className="group/file">
            <button
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
                isSelected ? 'bg-accent-product/10 text-accent-product' : 'text-charcoal/70 hover:bg-white/40'
              }`}
              style={{ paddingLeft: `${depth * 14 + 8}px` }}
            >
              {isDir ? (
                <span className="text-[10px] text-slate w-3 text-center flex-shrink-0">{isOpen ? 'v' : '>'}</span>
              ) : (
                <span className="w-3 flex-shrink-0" />
              )}
              <span className={`text-[10px] font-bold w-5 text-center flex-shrink-0 ${isDir ? 'text-accent-product' : getLanguageClass(node.name)}`}>
                {getFileIcon(node.name, node.type)}
              </span>
              <span className="truncate">{node.name}{isDir ? '/' : ''}</span>
              {!isDir && node.size != null && node.size > 0 && (
                <span className="text-[10px] text-slate/40 ml-auto flex-shrink-0">{formatSize(node.size)}</span>
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
                  className="text-[10px] text-slate/30 hover:text-red-500 ml-1 flex-shrink-0 opacity-0 group-hover/file:opacity-100 transition-opacity cursor-pointer"
                  title="Delete file"
                >
                  x
                </span>
              )}
            </button>
            {isDir && isOpen && node.children && (
              <FileTree nodes={node.children} selectedPath={selectedPath} onSelect={onSelect} onDelete={onDelete} depth={depth + 1} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ProjectWorkspace({ session, onClose }: ProjectWorkspaceProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string>('');
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [isModified, setIsModified] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [sessionData, setSessionData] = useState<SessionDetail>(session);
  const editorRef = useRef<unknown>(null);

  const canPreview = hasHtmlFile(sessionData.files);
  const previewUrl = `/api/sessions/${encodeURIComponent(sessionData.id)}/preview/index.html`;

  const refreshSession = useCallback(async () => {
    try {
      const updated = await api.getSessionDetail(sessionData.id);
      setSessionData(updated);
    } catch {
      // ignore refresh errors
    }
  }, [sessionData.id]);

  const handleFileSelect = useCallback(async (path: string, name: string) => {
    // Warn about unsaved changes
    if (isModified) {
      const discard = window.confirm('Unsaved changes. Discard?');
      if (!discard) return;
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
    } catch {
      setFileContent('[Error loading file]');
      setEditorContent('[Error loading file]');
    } finally {
      setFileLoading(false);
    }
  }, [sessionData.id, isModified]);

  const handleSave = useCallback(async () => {
    if (!selectedFile || editorContent === null || !sessionData.id) return;
    setIsSaving(true);
    try {
      await api.saveSessionFile(sessionData.id, selectedFile, editorContent);
      setFileContent(editorContent);
      setIsModified(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      window.alert(`Save failed: ${msg}`);
    } finally {
      setIsSaving(false);
    }
  }, [selectedFile, editorContent, sessionData.id]);

  // Cmd/Ctrl+S keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (isModified && selectedFile) {
          handleSave();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isModified, selectedFile, handleSave]);

  // Auto-select index.html on mount
  useEffect(() => {
    const indexFile = sessionData.files.find(f => f.name === 'index.html' && f.type === 'file');
    if (indexFile) {
      handleFileSelect(indexFile.path, indexFile.name);
      setShowPreview(true);
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

  const handleDeleteFile = useCallback(async (path: string, name: string) => {
    const confirmed = window.confirm(`Delete "${name}"?`);
    if (!confirmed) return;
    try {
      await api.deleteSessionFile(sessionData.id, path);
      // If the deleted file was selected, clear the editor
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

  const fileSize = selectedFile ? findFileSize(sessionData.files, selectedFile) : undefined;
  const fileExt = selectedFileName.split('.').pop()?.toUpperCase() || '';

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="glass px-5 py-3 flex items-center gap-4 flex-shrink-0 border-b border-white/10">
        <button onClick={() => {
          if (isModified) {
            const discard = window.confirm('Unsaved changes. Discard?');
            if (!discard) return;
          }
          onClose();
        }}
          className="text-xs font-medium px-3 py-1.5 rounded-lg border border-white/20 text-slate hover:text-charcoal hover:bg-white/30 transition-colors">
          Back
        </button>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-bold text-charcoal truncate">{sessionData.id}</h2>
          <p className="text-[10px] font-mono text-slate truncate">{sessionData.path}</p>
        </div>
        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
          sessionData.status === 'completed' || sessionData.status === 'completion_promise_fulfilled'
            ? 'bg-success/10 text-success' : 'bg-slate/10 text-slate'
        }`}>{sessionData.status}</span>
        {canPreview && (
          <button onClick={() => setShowPreview(!showPreview)}
            className={`text-xs font-medium px-3 py-1.5 rounded-lg border transition-colors ${
              showPreview ? 'border-accent-product/40 bg-accent-product/10 text-accent-product'
                : 'border-white/20 text-slate hover:text-charcoal hover:bg-white/30'
            }`}>
            {showPreview ? 'Hide Preview' : 'Preview'}
          </button>
        )}
      </div>

      {/* Workspace: file tree | editor | preview */}
      <div className="flex-1 min-h-0">
        <PanelGroup orientation="horizontal" className="h-full">
          {/* Sidebar: file tree */}
          <Panel defaultSize={20} minSize={15}>
            <div className="h-full flex flex-col border-r border-white/10 bg-white/30">
              <div className="px-3 py-2 border-b border-white/10 flex items-center gap-2">
                <span className="text-[10px] text-slate uppercase tracking-wider font-semibold flex-1">Files</span>
                <button
                  onClick={handleCreateFile}
                  title="New File"
                  className="text-[10px] text-slate hover:text-accent-product px-1.5 py-0.5 rounded border border-white/20 hover:border-accent-product/30 transition-colors"
                >
                  + File
                </button>
                <button
                  onClick={handleCreateFolder}
                  title="New Folder"
                  className="text-[10px] text-slate hover:text-accent-product px-1.5 py-0.5 rounded border border-white/20 hover:border-accent-product/30 transition-colors"
                >
                  + Dir
                </button>
              </div>
              <div className="flex-1 overflow-y-auto terminal-scroll">
                {sessionData.files.length > 0 ? (
                  <FileTree
                    nodes={sessionData.files}
                    selectedPath={selectedFile}
                    onSelect={handleFileSelect}
                    onDelete={handleDeleteFile}
                  />
                ) : (
                  <div className="p-4 text-xs text-slate">No files</div>
                )}
              </div>
            </div>
          </Panel>

          <PanelResizeHandle className="w-1 bg-white/10 hover:bg-accent-product/30 transition-colors cursor-col-resize" />

          {/* Editor */}
          <Panel defaultSize={showPreview ? 50 : 80} minSize={25}>
            <div className="h-full flex flex-col min-w-0">
              {selectedFile ? (
                <>
                  <div className="px-4 py-2 border-b border-white/10 flex items-center gap-2 flex-shrink-0 bg-white/20">
                    <span className={`text-[10px] font-bold ${getLanguageClass(selectedFileName)}`}>
                      {getFileIcon(selectedFileName, 'file')}
                    </span>
                    <span className="text-xs font-mono text-charcoal truncate">
                      {selectedFile}
                    </span>
                    {isModified && (
                      <span className="w-2 h-2 rounded-full bg-accent-product flex-shrink-0" title="Unsaved changes" />
                    )}
                    {isSaving && (
                      <span className="text-[10px] text-accent-product animate-pulse flex-shrink-0">Saving...</span>
                    )}
                    <span className="ml-auto text-[10px] text-slate/50 font-mono">
                      {fileSize != null ? formatSize(fileSize) : ''}
                    </span>
                    <span className="text-[10px] text-slate/40 font-mono uppercase">{fileExt}</span>
                    {isModified && (
                      <button
                        onClick={handleSave}
                        className="text-[10px] font-medium px-2 py-0.5 rounded border border-accent-product/40 bg-accent-product/10 text-accent-product hover:bg-accent-product/20 transition-colors"
                      >
                        Save
                      </button>
                    )}
                  </div>
                  <div className="flex-1 min-h-0">
                    {fileLoading ? (
                      <div className="text-slate text-xs animate-pulse p-4">Loading...</div>
                    ) : (
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
                    )}
                  </div>
                </>
              ) : (
                <div className="flex-1 flex items-center justify-center text-slate text-sm">
                  Select a file to view its contents
                </div>
              )}
            </div>
          </Panel>

          {/* Live preview (collapsible) */}
          {showPreview && (
            <>
              <PanelResizeHandle className="w-1 bg-white/10 hover:bg-accent-product/30 transition-colors cursor-col-resize" />
              <Panel defaultSize={30} minSize={20} collapsible>
                <div className="h-full flex flex-col border-l border-white/10">
                  <div className="px-4 py-2 border-b border-white/10 flex items-center gap-2 flex-shrink-0 bg-white/20">
                    <span className="text-xs font-semibold text-charcoal">Live Preview</span>
                    <span className="text-[10px] font-mono text-slate/50 truncate ml-auto">{previewUrl}</span>
                  </div>
                  <div className="flex-1 bg-white">
                    <iframe
                      src={previewUrl}
                      title="Project Preview"
                      className="w-full h-full border-0"
                      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                    />
                  </div>
                </div>
              </Panel>
            </>
          )}
        </PanelGroup>
      </div>
    </div>
  );
}
