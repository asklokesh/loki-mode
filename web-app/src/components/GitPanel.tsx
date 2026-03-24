import { useState, useCallback, useEffect } from 'react';
import {
  GitBranch, GitCommit as GitCommitIcon, GitPullRequest,
  ChevronDown, Plus, Upload, RefreshCw,
  FileCode2, FilePlus, Trash2, FileQuestion,
  Check, Clock, AlertCircle,
} from 'lucide-react';
import { api } from '../api/client';
import { Button } from './ui/Button';
import type { GitStatus, GitFileChange, GitCommit, GitBranch as GitBranchType } from '../types/api';

interface GitPanelProps {
  sessionId: string;
}

const STATUS_ICONS: Record<string, React.ReactNode> = {
  modified: <FileCode2 size={13} className="text-yellow-500" />,
  added: <FilePlus size={13} className="text-green-500" />,
  deleted: <Trash2 size={13} className="text-red-400" />,
  renamed: <FileCode2 size={13} className="text-blue-400" />,
  untracked: <FileQuestion size={13} className="text-muted" />,
};

const STATUS_LABELS: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: '?',
};

function CommitItem({ commit }: { commit: GitCommit }) {
  return (
    <div className="px-3 py-2 border-b border-border hover:bg-hover transition-colors">
      <div className="flex items-start gap-2">
        <GitCommitIcon size={14} className="text-primary mt-0.5 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-ink truncate">{commit.message}</p>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[11px] font-mono text-primary/70">{commit.short_hash}</span>
            <span className="text-[11px] text-muted">{commit.author}</span>
            <span className="text-[11px] text-muted ml-auto flex-shrink-0">{commit.date}</span>
          </div>
          {commit.refs.length > 0 && (
            <div className="flex gap-1 mt-1">
              {commit.refs.map((ref, i) => (
                <span key={i} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-mono bg-primary/10 text-primary rounded">
                  <GitBranch size={9} />
                  {ref}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FileChangeItem({ file }: { file: GitFileChange }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 hover:bg-hover transition-colors text-xs">
      {STATUS_ICONS[file.status] || <FileQuestion size={13} />}
      <span className="font-mono text-ink truncate flex-1">{file.path}</span>
      <span className={`font-mono text-[10px] px-1 rounded ${
        file.staged ? 'bg-green-500/10 text-green-500' : 'bg-muted/10 text-muted'
      }`}>
        {STATUS_LABELS[file.status] || '?'}
      </span>
    </div>
  );
}

type GitView = 'changes' | 'history' | 'branches';

export function GitPanel({ sessionId }: GitPanelProps) {
  const [view, setView] = useState<GitView>('changes');
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [branches, setBranches] = useState<GitBranchType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Commit form
  const [commitMsg, setCommitMsg] = useState('');
  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState<string | null>(null);

  // Branch form
  const [showNewBranch, setShowNewBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [creatingBranch, setCreatingBranch] = useState(false);

  // PR form
  const [showPrForm, setShowPrForm] = useState(false);
  const [prTitle, setPrTitle] = useState('');
  const [prBody, setPrBody] = useState('');
  const [creatingPr, setCreatingPr] = useState(false);
  const [prResult, setPrResult] = useState<string | null>(null);

  // Push
  const [pushing, setPushing] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statusData, logData, branchData] = await Promise.all([
        api.git.status(sessionId),
        api.git.log(sessionId),
        api.git.branches(sessionId),
      ]);
      setStatus(statusData);
      setCommits(logData);
      setBranches(branchData);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load git data');
    }
    setLoading(false);
  }, [sessionId]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleCommit = async () => {
    if (!commitMsg.trim() || committing) return;
    setCommitting(true);
    setCommitResult(null);
    try {
      const result = await api.git.commit(sessionId, commitMsg.trim());
      setCommitResult(`Committed: ${result.hash}`);
      setCommitMsg('');
      await refresh();
    } catch (e) {
      setCommitResult(`Error: ${e instanceof Error ? e.message : 'Commit failed'}`);
    }
    setCommitting(false);
  };

  const handleCreateBranch = async () => {
    if (!newBranchName.trim() || creatingBranch) return;
    setCreatingBranch(true);
    try {
      await api.git.createBranch(sessionId, newBranchName.trim());
      setNewBranchName('');
      setShowNewBranch(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Branch creation failed');
    }
    setCreatingBranch(false);
  };

  const handleCheckout = async (branchName: string) => {
    try {
      await api.git.checkoutBranch(sessionId, branchName);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Checkout failed');
    }
  };

  const handlePush = async () => {
    setPushing(true);
    try {
      await api.git.push(sessionId);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Push failed');
    }
    setPushing(false);
  };

  const handleCreatePr = async () => {
    if (!prTitle.trim() || creatingPr) return;
    setCreatingPr(true);
    setPrResult(null);
    try {
      const result = await api.git.pr(sessionId, prTitle.trim(), prBody.trim());
      setPrResult(result.url);
      setPrTitle('');
      setPrBody('');
      setShowPrForm(false);
    } catch (e) {
      setPrResult(`Error: ${e instanceof Error ? e.message : 'PR creation failed'}`);
    }
    setCreatingPr(false);
  };

  const stagedFiles = status?.files.filter(f => f.staged) || [];
  const unstagedFiles = status?.files.filter(f => !f.staged) || [];

  if (loading && !status) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="flex flex-col items-center gap-2">
          <RefreshCw size={20} className="text-muted animate-spin" />
          <span className="text-xs text-muted">Loading git status...</span>
        </div>
      </div>
    );
  }

  if (error && !status) {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <AlertCircle size={32} className="text-muted/40" />
          <p className="text-sm text-muted">{error}</p>
          <p className="text-xs text-muted/60">This project may not be a git repository.</p>
          <Button size="sm" variant="secondary" icon={RefreshCw} onClick={refresh}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-hover flex-shrink-0">
        <GitBranch size={14} className="text-primary" />
        <span className="text-xs font-semibold text-ink">{status?.branch || 'unknown'}</span>
        {status && (status.ahead > 0 || status.behind > 0) && (
          <span className="text-[10px] text-muted font-mono">
            {status.ahead > 0 && `+${status.ahead}`}
            {status.ahead > 0 && status.behind > 0 && ' / '}
            {status.behind > 0 && `-${status.behind}`}
          </span>
        )}
        {status?.clean && (
          <span className="flex items-center gap-0.5 text-[10px] text-green-500">
            <Check size={10} /> Clean
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={refresh}
          className="p-1 text-muted hover:text-ink rounded transition-colors"
          title="Refresh"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Sub-navigation */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border flex-shrink-0">
        {([
          { id: 'changes' as const, label: 'Changes', icon: FileCode2, count: status?.files.length || 0 },
          { id: 'history' as const, label: 'History', icon: Clock },
          { id: 'branches' as const, label: 'Branches', icon: GitBranch, count: branches.length },
        ]).map(tab => (
          <button
            key={tab.id}
            onClick={() => setView(tab.id)}
            className={`flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-btn transition-colors ${
              view === tab.id ? 'bg-primary/10 text-primary' : 'text-muted hover:text-ink'
            }`}
          >
            <tab.icon size={12} />
            {tab.label}
            {tab.count !== undefined && tab.count > 0 && (
              <span className="ml-0.5 px-1 py-0 text-[9px] rounded-full bg-primary/20 text-primary font-mono">{tab.count}</span>
            )}
          </button>
        ))}
      </div>

      {/* Error banner */}
      {error && (
        <div className="px-3 py-2 bg-red-500/5 border-b border-red-500/20 text-xs text-red-400">
          {error}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto terminal-scroll">
        {/* Changes view */}
        {view === 'changes' && (
          <div className="flex flex-col h-full">
            {status?.files.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Check size={28} className="text-green-500/30 mb-2" />
                <p className="text-xs text-muted">Working tree clean</p>
                <p className="text-[11px] text-muted/60 mt-0.5">No changes to commit.</p>
              </div>
            ) : (
              <>
                {/* Staged files */}
                {stagedFiles.length > 0 && (
                  <div>
                    <div className="px-3 py-1.5 text-[10px] font-semibold text-muted uppercase tracking-wider bg-green-500/5 border-b border-border">
                      Staged ({stagedFiles.length})
                    </div>
                    {stagedFiles.map((f, i) => (
                      <FileChangeItem key={`s-${i}`} file={f} />
                    ))}
                  </div>
                )}

                {/* Unstaged files */}
                {unstagedFiles.length > 0 && (
                  <div>
                    <div className="px-3 py-1.5 text-[10px] font-semibold text-muted uppercase tracking-wider bg-yellow-500/5 border-b border-border">
                      Unstaged ({unstagedFiles.length})
                    </div>
                    {unstagedFiles.map((f, i) => (
                      <FileChangeItem key={`u-${i}`} file={f} />
                    ))}
                  </div>
                )}

                {/* Commit form */}
                <div className="mt-auto border-t border-border p-3 space-y-2 flex-shrink-0">
                  <textarea
                    value={commitMsg}
                    onChange={e => setCommitMsg(e.target.value)}
                    placeholder="Commit message..."
                    rows={2}
                    className="w-full px-3 py-1.5 text-xs bg-card border border-border rounded-btn outline-none focus:border-primary transition-colors resize-none font-mono"
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      icon={GitCommitIcon}
                      onClick={handleCommit}
                      disabled={!commitMsg.trim() || committing}
                      loading={committing}
                    >
                      Commit
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={Upload}
                      onClick={handlePush}
                      loading={pushing}
                      disabled={pushing}
                    >
                      Push
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={GitPullRequest}
                      onClick={() => setShowPrForm(!showPrForm)}
                    >
                      PR
                    </Button>
                  </div>
                  {commitResult && (
                    <p className={`text-[11px] font-mono ${commitResult.startsWith('Error') ? 'text-red-400' : 'text-green-500'}`}>
                      {commitResult}
                    </p>
                  )}
                  {prResult && (
                    <p className="text-[11px] font-mono text-primary">
                      {prResult.startsWith('Error') ? (
                        <span className="text-red-400">{prResult}</span>
                      ) : (
                        <a href={prResult} target="_blank" rel="noopener noreferrer" className="underline hover:text-primary/80">
                          {prResult}
                        </a>
                      )}
                    </p>
                  )}
                </div>

                {/* PR form */}
                {showPrForm && (
                  <div className="border-t border-border p-3 space-y-2 flex-shrink-0 bg-hover">
                    <p className="text-[11px] font-semibold text-ink">Create Pull Request</p>
                    <input
                      value={prTitle}
                      onChange={e => setPrTitle(e.target.value)}
                      placeholder="PR title..."
                      className="w-full px-3 py-1.5 text-xs bg-card border border-border rounded-btn outline-none focus:border-primary"
                    />
                    <textarea
                      value={prBody}
                      onChange={e => setPrBody(e.target.value)}
                      placeholder="PR description (optional)..."
                      rows={3}
                      className="w-full px-3 py-1.5 text-xs bg-card border border-border rounded-btn outline-none focus:border-primary resize-none"
                    />
                    <div className="flex gap-2">
                      <Button size="sm" icon={GitPullRequest} onClick={handleCreatePr} disabled={!prTitle.trim() || creatingPr} loading={creatingPr}>
                        Create PR
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setShowPrForm(false)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* History view */}
        {view === 'history' && (
          <div>
            {commits.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Clock size={28} className="text-muted/30 mb-2" />
                <p className="text-xs text-muted">No commits yet</p>
              </div>
            ) : (
              commits.map((c, i) => (
                <CommitItem key={i} commit={c} />
              ))
            )}
          </div>
        )}

        {/* Branches view */}
        {view === 'branches' && (
          <div>
            <div className="px-3 py-2 border-b border-border flex items-center gap-2">
              <button
                onClick={() => setShowNewBranch(!showNewBranch)}
                className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 font-medium"
              >
                <Plus size={12} />
                New Branch
              </button>
            </div>

            {showNewBranch && (
              <div className="px-3 py-2 border-b border-border bg-hover flex items-center gap-2">
                <input
                  value={newBranchName}
                  onChange={e => setNewBranchName(e.target.value)}
                  placeholder="branch-name"
                  className="flex-1 px-2 py-1 text-xs font-mono bg-card border border-border rounded-btn outline-none focus:border-primary"
                  onKeyDown={e => { if (e.key === 'Enter') handleCreateBranch(); }}
                />
                <Button size="sm" onClick={handleCreateBranch} disabled={!newBranchName.trim() || creatingBranch} loading={creatingBranch}>
                  Create
                </Button>
              </div>
            )}

            {branches.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <GitBranch size={28} className="text-muted/30 mb-2" />
                <p className="text-xs text-muted">No branches found</p>
              </div>
            ) : (
              <div>
                {branches.filter(b => !b.remote).map((b, i) => (
                  <button
                    key={`l-${i}`}
                    onClick={() => !b.current && handleCheckout(b.name)}
                    disabled={b.current}
                    className={`w-full text-left flex items-center gap-2 px-3 py-2 text-xs border-b border-border transition-colors ${
                      b.current ? 'bg-primary/5' : 'hover:bg-hover cursor-pointer'
                    }`}
                  >
                    <GitBranch size={13} className={b.current ? 'text-primary' : 'text-muted'} />
                    <span className={`font-mono ${b.current ? 'text-primary font-semibold' : 'text-ink'}`}>
                      {b.name}
                    </span>
                    {b.current && (
                      <span className="ml-auto text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded font-medium">
                        current
                      </span>
                    )}
                  </button>
                ))}

                {branches.filter(b => b.remote).length > 0 && (
                  <>
                    <div className="px-3 py-1.5 text-[10px] font-semibold text-muted uppercase tracking-wider bg-hover border-b border-border">
                      Remote
                    </div>
                    {branches.filter(b => b.remote).map((b, i) => (
                      <div
                        key={`r-${i}`}
                        className="flex items-center gap-2 px-3 py-2 text-xs border-b border-border"
                      >
                        <GitBranch size={13} className="text-muted/60" />
                        <span className="font-mono text-muted">{b.name}</span>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
