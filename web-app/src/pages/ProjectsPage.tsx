import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Plus, MoreVertical, Trash2, FolderOpen, Copy, ExternalLink, XCircle, Star } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { EmptyState } from '../components/EmptyState';
import { api } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import { PageTransition } from '../components/PageTransition';
import { StaggeredList } from '../components/StaggeredList';
import type { SessionHistoryItem } from '../api/client';

type FilterTab = 'all' | 'running' | 'completed' | 'failed' | 'favorites';

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
  { key: 'favorites', label: 'Favorites' },
  { key: 'running', label: 'Running' },
  { key: 'completed', label: 'Completed' },
  { key: 'failed', label: 'Failed' },
];

// D41: Favorites persistence
const FAVORITES_KEY = 'pl_favorite_projects';

function getFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function saveFavorites(favs: Set<string>) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favs]));
  } catch {
    // ignore
  }
}

export default function ProjectsPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterTab>('all');
  const [deleteTarget, setDeleteTarget] = useState<SessionHistoryItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [notification, setNotification] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<Set<string>>(getFavorites);

  const toggleFavorite = (id: string) => {
    setFavorites(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveFavorites(next);
      return next;
    });
  };

  const fetchSessions = useCallback(() => api.getSessionsHistory(), []);
  const { data: sessions, refresh } = usePolling(fetchSessions, 15000, true);

  const filtered = useMemo(() => {
    if (!sessions) return [];
    let list = sessions;

    // D41: Filter favorites
    if (filter === 'favorites') {
      list = list.filter((s) => favorites.has(s.id));
    } else if (filter !== 'all') {
      list = list.filter((s) => normalizeStatus(s.status) === filter);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((s) => s.prd_snippet.toLowerCase().includes(q));
    }
    // Sort favorites to top
    list = [...list].sort((a, b) => {
      const aFav = favorites.has(a.id) ? 0 : 1;
      const bFav = favorites.has(b.id) ? 0 : 1;
      return aFav - bFav;
    });
    return list;
  }, [sessions, filter, search, favorites]);

  const handleCopyPath = (path: string) => {
    navigator.clipboard.writeText(path);
    setNotification('Path copied');
    setTimeout(() => setNotification(null), 2000);
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
    <PageTransition>
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
              className={`px-3 py-1.5 text-xs font-semibold rounded-[3px] transition-colors flex items-center gap-1 ${
                filter === tab.key
                  ? 'bg-[#553DE9] text-white'
                  : 'text-[#6B6960] hover:text-[#36342E] hover:bg-[#F8F4F0]'
              }`}
            >
              {tab.key === 'favorites' && <Star size={11} />}
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      {filtered.length === 0 ? (
        filter === 'favorites' ? (
          <EmptyState
            title="No favorite projects"
            description="Star a project to pin it here for quick access."
            illustration="no-projects"
          />
        ) : (
          <EmptyState
            title="No projects yet"
            description="Start building something amazing."
            illustration="no-projects"
            actionLabel="New Project"
            actionIcon={Plus}
            onAction={() => navigate('/')}
          />
        )
      ) : (
        <StaggeredList
          animation="fade-in-up"
          stagger={50}
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
        >
          {filtered.map((session) => (
            <ProjectCard
              key={session.id}
              session={session}
              isFavorite={favorites.has(session.id)}
              onToggleFavorite={() => toggleFavorite(session.id)}
              onOpen={() => navigate(`/project/${session.id}`)}
              onDelete={() => setDeleteTarget(session)}
              onCopyPath={() => handleCopyPath(session.path)}
            />
          ))}
        </StaggeredList>
      )}

      {/* Delete confirmation dialog */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
            <h2 className="text-base font-semibold text-[#36342E] mb-2">
              Delete {deleteTarget.prd_snippet || 'Untitled project'}?
            </h2>
            <p className="text-sm text-[#6B6960] mb-6">
              This will remove all files, dependencies, and state.
              This cannot be undone.
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
        <div className="fixed bottom-6 right-6 z-50 px-4 py-3 bg-[#36342E] text-white text-sm rounded-[5px] shadow-lg flex items-center gap-2 animate-fade-in-up animation-fill-both">
          {notification}
          <button onClick={() => setNotification(null)} className="text-white/60 hover:text-white">
            <XCircle size={14} />
          </button>
        </div>
      )}
    </div>
    </PageTransition>
  );
}

function ProjectCard({
  session,
  isFavorite,
  onToggleFavorite,
  onOpen,
  onDelete,
  onCopyPath,
}: {
  session: SessionHistoryItem;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  onOpen: () => void;
  onDelete: () => void;
  onCopyPath: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const dateStr = new Date(session.date).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <Card hover onClick={onOpen} className="relative card-lift">
      {/* D41: Favorite star */}
      <button
        onClick={(e) => { e.stopPropagation(); onToggleFavorite(); }}
        className={`absolute top-2.5 left-2.5 z-10 p-1 rounded-[3px] transition-colors ${
          isFavorite
            ? 'text-[#E5A940]'
            : 'text-[#B8B5AD] opacity-0 group-hover:opacity-100 hover:text-[#E5A940]'
        }`}
        title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
      >
        <Star size={14} fill={isFavorite ? 'currentColor' : 'none'} />
      </button>

      {/* 3-dot menu */}
      <div className="absolute top-2.5 right-2.5 z-10" ref={menuRef}>
        <button
          onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
          aria-label="Project options"
          className="p-1 rounded-[3px] text-[#B8B5AD] hover:text-[#36342E] hover:bg-[#F8F4F0] transition-colors"
        >
          <MoreVertical size={16} />
        </button>

        {menuOpen && (
          <div className="absolute right-0 top-8 w-44 bg-white border border-[#ECEAE3] rounded-[5px] shadow-lg py-1 z-20">
            <button
              onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onOpen(); }}
              className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-[#36342E] hover:bg-[#F8F4F0] transition-colors text-left"
            >
              <FolderOpen size={14} className="text-[#6B6960]" />
              Open project
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setMenuOpen(false); window.open(`/project/${session.id}`, '_blank'); }}
              className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-[#36342E] hover:bg-[#F8F4F0] transition-colors text-left"
            >
              <ExternalLink size={14} className="text-[#6B6960]" />
              Open in new tab
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onCopyPath(); }}
              className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-[#36342E] hover:bg-[#F8F4F0] transition-colors text-left"
            >
              <Copy size={14} className="text-[#6B6960]" />
              Copy path
            </button>
            <div className="border-t border-[#ECEAE3] my-1" />
            <button
              onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onDelete(); }}
              className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors text-left"
            >
              <Trash2 size={14} />
              Delete project
            </button>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between mb-2 pr-6 pl-7">
        <span className="text-xs text-[#6B6960]">{dateStr}</span>
        <Badge status={statusToBadge(session.status)}>{STATUS_LABELS[session.status] || session.status}</Badge>
      </div>
      <h3 className="text-sm font-medium text-[#36342E] line-clamp-2 mb-2 pl-7">
        {session.prd_snippet || 'Untitled project'}
      </h3>
      <p className="text-xs text-[#6B6960] truncate pl-7">{session.path}</p>
    </Card>
  );
}
