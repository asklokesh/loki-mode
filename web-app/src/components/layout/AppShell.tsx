import { useState, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { OnboardingOverlay } from '../OnboardingOverlay';
import { MobileNav } from '../MobileNav';
import { MobileBottomNav } from '../MobileBottomNav';
import { api } from '../../api/client';
import { useWebSocket } from '../../hooks/useWebSocket';

export function AppShell() {
  const [version, setVersion] = useState('');
  const location = useLocation();

  const { connected } = useWebSocket(() => {});

  useEffect(() => {
    api.getStatus().then(s => {
      setVersion(s.version || '');
    }).catch(() => {});
  }, []);

  // K107: Smooth scroll to top on page navigation
  useEffect(() => {
    const main = document.getElementById('main-content');
    if (main) main.scrollTo({ top: 0, behavior: 'smooth' });
  }, [location.pathname]);

  return (
    <div className="flex h-screen bg-[#FAF9F6]">
      <OnboardingOverlay />
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:top-2 focus:left-2 focus:px-4 focus:py-2 focus:bg-white focus:text-[#553DE9] focus:rounded-[3px] focus:shadow-card"
      >
        Skip to main content
      </a>
      {/* Desktop sidebar */}
      <div className="hidden md:block">
        <Sidebar wsConnected={connected} version={version} />
      </div>
      {/* Mobile navigation */}
      <MobileNav />
      <main id="main-content" className="flex-1 overflow-auto mobile-bottom-spacer">
        <Outlet />
      </main>
      <MobileBottomNav />
    </div>
  );
}
