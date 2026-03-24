import { useState, useEffect, useCallback, useRef } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  Home,
  FolderKanban,
  LayoutTemplate,
  Users,
  Settings2,
  BarChart3,
  Menu,
  X,
} from 'lucide-react';

const NAV_LINKS = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/projects', label: 'Projects', icon: FolderKanban },
  { to: '/templates', label: 'Templates', icon: LayoutTemplate },
  { to: '/teams', label: 'Teams', icon: Users },
  { to: '/settings', label: 'Settings', icon: Settings2 },
  { to: '/metrics', label: 'Metrics', icon: BarChart3 },
];

export function MobileNav() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const navRef = useRef<HTMLDivElement>(null);

  // Close on route change
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  // Prevent body scroll when open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  const linkClasses = useCallback(
    (isActive: boolean) =>
      [
        'flex items-center gap-3 px-4 py-3 text-sm font-medium rounded-lg transition-colors',
        isActive
          ? 'bg-[#553DE9]/10 text-[#553DE9]'
          : 'text-[#36342E] dark:text-[#C5C0B8] hover:bg-[#F8F4F0] dark:hover:bg-[#222228]',
      ].join(' '),
    [],
  );

  return (
    <div className="md:hidden">
      {/* Hamburger button */}
      <button
        type="button"
        aria-label={open ? 'Close navigation' : 'Open navigation'}
        onClick={() => setOpen(!open)}
        className="fixed top-3 left-3 z-[60] inline-flex items-center justify-center w-10 h-10 rounded-lg bg-white dark:bg-[#1A1A1E] border border-[#ECEAE3] dark:border-[#2A2A30] shadow-card text-[#36342E] dark:text-[#E8E6E3] hover:bg-[#F8F4F0] dark:hover:bg-[#222228] transition-colors"
      >
        {open ? <X size={20} /> : <Menu size={20} />}
      </button>

      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-[55] bg-black/40 backdrop-blur-sm"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Slide-in sidebar */}
      <nav
        ref={navRef}
        aria-label="Mobile navigation"
        className={[
          'fixed top-0 left-0 bottom-0 z-[56] w-[280px] bg-white dark:bg-[#1A1A1E] border-r border-[#ECEAE3] dark:border-[#2A2A30] shadow-2xl',
          'transition-transform duration-300 ease-in-out',
          open ? 'translate-x-0' : '-translate-x-full',
        ].join(' ')}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 h-14 border-b border-[#ECEAE3] dark:border-[#2A2A30]">
          <div className="flex flex-col">
            <span className="font-heading text-lg font-bold leading-tight text-[#36342E] dark:text-[#E8E6E3]">
              Purple Lab
            </span>
            <span className="text-xs text-[#6B6960] dark:text-[#8A8880]">Powered by Loki</span>
          </div>
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setOpen(false)}
            className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-[#939084] hover:bg-[#F8F4F0] dark:hover:bg-[#222228] transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Links */}
        <div className="px-3 py-4 flex flex-col gap-1">
          {NAV_LINKS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => linkClasses(isActive)}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
