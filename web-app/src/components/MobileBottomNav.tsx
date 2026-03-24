import { NavLink, useLocation } from 'react-router-dom';
import {
  Home,
  FolderKanban,
  Hammer,
  MessageSquare,
  Settings2,
} from 'lucide-react';

const BOTTOM_ITEMS = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/projects', label: 'Projects', icon: FolderKanban },
  { to: '/?build=1', label: 'Build', icon: Hammer, exact: false },
  { to: '/teams', label: 'Chat', icon: MessageSquare },
  { to: '/settings', label: 'Settings', icon: Settings2 },
];

export function MobileBottomNav() {
  const location = useLocation();

  return (
    <nav
      aria-label="Mobile bottom navigation"
      className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-white dark:bg-[#1A1A1E] border-t border-[#ECEAE3] dark:border-[#2A2A30] shadow-lg"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <div className="flex items-center justify-around px-2 py-1.5">
        {BOTTOM_ITEMS.map((item) => {
          const isActive =
            item.to === '/'
              ? location.pathname === '/'
              : location.pathname.startsWith(item.to.split('?')[0]);

          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={[
                'flex flex-col items-center gap-0.5 min-w-[56px] px-2 py-1 rounded-lg transition-colors',
                isActive
                  ? 'text-[#553DE9]'
                  : 'text-[#939084] hover:text-[#36342E] dark:hover:text-[#E8E6E3]',
              ].join(' ')}
            >
              <item.icon size={20} strokeWidth={isActive ? 2.5 : 2} />
              <span className="text-[10px] font-medium leading-tight">{item.label}</span>
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}
