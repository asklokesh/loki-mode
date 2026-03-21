import { lazy, Suspense, useEffect } from 'react';
import { Routes, Route } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { AuthProvider } from './hooks/useAuth';
import { ProtectedRoute } from './components/auth/ProtectedRoute';
import { Skeleton } from './components/ui/Skeleton';

// Suppress "Changes may not be saved" dialog on refresh.
// Purple Lab auto-persists state to sessionStorage -- nothing is lost.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    delete e.returnValue;
  });
}

const HomePage = lazy(() => import('./pages/HomePage'));
const ProjectPage = lazy(() => import('./pages/ProjectPage'));
const ProjectsPage = lazy(() => import('./pages/ProjectsPage'));
const TemplatesPage = lazy(() => import('./pages/TemplatesPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const LoginPage = lazy(() => import('./pages/LoginPage'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));

function LoadingFallback() {
  return (
    <div className="h-screen bg-[#FAF9F6] flex flex-col items-center justify-center gap-3">
      <Skeleton variant="block" width="200px" height="24px" />
      <Skeleton variant="text" width="140px" height="12px" className="opacity-50" />
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        {/* Login page -- no shell, no onboarding overlay */}
        <Route path="/login" element={
          <Suspense fallback={<LoadingFallback />}><LoginPage /></Suspense>
        } />

        {/* Full-screen IDE -- no sidebar */}
        <Route path="/project/:sessionId" element={
          <ProtectedRoute>
            <Suspense fallback={<LoadingFallback />}><ProjectPage /></Suspense>
          </ProtectedRoute>
        } />

        {/* Platform shell -- sidebar navigation */}
        <Route element={<ProtectedRoute><AppShell /></ProtectedRoute>}>
          <Route path="/" element={<Suspense fallback={<LoadingFallback />}><HomePage /></Suspense>} />
          <Route path="/projects" element={<Suspense fallback={<LoadingFallback />}><ProjectsPage /></Suspense>} />
          <Route path="/templates" element={<Suspense fallback={<LoadingFallback />}><TemplatesPage /></Suspense>} />
          <Route path="/settings" element={<Suspense fallback={<LoadingFallback />}><SettingsPage /></Suspense>} />
          <Route path="*" element={<Suspense fallback={<LoadingFallback />}><NotFoundPage /></Suspense>} />
        </Route>
      </Routes>
    </AuthProvider>
  );
}
