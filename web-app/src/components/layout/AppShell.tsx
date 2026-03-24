import { useState, useEffect, useRef, useCallback } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Clock, ChevronDown } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { OnboardingOverlay } from '../OnboardingOverlay';
import { AnnouncementBanner } from '../AnnouncementBanner';
import { api } from '../../api/client';
import { useWebSocket } from '../../hooks/useWebSocket';

const RECENT_PROJECTS_KEY = 'pl_recent_projects';
const MAX_RECENT_PROJECTS = 5;

function getRecentProjects(): { id: string; label: string }[] {
  try {
    const raw = localStorage.getItem(RECENT_PROJECTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function pushRecentProject(id: string, label: string) {
  try {
    const list = getRecentProjects().filter(p => p.id !== id);
    list.unshift({ id, label });
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(list.slice(0, MAX_RECENT_PROJECTS)));
  } catch {
    // ignore
  }
}

export function AppShell() {
  const [version, setVersion] = useState('');
  const location = useLocation();
  const navigate = useNavigate();
  const mainRef = useRef<HTMLElement>(null);
  const [headerScrolled, setHeaderScrolled] = useState(false);

  // D42: Recent projects dropdown
  const [recentOpen, setRecentOpen] = useState(false);
  const [recentProjects, setRecentProjects] = useState<{ id: string; label: string }[]>([]);
  const recentRef = useRef<HTMLDivElement>(null);

  const { connected } = useWebSocket(() => {});

  useEffect(() => {
    api.getStatus().then(s => {
      setVersion(s.version || '');
    }).catch(() => {});
  }, []);

  // D42: Refresh recent projects list when navigating to a project
  useEffect(() => {
    const match = location.pathname.match(/^\/project\/(.+)$/);
    if (match) {
      const sessionId = match[1];
      api.getSessionDetail(sessionId)
        .then(s => {
          pushRecentProject(s.id, s.prd?.slice(0, 50) || s.id);
          setRecentProjects(getRecentProjects());
        })
        .catch(() => {});
    }
    setRecentProjects(getRecentProjects());
  }, [location.pathname]);

  // D42: Close recent dropdown on outside click
  useEffect(() => {
    if (!recentOpen) return;
    const handler = (e: MouseEvent) => {
      if (recentRef.current && !recentRef.current.contains(e.target as Node)) {
        setRecentOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [recentOpen]);

  // D44: Track scroll for sticky header shadow
  const handleScroll = useCallback(() => {
    if (mainRef.current) {
      setHeaderScrolled(mainRef.current.scrollTop > 8);
    }
  }, []);

  useEffect(() => {
    const el = mainRef.current;
    if (el) {
      el.addEventListener('scroll', handleScroll, { passive: true });
      return () => el.removeEventListener('scroll', handleScroll);
    }
  }, [handleScroll]);

  return (
    <div className="flex h-screen bg-[#FAF9F6]">
      <OnboardingOverlay />
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:top-2 focus:left-2 focus:px-4 focus:py-2 focus:bg-white focus:text-[#553DE9] focus:rounded-[3px] focus:shadow-card"
      >
        Skip to main content
      </a>
      <Sidebar wsConnected={connected} version={version} />
      <div className="flex-1 flex flex-col min-w-0">
        {/* D56: Announcement banner */}
        <AnnouncementBanner
          id="v6-launch"
          message="Purple Lab v6 is here -- autonomous builds, multi-provider support, and more."
          linkText="See changelog"
          linkHref="https://www.autonomi.dev/changelog"
          variant="update"
        />

        {/* D44: Sticky header with shadow on scroll + D42: Recent projects */}
        <header
          className={`sticky-header bg-[#FAF9F6] border-b border-[#ECEAE3] px-6 py-2 flex items-center gap-4 ${
            headerScrolled ? 'sticky-header-scrolled' : ''
          }`}
        >
          <div className="flex-1" />
          {/* D42: Recent projects dropdown */}
          {recentProjects.length > 0 && (
            <div className="relative" ref={recentRef}>
              <button
                type="button"
                onClick={() => setRecentOpen(!recentOpen)}
                className="flex items-center gap-1.5 text-xs text-[#6B6960] hover:text-[#36342E] transition-colors px-2 py-1 rounded hover:bg-[#F8F4F0]"
              >
                <Clock size={13} />
                <span>Recent</span>
                <ChevronDown size={12} className={`transition-transform ${recentOpen ? 'rotate-180' : ''}`} />
              </button>
              {recentOpen && (
                <div className="absolute right-0 top-full mt-1 w-64 bg-white border border-[#ECEAE3] rounded-lg shadow-lg py-1 z-50">
                  <div className="px-3 py-1.5 text-[10px] font-semibold text-[#939084] uppercase tracking-wider">
                    Recent Projects
                  </div>
                  {recentProjects.map(p => (
                    <button
                      key={p.id}
                      onClick={() => { setRecentOpen(false); navigate(`/project/${p.id}`); }}
                      className="w-full text-left px-3 py-2 text-xs text-[#36342E] hover:bg-[#F8F4F0] transition-colors truncate"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </header>

        {/* D43: Page content with fade-in on route change */}
        <main
          id="main-content"
          ref={mainRef}
          className="flex-1 overflow-auto"
        >
          <div key={location.pathname} className="page-enter">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
