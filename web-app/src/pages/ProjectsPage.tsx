import { useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Plus, Trash2 } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { api } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import type { SessionHistoryItem } from '../api/client';

type FilterTab = 'all' | 'running' | 'completed' | 'failed';

function statusToBadge(status: string): 'completed' | 'running' | 'failed' | 'started' | 'empty' {
  const normalized = normalizeStatus(status);
  if (normalized === 'completed') return 'completed';
  if (normalized === 'running') return 'running';
  if (normalized === 'failed') return 'failed';
  if (normalized === 'started') return 'started';
  return 'empty';
}

const STATUS_LABELS: Record<string, string> = {
  completed: 'Completed',
  complete: 'Completed',
  done: 'Completed',
  completion_promise_fulfilled: 'Completed',
  running: 'Running',
  in_progress: 'Running',
  planning: 'Planning',
  started: 'Started',
  error: 'Failed',
  failed: 'Failed',
  empty: 'Empty',
};

function normalizeStatus(s: string): string {
  const map: Record<string, string> = {
    completion_promise_fulfilled: 'completed',
    complete: 'completed',
    done: 'completed',
    in_progress: 'running',
    planning: 'running',
    error: 'failed',
  };
  return map[s] || s;
}

const FILTER_TABS: { key: FilterTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'running', label: 'Running' },
  { key: 'completed', label: 'Completed' },
  { key: 'failed', label: 'Failed' },
];

export default function ProjectsPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterTab>('all');
  const [deleteTarget, setDeleteTarget] = useState<SessionHistoryItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [notification, setNotification] = useState<string | null>(null);

  const fetchSessions = useCallback(() => api.getSessionsHistory(), []);
  const { data: sessions, refresh } = usePolling(fetchSessions, 15000, true);

  const filtered = useMemo(() => {
    if (!sessions) return [];
    let list = sessions;
    if (filter !== 'all') {
      list = list.filter((s) => s.status === filter);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((s) => s.prd_snippet.toLowerCase().includes(q));
    }
    return list;
  }, [sessions, filter, search]);

  const handleDeleteClick = (e: React.MouseEvent, session: SessionHistoryItem) => {
    e.stopPropagation();
    setDeleteTarget(session);
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteSession(deleteTarget.id);
      setDeleteTarget(null);
      setNotification('Project deleted');
      setTimeout(() => setNotification(null), 3000);
      refresh();
    } catch (err) {
      setNotification(`Delete failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      setTimeout(() => setNotification(null), 5000);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="max-w-[1400px] mx-auto px-6 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-heading text-h1 text-[#36342E]">Projects</h1>
        <Button icon={Plus} onClick={() => navigate('/')}>
          New Project
        </Button>
      </div>

      {/* Search + Filters */}
      <div className="flex items-center gap-4 mb-6">
        <div className="relative flex-1 max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#6B6960]" />
          <input
            type="text"
            placeholder="Search projects..."
            aria-label="Search projects"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm border border-[#ECEAE3] rounded-[5px] bg-white text-[#36342E] placeholder:text-[#939084] focus:outline-none focus:ring-2 focus:ring-[#553DE9]/20 focus:border-[#553DE9]"
          />
        </div>
        <div className="flex items-center gap-1" role="tablist">
          {FILTER_TABS.map((tab) => (
            <button
              key={tab.key}
              role="tab"
              aria-selected={filter === tab.key}
              onClick={() => setFilter(tab.key)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-[3px] transition-colors ${
                filter === tab.key
                  ? 'bg-[#553DE9] text-white'
                  : 'text-[#6B6960] hover:text-[#36342E] hover:bg-[#F8F4F0]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <p className="text-[#6B6960] text-sm mb-4">No projects yet. Start building.</p>
          <Button icon={Plus} onClick={() => navigate('/')}>
            New Project
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((session) => (
            <ProjectCard
              key={session.id}
              session={session}
              onClick={() => navigate(`/project/${session.id}`)}
              onDelete={(e) => handleDeleteClick(e, session)}
            />
          ))}
        </div>
      )}

      {/* Delete confirmation dialog */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
            <h2 className="text-base font-semibold text-[#36342E] mb-2">
              Delete {deleteTarget.prd_snippet || 'Untitled project'}?
            </h2>
            <p className="text-sm text-[#6B6960] mb-6">
              This will remove all files, dependencies, and state. This cannot be undone.
            </p>
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="px-4 py-2 text-sm font-medium text-[#6B6960] hover:text-[#36342E] rounded-[5px] hover:bg-[#F8F4F0] transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteConfirm}
                disabled={deleting}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-[5px] transition-colors disabled:opacity-50"
              >
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Notification toast */}
      {notification && (
        <div className="fixed bottom-6 right-6 z-50 px-4 py-3 bg-[#36342E] text-white text-sm rounded-[5px] shadow-lg">
          {notification}
        </div>
      )}
    </div>
  );
}

function ProjectCard({
  session,
  onClick,
  onDelete,
}: {
  session: SessionHistoryItem;
  onClick: () => void;
  onDelete: (e: React.MouseEvent) => void;
}) {
  const dateStr = new Date(session.date).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <Card hover onClick={onClick} className="group relative">
      <button
        onClick={onDelete}
        aria-label="Delete project"
        className="absolute top-3 right-3 p-1.5 rounded-[3px] text-[#939084] opacity-0 group-hover:opacity-100 hover:text-red-600 hover:bg-red-50 transition-all z-10"
      >
        <Trash2 size={14} />
      </button>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-[#6B6960]">{dateStr}</span>
        <Badge status={statusToBadge(session.status)}>{STATUS_LABELS[session.status] || session.status}</Badge>
      </div>
      <h3 className="text-sm font-medium text-[#36342E] line-clamp-2 mb-2">
        {session.prd_snippet || 'Untitled project'}
      </h3>
      <p className="text-xs text-[#6B6960] truncate">{session.path}</p>
    </Card>
  );
}
