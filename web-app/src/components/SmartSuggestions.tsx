import { useState, useEffect, useMemo } from 'react';
import { Sparkles, ArrowRight } from 'lucide-react';

type ProjectState = 'empty' | 'building' | 'completed' | 'failed' | 'idle';

interface SmartSuggestionsProps {
  /** Current state of the project */
  projectState: ProjectState;
  /** Whether a session is active */
  hasSession: boolean;
  /** File list (for context) */
  files?: Array<{ path: string; type: string }>;
  /** Last error message if build failed */
  lastError?: string;
  /** Current phase */
  phase?: string;
  /** Callback when a suggestion is clicked */
  onSelect: (prompt: string) => void;
  /** Additional CSS classes */
  className?: string;
}

interface Suggestion {
  label: string;
  prompt: string;
  category: 'create' | 'improve' | 'fix' | 'test' | 'deploy';
}

const CATEGORY_STYLES: Record<string, string> = {
  create: 'bg-primary/8 text-primary border-primary/15 hover:bg-primary/15',
  improve: 'bg-info/8 text-info border-info/15 hover:bg-info/15',
  fix: 'bg-danger/8 text-danger border-danger/15 hover:bg-danger/15',
  test: 'bg-teal/8 text-teal border-teal/15 hover:bg-teal/15',
  deploy: 'bg-warning/8 text-warning border-warning/15 hover:bg-warning/15',
};

function getSuggestions(props: SmartSuggestionsProps): Suggestion[] {
  const { projectState, hasSession, files, lastError, phase } = props;

  // No project at all
  if (!hasSession || projectState === 'empty') {
    return [
      { label: 'Build a SaaS dashboard', prompt: 'Build a modern SaaS analytics dashboard with charts and dark mode', category: 'create' },
      { label: 'Create a CLI tool', prompt: 'Create a CLI tool with commands, flags, and help text', category: 'create' },
      { label: 'Build a REST API', prompt: 'Build a REST API with CRUD endpoints, authentication, and database', category: 'create' },
      { label: 'Make a landing page', prompt: 'Create a beautiful landing page with hero, features, pricing, and CTA sections', category: 'create' },
    ];
  }

  // Build failed
  if (projectState === 'failed') {
    const suggestions: Suggestion[] = [
      { label: 'Fix the build errors', prompt: 'Fix all build errors and get the project to compile successfully', category: 'fix' },
      { label: 'Try a different approach', prompt: 'The current approach has issues. Try an alternative implementation strategy', category: 'fix' },
    ];

    if (lastError) {
      const shortError = lastError.length > 60 ? lastError.slice(0, 60) + '...' : lastError;
      suggestions.unshift({
        label: `Fix: ${shortError}`,
        prompt: `Fix this error: ${lastError}`,
        category: 'fix',
      });
    }

    suggestions.push({
      label: 'Add error handling',
      prompt: 'Add comprehensive error handling and fallbacks throughout the codebase',
      category: 'improve',
    });

    return suggestions.slice(0, 4);
  }

  // Build in progress
  if (projectState === 'building') {
    return []; // Don't show suggestions during active builds
  }

  // Project exists and build completed
  if (projectState === 'completed' || projectState === 'idle') {
    const suggestions: Suggestion[] = [];

    // Detect project type from files
    const hasAuth = files?.some(f => f.path.toLowerCase().includes('auth'));
    const hasTests = files?.some(f => f.path.includes('.test.') || f.path.includes('.spec.') || f.path.includes('__tests__'));
    const hasStyles = files?.some(f => f.path.endsWith('.css') || f.path.endsWith('.scss'));
    const hasDocker = files?.some(f => f.path.includes('Dockerfile') || f.path.includes('docker-compose'));

    if (!hasAuth) {
      suggestions.push({
        label: 'Add authentication',
        prompt: 'Add user authentication with login, signup, and session management',
        category: 'improve',
      });
    }

    if (!hasTests) {
      suggestions.push({
        label: 'Add test suite',
        prompt: 'Add comprehensive unit tests and integration tests for all major features',
        category: 'test',
      });
    }

    suggestions.push({
      label: 'Improve the UI',
      prompt: 'Improve the UI with better styling, animations, and responsive design',
      category: 'improve',
    });

    if (!hasDocker) {
      suggestions.push({
        label: 'Add Docker support',
        prompt: 'Add Dockerfile and docker-compose.yml for containerized deployment',
        category: 'deploy',
      });
    }

    if (hasAuth) {
      suggestions.push({
        label: 'Add role-based access',
        prompt: 'Add role-based access control with admin, editor, and viewer roles',
        category: 'improve',
      });
    }

    if (!hasStyles) {
      suggestions.push({
        label: 'Add dark mode',
        prompt: 'Add a dark mode toggle with proper theme support across all components',
        category: 'improve',
      });
    }

    suggestions.push({
      label: 'Add API docs',
      prompt: 'Add OpenAPI/Swagger documentation for all API endpoints',
      category: 'improve',
    });

    suggestions.push({
      label: 'Performance optimization',
      prompt: 'Optimize performance: add lazy loading, caching, code splitting, and minimize bundle size',
      category: 'improve',
    });

    return suggestions.slice(0, 4);
  }

  return [];
}

export function SmartSuggestions(props: SmartSuggestionsProps) {
  const { onSelect, className = '' } = props;
  const [visible, setVisible] = useState(true);
  const [fadingOut, setFadingOut] = useState(false);

  const suggestions = useMemo(() => getSuggestions(props), [
    props.projectState, props.hasSession, props.files, props.lastError, props.phase,
  ]);

  // Rotate suggestions every 30 seconds
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    if (suggestions.length <= 4) return;
    const timer = setInterval(() => {
      setFadingOut(true);
      setTimeout(() => {
        setOffset(prev => (prev + 1) % suggestions.length);
        setFadingOut(false);
      }, 300);
    }, 30000);
    return () => clearInterval(timer);
  }, [suggestions.length]);

  if (suggestions.length === 0 || !visible) return null;

  const displayed = suggestions.slice(offset, offset + 4).concat(
    offset + 4 > suggestions.length ? suggestions.slice(0, (offset + 4) - suggestions.length) : []
  ).slice(0, 4);

  return (
    <div className={`${className}`}>
      <div className="flex items-center gap-1.5 mb-2">
        <Sparkles size={12} className="text-primary" />
        <span className="text-[11px] font-semibold text-muted uppercase tracking-wider">
          Suggestions
        </span>
      </div>
      <div className={`flex flex-wrap gap-1.5 transition-opacity duration-300 ${fadingOut ? 'opacity-0' : 'opacity-100'}`}>
        {displayed.map((s, i) => (
          <button
            key={`${s.label}-${i}`}
            onClick={() => onSelect(s.prompt)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium
              border rounded-pill transition-all duration-200 cursor-pointer
              ${CATEGORY_STYLES[s.category] || CATEGORY_STYLES.create}
            `}
          >
            {s.label}
            <ArrowRight size={10} className="opacity-50" />
          </button>
        ))}
      </div>
    </div>
  );
}
