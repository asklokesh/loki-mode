import { useState, useRef, useCallback, useEffect } from 'react';
import { Search, FileCode2, Hash, ArrowRight, X, Loader2 } from 'lucide-react';
import { api } from '../api/client';

interface SearchResult {
  path: string;
  name: string;
  lineNumber?: number;
  matchContext?: string;
  relevanceScore: number;
}

interface NLSearchProps {
  /** Session ID for file search */
  sessionId: string;
  /** Callback when a result is clicked */
  onOpenFile: (path: string, line?: number) => void;
  /** CSS class names */
  className?: string;
}

// Translate natural language queries to search terms
function parseNaturalLanguage(query: string): { terms: string[]; filePattern?: string } {
  const q = query.toLowerCase().trim();
  const terms: string[] = [];
  let filePattern: string | undefined;

  // Pattern: "where is the X function/component/class?"
  const whereIs = q.match(/where (?:is|are) (?:the )?(.+?)(?:\?|$)/);
  if (whereIs) {
    terms.push(...whereIs[1].split(/\s+/).filter(w => !['the', 'a', 'an', 'my'].includes(w)));
  }

  // Pattern: "show me all X"
  const showMe = q.match(/show (?:me )?(?:all )?(.+?)(?:\?|$)/);
  if (showMe && terms.length === 0) {
    terms.push(...showMe[1].split(/\s+/).filter(w => !['the', 'a', 'an', 'my', 'all'].includes(w)));
  }

  // Pattern: "find the X"
  const findThe = q.match(/find (?:the )?(.+?)(?:\?|$)/);
  if (findThe && terms.length === 0) {
    terms.push(...findThe[1].split(/\s+/).filter(w => !['the', 'a', 'an', 'my'].includes(w)));
  }

  // Pattern-specific file types
  if (q.includes('api endpoint') || q.includes('route') || q.includes('handler')) {
    filePattern = 'api';
    if (terms.length === 0) terms.push('app.get', 'app.post', 'router', '@app.route', 'endpoint');
  }
  if (q.includes('database') || q.includes('db connection') || q.includes('schema')) {
    if (terms.length === 0) terms.push('database', 'connection', 'schema', 'model', 'migration');
  }
  if (q.includes('login') || q.includes('auth') || q.includes('authentication')) {
    if (terms.length === 0) terms.push('auth', 'login', 'session', 'token', 'password');
  }
  if (q.includes('test') || q.includes('spec')) {
    filePattern = 'test';
    if (terms.length === 0) terms.push('describe', 'it(', 'test(', 'expect');
  }
  if (q.includes('style') || q.includes('css') || q.includes('theme')) {
    filePattern = 'css';
    if (terms.length === 0) terms.push('style', 'theme', 'color', 'font');
  }
  if (q.includes('config') || q.includes('configuration') || q.includes('settings')) {
    if (terms.length === 0) terms.push('config', 'settings', 'env', 'options');
  }

  // Fallback: just use the words
  if (terms.length === 0) {
    terms.push(...q.split(/\s+/).filter(w =>
      w.length > 2 && !['the', 'a', 'an', 'my', 'all', 'show', 'me', 'find', 'where', 'is', 'are', 'how'].includes(w)
    ));
  }

  return { terms, filePattern };
}

function scoreResult(result: { path: string; name: string }, terms: string[]): number {
  let score = 0;
  const pathLower = result.path.toLowerCase();
  const nameLower = result.name.toLowerCase();

  for (const term of terms) {
    const termLower = term.toLowerCase();
    if (nameLower === termLower) score += 100;
    else if (nameLower.includes(termLower)) score += 60;
    else if (pathLower.includes(termLower)) score += 30;
  }

  // Boost for shorter paths (more specific files)
  score += Math.max(0, 20 - result.path.split('/').length * 2);

  return score;
}

const EXAMPLE_QUERIES = [
  'Where is the login function?',
  'Show me all API endpoints',
  'Find the database connection',
  'Where are the tests?',
  'Show me the configuration files',
];

export function NLSearch({ sessionId, onOpenFile, className = '' }: NLSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [focused, setFocused] = useState(false);
  const [searched, setSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const performSearch = useCallback(async (searchQuery: string) => {
    if (!searchQuery.trim() || !sessionId) {
      setResults([]);
      setSearched(false);
      return;
    }

    setLoading(true);
    setSearched(true);

    try {
      const { terms } = parseNaturalLanguage(searchQuery);
      const searchTerm = terms.join(' ');

      // Use the existing file search API
      const fileResults = await api.searchFiles(sessionId, searchTerm);

      // Score and sort results
      const scored: SearchResult[] = fileResults.map(r => ({
        path: r.path,
        name: r.name,
        relevanceScore: scoreResult(r, terms),
      }));

      scored.sort((a, b) => b.relevanceScore - a.relevanceScore);
      setResults(scored.slice(0, 15));
    } catch {
      // If API fails, show empty results gracefully
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // Debounced search
  const handleQueryChange = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => performSearch(value), 400);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    performSearch(query);
  };

  const handleClear = () => {
    setQuery('');
    setResults([]);
    setSearched(false);
    inputRef.current?.focus();
  };

  const handleExampleClick = (example: string) => {
    setQuery(example);
    performSearch(example);
  };

  // Cleanup
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const getFileIcon = (path: string) => {
    if (path.includes('.test.') || path.includes('.spec.')) return 'text-teal';
    if (path.endsWith('.css') || path.endsWith('.scss')) return 'text-pink';
    if (path.endsWith('.json') || path.endsWith('.yaml')) return 'text-warning';
    if (path.endsWith('.md')) return 'text-muted';
    return 'text-primary';
  };

  return (
    <div className={`card overflow-hidden ${className}`}>
      {/* Search header */}
      <div className="px-4 pt-4 pb-2">
        <div className="flex items-center gap-2 mb-1">
          <Search size={14} className="text-primary" />
          <h3 className="text-sm font-semibold text-ink uppercase tracking-wider">
            Code Search
          </h3>
        </div>
        <p className="text-[11px] text-muted mb-3">
          Search in natural language -- "Where is the login function?"
        </p>

        {/* Search input */}
        <form onSubmit={handleSubmit} className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setTimeout(() => setFocused(false), 200)}
            placeholder="Ask about your code..."
            className="w-full pl-9 pr-8 py-2 text-sm bg-hover/50 border border-border rounded-card
                       focus:border-primary focus:ring-1 focus:ring-primary/20 outline-none
                       text-ink placeholder:text-muted"
          />
          {query && (
            <button
              type="button"
              onClick={handleClear}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-ink transition-colors"
            >
              <X size={14} />
            </button>
          )}
        </form>
      </div>

      {/* Example queries */}
      {!searched && focused && (
        <div className="px-4 pb-3">
          <div className="text-[11px] text-muted mb-1.5">Try searching for:</div>
          <div className="flex flex-wrap gap-1">
            {EXAMPLE_QUERIES.map(ex => (
              <button
                key={ex}
                onClick={() => handleExampleClick(ex)}
                className="text-[11px] text-primary bg-primary/5 hover:bg-primary/10
                           px-2 py-1 rounded-pill border border-primary/10 transition-colors"
              >
                {ex}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted">
          <Loader2 size={14} className="animate-spin" />
          Searching...
        </div>
      )}

      {/* Results */}
      {searched && !loading && (
        <div className="border-t border-border">
          {results.length === 0 ? (
            <div className="text-center py-6 text-xs text-muted">
              No results found. Try a different query.
            </div>
          ) : (
            <div className="max-h-[320px] overflow-y-auto terminal-scroll">
              <div className="text-[11px] text-muted px-4 py-1.5 bg-hover/30 border-b border-border">
                {results.length} result{results.length !== 1 ? 's' : ''} found
              </div>
              {results.map((result, i) => (
                <button
                  key={`${result.path}-${i}`}
                  onClick={() => onOpenFile(result.path, result.lineNumber)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-left
                             hover:bg-hover/50 transition-colors border-b border-border last:border-b-0
                             group cursor-pointer"
                >
                  <FileCode2 size={14} className={getFileIcon(result.path)} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-ink group-hover:text-primary transition-colors truncate">
                      {result.name}
                    </div>
                    <div className="text-[11px] text-muted font-mono truncate">
                      {result.path}
                    </div>
                    {result.matchContext && (
                      <div className="text-[11px] text-secondary mt-0.5 truncate font-mono">
                        {result.matchContext}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {result.lineNumber && (
                      <span className="flex items-center gap-0.5 text-[11px] text-muted font-mono">
                        <Hash size={10} />
                        {result.lineNumber}
                      </span>
                    )}
                    <ArrowRight size={12} className="text-muted group-hover:text-primary transition-colors" />
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
