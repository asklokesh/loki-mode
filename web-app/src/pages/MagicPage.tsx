import { useState, useEffect, useCallback } from 'react';
import { Sparkles, Search, Grid3x3, List } from 'lucide-react';
import { MagicGeneratorPanel } from '../components/MagicGeneratorPanel';
import { MagicComponentCard } from '../components/MagicComponentCard';

export type MagicTarget = 'react' | 'webcomponent' | 'both';

export interface MagicComponent {
  name: string;
  version: string;
  description: string;
  tags: string[];
  targets: MagicTarget[];
  created_at: string;
  updated_at: string;
  debate_passed: boolean;
  spec_path: string;
}

export interface MagicGenerateSpec {
  name: string;
  description: string;
  target: MagicTarget;
  tags: string[];
  screenshot?: string;
}

type ViewMode = 'grid' | 'list';
type TargetFilter = 'all' | 'react' | 'webcomponent';

export default function MagicPage() {
  const [components, setComponents] = useState<MagicComponent[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [filterTarget, setFilterTarget] = useState<TargetFilter>('all');

  const fetchComponents = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/magic/components');
      if (res.ok) {
        const data = await res.json();
        setComponents(Array.isArray(data?.components) ? data.components : []);
      } else {
        setError(`Failed to load components (HTTP ${res.status})`);
      }
    } catch (e) {
      console.error('Failed to load components', e);
      setError('Failed to load components');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchComponents();
  }, [fetchComponents]);

  const handleGenerate = useCallback(
    async (spec: MagicGenerateSpec): Promise<boolean> => {
      try {
        const res = await fetch('/api/magic/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(spec),
        });
        if (res.ok) {
          await fetchComponents();
          return true;
        }
        return false;
      } catch (e) {
        console.error('Failed to generate component', e);
        return false;
      }
    },
    [fetchComponents],
  );

  const handleRunDebate = useCallback(
    async (name: string): Promise<boolean> => {
      try {
        const res = await fetch(
          `/api/magic/components/${encodeURIComponent(name)}/debate`,
          { method: 'POST' },
        );
        if (res.ok) {
          await fetchComponents();
          return true;
        }
        return false;
      } catch (e) {
        console.error('Failed to run debate', e);
        return false;
      }
    },
    [fetchComponents],
  );

  const handleDeprecate = useCallback(
    async (name: string): Promise<boolean> => {
      try {
        const res = await fetch(
          `/api/magic/components/${encodeURIComponent(name)}`,
          { method: 'DELETE' },
        );
        if (res.ok) {
          await fetchComponents();
          return true;
        }
        return false;
      } catch (e) {
        console.error('Failed to deprecate component', e);
        return false;
      }
    },
    [fetchComponents],
  );

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filtered = components.filter((c) => {
    const matchesSearch =
      !normalizedQuery ||
      c.name.toLowerCase().includes(normalizedQuery) ||
      c.description.toLowerCase().includes(normalizedQuery) ||
      c.tags.some((t) => t.toLowerCase().includes(normalizedQuery));
    const matchesTarget =
      filterTarget === 'all' ||
      c.targets.includes(filterTarget as MagicTarget) ||
      c.targets.includes('both');
    return matchesSearch && matchesTarget;
  });

  return (
    <div className="min-h-screen bg-[#FAF9F6] dark:bg-[#0F0F11]">
      {/* Header */}
      <header className="border-b border-[#ECEAE3] dark:border-[#2A2A30] bg-white dark:bg-[#1A1A1E]">
        <div className="max-w-6xl mx-auto px-6 py-8">
          <div className="flex items-center gap-3 mb-2">
            <Sparkles className="text-[#553DE9]" size={28} aria-hidden="true" />
            <h1 className="text-2xl font-semibold text-[#36342E] dark:text-[#E8E6E3]">
              Magic Modules
            </h1>
          </div>
          <p className="text-sm text-[#6B6960] dark:text-[#8A8880] max-w-3xl">
            Describe a component. Loki generates React and Web Component variants,
            runs a multi-persona debate, and registers it for reuse.
          </p>
        </div>
      </header>

      {/* Generator panel */}
      <section
        aria-labelledby="magic-generator-heading"
        className="max-w-6xl mx-auto px-6 py-8"
      >
        <h2 id="magic-generator-heading" className="sr-only">
          Generate a new component
        </h2>
        <MagicGeneratorPanel onGenerate={handleGenerate} />
      </section>

      {/* Registry toolbar */}
      <section aria-labelledby="magic-registry-heading" className="max-w-6xl mx-auto px-6">
        <div className="flex items-center justify-between mb-4">
          <h2
            id="magic-registry-heading"
            className="text-lg font-semibold text-[#36342E] dark:text-[#E8E6E3]"
          >
            Component Registry
          </h2>
          <span className="text-xs text-[#6B6960] dark:text-[#8A8880]">
            {loading
              ? 'Loading...'
              : `${filtered.length} of ${components.length} component${components.length === 1 ? '' : 's'}`}
          </span>
        </div>

        <div className="flex flex-col md:flex-row md:items-center gap-3 mb-4">
          <div className="flex-1 relative">
            <Search
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[#939084]"
              size={16}
              aria-hidden="true"
            />
            <label htmlFor="magic-search" className="sr-only">
              Search components
            </label>
            <input
              id="magic-search"
              type="text"
              placeholder="Search components by name, description, or tag..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 rounded-lg border border-[#ECEAE3] dark:border-[#2A2A30] bg-white dark:bg-[#1A1A1E] text-sm text-[#36342E] dark:text-[#E8E6E3] placeholder:text-[#939084] focus:outline-none focus:ring-2 focus:ring-[#553DE9]/40 focus:border-[#553DE9]"
            />
          </div>

          <div className="flex items-center gap-3">
            <label htmlFor="magic-filter-target" className="sr-only">
              Filter by target
            </label>
            <select
              id="magic-filter-target"
              value={filterTarget}
              onChange={(e) => setFilterTarget(e.target.value as TargetFilter)}
              className="px-3 py-2 rounded-lg border border-[#ECEAE3] dark:border-[#2A2A30] bg-white dark:bg-[#1A1A1E] text-sm text-[#36342E] dark:text-[#E8E6E3] focus:outline-none focus:ring-2 focus:ring-[#553DE9]/40 focus:border-[#553DE9]"
            >
              <option value="all">All targets</option>
              <option value="react">React</option>
              <option value="webcomponent">Web Component</option>
            </select>

            <button
              type="button"
              onClick={() => setViewMode((m) => (m === 'grid' ? 'list' : 'grid'))}
              className="p-2 rounded-lg border border-[#ECEAE3] dark:border-[#2A2A30] bg-white dark:bg-[#1A1A1E] text-[#36342E] dark:text-[#E8E6E3] hover:bg-[#F5F4EF] dark:hover:bg-[#23232A] focus:outline-none focus:ring-2 focus:ring-[#553DE9]/40"
              title={viewMode === 'grid' ? 'Switch to list view' : 'Switch to grid view'}
              aria-label={viewMode === 'grid' ? 'Switch to list view' : 'Switch to grid view'}
              aria-pressed={viewMode === 'list'}
            >
              {viewMode === 'grid' ? <List size={16} /> : <Grid3x3 size={16} />}
            </button>
          </div>
        </div>
      </section>

      {/* Registry grid/list */}
      <section className="max-w-6xl mx-auto px-6 pb-12">
        {error ? (
          <div
            role="alert"
            className="text-center py-12 text-[#C45B5B] text-sm"
          >
            {error}
          </div>
        ) : loading ? (
          <div className="text-center py-12 text-[#6B6960] dark:text-[#8A8880] text-sm">
            Loading components...
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12 text-[#6B6960] dark:text-[#8A8880] text-sm">
            {components.length === 0
              ? 'No components yet. Describe one above to get started.'
              : 'No components match your search.'}
          </div>
        ) : (
          <div
            className={
              viewMode === 'grid'
                ? 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4'
                : 'space-y-2'
            }
          >
            {filtered.map((c) => (
              <MagicComponentCard
                key={c.name}
                component={c}
                variant={viewMode}
                onRunDebate={handleRunDebate}
                onDeprecate={handleDeprecate}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
