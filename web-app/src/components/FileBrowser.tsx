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
  const [expanded, setExpanded] = useState(depth === 0);
  const isDir = node.type === 'directory';
  const isSelected = node.path === selectedPath;

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
      {isDir && expanded && node.children && (
        <div>
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              onSelectFile={onSelectFile}
              selectedPath={selectedPath}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileBrowser({ files, loading }: FileBrowserProps) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);

  const handleSelectFile = useCallback(async (path: string) => {
    setSelectedPath(path);
    setContentLoading(true);
    try {
      const result = await api.getFileContent(path);
      setFileContent(result.content);
    } catch {
      setFileContent('Error loading file content');
    } finally {
      setContentLoading(false);
    }
  }, []);

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
