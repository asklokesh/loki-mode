import { useState, useEffect, useRef } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  Home,
  FolderKanban,
  LayoutTemplate,
  Settings2,
  BookOpen,
  PanelLeftClose,
  PanelLeft,
  LogOut,
  Monitor,
  ChevronUp,
  ChevronDown,
  Menu,
  X,
  Moon,
  Sun,
  Users,
  BarChart3,
} from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { useTheme } from '../../hooks/useTheme';

export interface SidebarProps {
  wsConnected: boolean;
  version: string;
}

const LS_KEY = 'pl_sidebar_collapsed';
const LS_SECTIONS_KEY = 'pl_sidebar_sections';

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ size?: number }>;
}

const mainNav: NavItem[] = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/projects', label: 'Projects', icon: FolderKanban },
  { to: '/templates', label: 'Templates', icon: LayoutTemplate },
  { to: '/teams', label: 'Teams', icon: Users },
  { to: '/metrics', label: 'Metrics', icon: BarChart3 },
];
interface NavSection {
  key: string;
  label: string;
  items: NavItem[];
}

const navSections: NavSection[] = [
  {
    key: 'main',
    label: 'Navigation',
    items: [
      { to: '/', label: 'Home', icon: Home },
      { to: '/projects', label: 'Projects', icon: FolderKanban },
      { to: '/templates', label: 'Templates', icon: LayoutTemplate },
      { to: '/teams', label: 'Teams', icon: Users },
    ],
  },
  {
    key: 'system',
    label: 'System',
    items: [
      { to: '/settings', label: 'Settings', icon: Settings2 },
    ],
  },
];

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    typeof window !== 'undefined' ? window.innerWidth < 768 : false
  );
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);
  return isMobile;
}

function getSectionState(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(LS_SECTIONS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function setSectionState(state: Record<string, boolean>) {
  try {
    localStorage.setItem(LS_SECTIONS_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

export function Sidebar({ wsConnected, version }: SidebarProps) {
  const isMobile = useIsMobile();
  const location = useLocation();
  const { theme, toggleTheme } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);

  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(LS_KEY) === '1';
    } catch {
      return false;
    }
  });

  // D38: Section collapse state
  const [sectionCollapsed, setSectionCollapsed] = useState<Record<string, boolean>>(getSectionState);

  const toggleSection = (key: string) => {
    setSectionCollapsed(prev => {
      const next = { ...prev, [key]: !prev[key] };
      setSectionState(next);
      return next;
    });
  };

  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, collapsed ? '1' : '0');
    } catch {
      // ignore
    }
  }, [collapsed]);

  // Close mobile sidebar on navigation
  useEffect(() => {
    if (isMobile) setMobileOpen(false);
  }, [location.pathname, isMobile]);

  // D37: Smooth sidebar collapse/expand animation
  const showLabels = isMobile ? mobileOpen : !collapsed;
  const sidebarWidth = showLabels ? 240 : 64;

  const linkClasses = (isActive: boolean) =>
    [
      'flex items-center gap-3 px-3 py-2 text-sm transition-colors rounded-[5px]',
      !showLabels && 'justify-center',
      isActive
        ? 'bg-[#553DE9]/8 text-[#553DE9] font-medium border-l-2 border-[#553DE9]'
        : 'text-[#36342E] hover:bg-[#F8F4F0]',
    ]
      .filter(Boolean)
      .join(' ');

  const sidebarContent = (
    <aside
      className="flex flex-col h-full border-r border-[#ECEAE3] bg-white transition-[width] duration-200 ease-in-out"
      style={{ width: sidebarWidth, minWidth: sidebarWidth }}
    >
      {/* Logo */}
      <div className="flex items-center justify-between px-4 h-14 border-b border-[#ECEAE3]">
        {showLabels && (
          <div className="flex flex-col">
            <span className="font-heading text-lg font-bold leading-tight text-[#36342E]">
              Purple Lab
            </span>
            <span className="text-xs text-[#6B6960]">Powered by Loki</span>
          </div>
        )}
        {isMobile ? (
          <button
            type="button"
            aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
            title={mobileOpen ? 'Close menu' : 'Open menu'}
            onClick={() => setMobileOpen(!mobileOpen)}
            className="inline-flex items-center justify-center w-7 h-7 rounded-[3px] text-[#939084] hover:bg-[#F8F4F0] transition-colors"
          >
            {mobileOpen ? <X size={16} /> : <Menu size={16} />}
          </button>
        ) : (
          <button
            type="button"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={() => setCollapsed(!collapsed)}
            className="inline-flex items-center justify-center w-7 h-7 rounded-[3px] text-[#939084] hover:bg-[#F8F4F0] transition-colors"
          >
            {collapsed ? <PanelLeft size={16} /> : <PanelLeftClose size={16} />}
          </button>
        )}
      </div>

      {/* Navigation with collapsible section headers (D38) */}
      <nav className="flex-1 px-2 py-3 flex flex-col gap-1 overflow-y-auto" aria-label="Main navigation">
        {navSections.map((section, si) => {
          const isCollapsed = sectionCollapsed[section.key] ?? false;
          return (
            <div key={section.key}>
              {si > 0 && <div className="my-2 border-t border-[#ECEAE3]" />}
              {/* D38: Section header with collapse toggle */}
              {showLabels && (
                <button
                  type="button"
                  onClick={() => toggleSection(section.key)}
                  className="w-full flex items-center justify-between px-3 py-1 mb-1 text-[10px] font-semibold uppercase tracking-wider text-[#939084] hover:text-[#36342E] transition-colors"
                >
                  <span>{section.label}</span>
                  <ChevronDown
                    size={12}
                    className={`transition-transform duration-200 ${isCollapsed ? '-rotate-90' : ''}`}
                  />
                </button>
              )}
              <div className={`sidebar-section-content ${showLabels && isCollapsed ? 'sidebar-section-collapsed' : 'sidebar-section-expanded'}`}>
                {section.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/'}
                    className={({ isActive }) => linkClasses(isActive)}
                    title={!showLabels ? item.label : undefined}
                  >
                    <item.icon size={18} />
                    {showLabels && <span>{item.label}</span>}
                  </NavLink>
                ))}
              </div>
            </div>
          );
        })}
      </nav>

      {/* Bottom section */}
      <div className="px-3 py-3 border-t border-[#ECEAE3] flex flex-col gap-2">
        <UserSection collapsed={!showLabels} />

        {/* Connection status */}
        <div
          className={[
            'flex items-center gap-2 text-xs',
            !showLabels && 'justify-center',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <span
            className={`w-2 h-2 rounded-full flex-shrink-0 ${
              wsConnected ? 'bg-[#1FC5A8]' : 'bg-[#C45B5B]'
            }`}
          />
          {showLabels && (
            <span className="text-[#6B6960]">
              {wsConnected ? 'Connected' : 'Disconnected'}
            </span>
          )}
        </div>

        {/* Version */}
        {showLabels && version && (
          <span className="text-xs text-[#6B6960]">v{version}</span>
        )}

        {/* Dark mode toggle */}
        <button
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
          className={[
            'flex items-center gap-2 text-xs text-[#6B6960] hover:text-[#36342E] transition-colors',
            !showLabels && 'justify-center',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
          {showLabels && <span>{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>}
        </button>

        {/* Docs link */}
        <a
          href="https://www.autonomi.dev/docs"
          target="_blank"
          rel="noopener noreferrer"
          className={[
            'flex items-center gap-2 text-xs text-[#6B6960] hover:text-[#36342E] transition-colors',
            !showLabels && 'justify-center',
          ]
            .filter(Boolean)
            .join(' ')}
          title={!showLabels ? 'Documentation' : undefined}
        >
          <BookOpen size={14} />
          {showLabels && <span>Docs</span>}
        </a>
      </div>
    </aside>
  );

  // On mobile with overlay open, show backdrop
  if (isMobile && mobileOpen) {
    return (
      <>
        <div
          className="fixed inset-0 z-40 bg-ink/20"
          onClick={() => setMobileOpen(false)}
        />
        <div className="fixed inset-y-0 left-0 z-50">
          {sidebarContent}
        </div>
      </>
    );
  }

  return sidebarContent;
}

// ---------------------------------------------------------------------------
// UserSection -- shows authenticated user or "Local Mode" label
// ---------------------------------------------------------------------------

function UserSection({ collapsed }: { collapsed: boolean }) {
  const { user, logout, isLocalMode } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    if (menuOpen) {
      document.addEventListener('mousedown', handleClick);
      return () => document.removeEventListener('mousedown', handleClick);
    }
  }, [menuOpen]);

  // Local mode indicator
  if (isLocalMode || !user) {
    return (
      <div
        className={[
          'flex items-center gap-2 text-xs',
          collapsed && 'justify-center',
        ]
          .filter(Boolean)
          .join(' ')}
        title={collapsed ? 'Local Mode' : undefined}
      >
        <Monitor size={14} className="text-[#939084] flex-shrink-0" />
        {!collapsed && (
          <span className="text-[#939084]">Local Mode</span>
        )}
      </div>
    );
  }

  // Authenticated user
  return (
    <div className="relative" ref={menuRef} data-testid="user-section">
      <button
        type="button"
        onClick={() => setMenuOpen(!menuOpen)}
        className={[
          'flex items-center gap-2 w-full text-left text-xs rounded-[3px] py-1 px-1 hover:bg-[#F8F4F0] transition-colors',
          collapsed && 'justify-center',
        ]
          .filter(Boolean)
          .join(' ')}
        title={collapsed ? user.name || user.email : undefined}
      >
        {user.avatar_url ? (
          <img
            src={user.avatar_url}
            alt=""
            className="w-5 h-5 rounded-full flex-shrink-0"
          />
        ) : (
          <div className="w-5 h-5 rounded-full bg-[#553DE9] flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0">
            {(user.name || user.email || '?')[0].toUpperCase()}
          </div>
        )}
        {!collapsed && (
          <>
            <span className="text-[#36342E] truncate flex-1">
              {user.name || user.email}
            </span>
            <ChevronUp
              size={12}
              className={`text-[#939084] transition-transform ${menuOpen ? '' : 'rotate-180'}`}
            />
          </>
        )}
      </button>

      {/* Dropdown menu */}
      {menuOpen && (
        <div className="absolute bottom-full left-0 mb-1 w-48 bg-white border border-[#ECEAE3] rounded-lg shadow-lg py-1 z-50">
          <div className="px-3 py-2 border-b border-[#ECEAE3]">
            <p className="text-xs font-medium text-[#36342E] truncate">{user.name}</p>
            <p className="text-xs text-[#939084] truncate">{user.email}</p>
          </div>
          <NavLink
            to="/settings"
            onClick={() => setMenuOpen(false)}
            className="flex items-center gap-2 px-3 py-2 text-xs text-[#36342E] hover:bg-[#F8F4F0] transition-colors"
          >
            <Settings2 size={14} />
            Settings
          </NavLink>
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              logout();
            }}
            className="flex items-center gap-2 px-3 py-2 text-xs text-[#C45B5B] hover:bg-[#F8F4F0] transition-colors w-full text-left"
          >
            <LogOut size={14} />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
