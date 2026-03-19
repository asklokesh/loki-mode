import { useState, useCallback } from 'react';
import type { FileNode } from '../types/api';
import { api } from '../api/client';

interface FileBrowserProps {
  files: FileNode[] | null;
  loading: boolean;
}

const FILE_TYPE_COLORS: Record<string, string> = {
  '.py': 'bg-success',
  '.ts': 'bg-primary',
  '.tsx': 'bg-primary',
  '.md': 'bg-warning',
  '.sh': 'bg-accent-product',
};

function getFileColor(name: string): string {
  const ext = name.substring(name.lastIndexOf('.'));
  return FILE_TYPE_COLORS[ext] || 'bg-slate';
}

function formatSize(bytes?: number): string {
  if (bytes === undefined || bytes === null) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

const LAZY_CHUNK_SIZE = 100;

function TreeNode({
  node,
  depth,
  onSelectFile,
  selectedPath,
}: {
  node: FileNode;
  depth: number;
  onSelectFile: (path: string) => void;
  selectedPath: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [visibleCount, setVisibleCount] = useState(LAZY_CHUNK_SIZE);
  const isDir = node.type === 'directory';
  const isSelected = node.path === selectedPath;
  const children = isDir && expanded ? node.children ?? [] : [];
  const hasMore = children.length > visibleCount;

  return (
    <div>
      <button
        type="button"
        className={`w-full flex items-center gap-2 px-2 py-1 rounded-lg text-left text-sm transition-colors hover:bg-white/30 ${
          isSelected ? 'bg-primary/10 text-primary' : 'text-charcoal'
        }`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => {
          if (isDir) {
            setExpanded(!expanded);
            if (expanded) setVisibleCount(LAZY_CHUNK_SIZE);
          } else {
            onSelectFile(node.path);
          }
        }}
      >
        {isDir ? (
          <span className="font-mono text-xs text-slate w-3 flex-shrink-0">
            {expanded ? 'v' : '>'}
          </span>
        ) : (
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${getFileColor(node.name)}`} />
        )}
        <span className={`truncate ${isDir ? 'font-medium' : 'font-mono text-xs'}`}>
          {node.name}
        </span>
        {!isDir && node.size !== undefined && (
          <span className="ml-auto text-[10px] font-mono text-slate/60 flex-shrink-0">
            {formatSize(node.size)}
          </span>
        )}
      </button>
      {children.length > 0 && (
        <div>
          {children.slice(0, visibleCount).map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              onSelectFile={onSelectFile}
              selectedPath={selectedPath}
            />
          ))}
          {hasMore && (
            <button
              type="button"
              className="w-full text-left text-xs text-primary hover:text-primary/80 py-1 transition-colors"
              style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
              onClick={() => setVisibleCount((c) => c + LAZY_CHUNK_SIZE)}
            >
              Show more ({children.length - visibleCount} remaining)
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function FileBrowser({ files, loading }: FileBrowserProps) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);

  const loadFileContent = useCallback(async (path: string) => {
    // Clear stale content immediately so a re-click on the same file
    // never shows the previous (possibly outdated) preview.
    setFileContent(null);
    setSelectedPath(path);
    setContentLoading(true);
    setContentError(null);
    try {
      const result = await api.getFileContent(path);
      setFileContent(result.content);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      const isNetwork = err instanceof TypeError || message === 'Request timeout';
      const is404 = message.includes('404') || message.includes('not found') || message.includes('Not found');
      const label = isNetwork
        ? 'Network error - server may be unreachable'
        : is404
          ? 'File not found - it may have been deleted or renamed'
          : message;
      setContentError(label);
      setFileContent(null);
    } finally {
      setContentLoading(false);
    }
  }, []);

  const handleSelectFile = useCallback((path: string) => {
    loadFileContent(path);
  }, [loadFileContent]);

  return (
    <div className="glass p-6 flex flex-col" style={{ minHeight: '300px' }}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-charcoal uppercase tracking-wider">
          File Browser
        </h3>
        <span className="font-mono text-xs text-slate">.loki/</span>
      </div>

      {loading && !files && (
        <div className="text-center py-8 text-slate text-sm">Loading files...</div>
      )}

      {!loading && (!files || files.length === 0) && (
        <div className="text-center py-8">
          <p className="text-slate text-sm">No project files found</p>
          <p className="text-primary-wash text-xs mt-1">Start a session to generate .loki/ state</p>
        </div>
      )}

      {files && files.length > 0 && (
        <div className="flex gap-4 flex-1 min-h-0">
          {/* Tree panel */}
          <div className="w-1/2 overflow-y-auto terminal-scroll pr-2">
            {files.map((node) => (
              <TreeNode
                key={node.path}
                node={node}
                depth={0}
                onSelectFile={handleSelectFile}
                selectedPath={selectedPath}
              />
            ))}
          </div>

          {/* Preview panel */}
          <div className="w-1/2 bg-charcoal/5 rounded-xl p-3 overflow-hidden flex flex-col">
            {!selectedPath && (
              <div className="flex-1 flex items-center justify-center text-slate text-xs">
                Select a file to preview
              </div>
            )}
            {selectedPath && (
              <>
                <div className="text-xs font-mono text-primary mb-2 truncate">
                  {selectedPath}
                </div>
                <div className="flex-1 overflow-y-auto terminal-scroll">
                  {contentLoading ? (
                    <div className="text-slate text-xs">Loading...</div>
                  ) : contentError ? (
                    <div className="flex flex-col items-center justify-center gap-2 py-6">
                      <p className="text-danger text-xs font-medium">Failed to load file</p>
                      <p className="text-slate text-[10px] text-center max-w-[200px] break-words">{contentError}</p>
                      <button
                        type="button"
                        onClick={() => selectedPath && loadFileContent(selectedPath)}
                        className="mt-1 px-3 py-1 text-[10px] font-semibold rounded-lg border border-primary/20 text-primary hover:bg-primary/5 transition-colors"
                      >
                        Retry
                      </button>
                    </div>
                  ) : (
                    <pre className="text-xs font-mono text-charcoal whitespace-pre-wrap break-words leading-relaxed">
                      {fileContent}
                    </pre>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
