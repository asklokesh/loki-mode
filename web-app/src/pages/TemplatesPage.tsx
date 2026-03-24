import { useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import {
  Search, Rocket, Clock, BarChart3,
  Globe, Server, Terminal, Bot, Database, Package,
} from 'lucide-react';
import { api } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import { PageTransition } from '../components/PageTransition';
import { StaggeredList } from '../components/StaggeredList';
import type { TemplateMetadata } from '../types/api';

type Category = 'all' | 'Website' | 'API' | 'CLI' | 'Bot' | 'Data' | 'Other';

const CATEGORIES: { key: Category; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { key: 'all', label: 'All', icon: Package },
  { key: 'Website', label: 'Website', icon: Globe },
  { key: 'API', label: 'API', icon: Server },
  { key: 'CLI', label: 'CLI', icon: Terminal },
  { key: 'Bot', label: 'Bot', icon: Bot },
  { key: 'Data', label: 'Data', icon: Database },
  { key: 'Other', label: 'Other', icon: Package },
];

// Gradient presets per category
const CATEGORY_GRADIENTS: Record<string, string> = {
  Website: 'from-violet-500/20 via-purple-500/10 to-indigo-500/20',
  API: 'from-emerald-500/20 via-teal-500/10 to-cyan-500/20',
  CLI: 'from-amber-500/20 via-orange-500/10 to-yellow-500/20',
  Bot: 'from-blue-500/20 via-sky-500/10 to-cyan-500/20',
  Data: 'from-rose-500/20 via-pink-500/10 to-fuchsia-500/20',
  Other: 'from-slate-500/20 via-gray-500/10 to-zinc-500/20',
};

// Known tech stack badge styles
const TECH_COLORS: Record<string, string> = {
  React: 'bg-sky-500/10 text-sky-600',
  'Node.js': 'bg-green-500/10 text-green-600',
  Python: 'bg-yellow-500/10 text-yellow-700',
  TypeScript: 'bg-blue-500/10 text-blue-600',
  PostgreSQL: 'bg-indigo-500/10 text-indigo-600',
  MongoDB: 'bg-green-600/10 text-green-700',
  Docker: 'bg-cyan-500/10 text-cyan-600',
  Redis: 'bg-red-500/10 text-red-600',
  Express: 'bg-gray-500/10 text-gray-600',
  FastAPI: 'bg-teal-500/10 text-teal-600',
  SQLite: 'bg-blue-400/10 text-blue-500',
  Tailwind: 'bg-cyan-400/10 text-cyan-600',
  Discord: 'bg-indigo-400/10 text-indigo-500',
  Slack: 'bg-purple-500/10 text-purple-600',
  CLI: 'bg-amber-500/10 text-amber-600',
  Playwright: 'bg-green-500/10 text-green-600',
  Vite: 'bg-purple-400/10 text-purple-500',
  Next: 'bg-gray-600/10 text-gray-700',
};

const DIFFICULTY_STYLES: Record<string, { label: string; color: string; bars: number }> = {
  beginner: { label: 'Beginner', color: 'text-green-500', bars: 1 },
  intermediate: { label: 'Intermediate', color: 'text-yellow-500', bars: 2 },
  advanced: { label: 'Advanced', color: 'text-red-400', bars: 3 },
};

function DifficultyIndicator({ level }: { level: string }) {
  const style = DIFFICULTY_STYLES[level] || DIFFICULTY_STYLES.intermediate;
  return (
    <div className="flex items-center gap-1.5">
      <BarChart3 size={12} className={style.color} />
      <div className="flex gap-0.5">
        {[1, 2, 3].map(i => (
          <div
            key={i}
            className={`w-1.5 h-3 rounded-sm ${
              i <= style.bars ? 'bg-current ' + style.color : 'bg-muted/20'
            }`}
          />
        ))}
      </div>
      <span className={`text-[10px] font-medium ${style.color}`}>{style.label}</span>
    </div>
  );
}

function formatTemplateName(name: string): string {
  return name
    .replace(/\.md$/i, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function TemplatesPage() {
  const navigate = useNavigate();
  const [activeCategory, setActiveCategory] = useState<Category>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const fetchTemplates = useCallback(() => api.getTemplates(), []);
  const { data: rawTemplates } = usePolling(fetchTemplates, 60000, true);

  // Cast to TemplateMetadata (backend will return extended fields)
  const templates = rawTemplates as TemplateMetadata[] | null;

  const filtered = useMemo(() => {
    if (!templates) return [];
    let result = templates;

    // Filter by category
    if (activeCategory !== 'all') {
      result = result.filter((t) => (t.category || 'Other') === activeCategory);
    }

    // Filter by search query (name, description, tech stack)
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((t) =>
        t.name.toLowerCase().includes(q) ||
        (t.description || '').toLowerCase().includes(q) ||
        (t.tech_stack || []).some(tech => tech.toLowerCase().includes(q))
      );
    }

    return result;
  }, [templates, activeCategory, searchQuery]);

  const handleSelect = (filename: string) => {
    sessionStorage.setItem('pl_template', filename);
    navigate('/');
  };

  return (
    <PageTransition>
    <div className="max-w-[1400px] mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-heading text-h1 text-[#36342E]">Templates</h1>
        <span className="text-xs text-muted">{templates?.length || 0} templates available</span>
      </div>

      {/* Search bar */}
      <div className="relative mb-4">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search by name, description, or tech stack..."
          className="w-full pl-9 pr-4 py-2.5 text-sm bg-white border border-[#ECEAE3] rounded-btn outline-none focus:border-[#553DE9] transition-colors"
        />
      </div>

      {/* Category filters */}
      <div className="flex items-center gap-1 mb-6 overflow-x-auto" role="tablist">
        {CATEGORIES.map((cat) => {
          const Icon = cat.icon;
          return (
            <button
              key={cat.key}
              role="tab"
              aria-selected={activeCategory === cat.key}
              onClick={() => setActiveCategory(cat.key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-[3px] transition-colors whitespace-nowrap ${
                activeCategory === cat.key
                  ? 'bg-[#553DE9] text-white'
                  : 'text-[#6B6960] hover:text-[#36342E] hover:bg-[#F8F4F0]'
              }`}
            >
              <Icon size={13} />
              {cat.label}
            </button>
          );
        })}
      </div>

      {/* Grid */}
      {!templates ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {[1, 2, 3, 4, 5, 6].map(i => (
            <div key={i} className="bg-white border border-[#ECEAE3] rounded-[5px] shadow-card overflow-hidden animate-pulse">
              <div className="h-28 bg-gradient-to-br from-muted/10 to-muted/5" />
              <div className="p-4 space-y-2">
                <div className="h-4 bg-muted/10 rounded w-3/4" />
                <div className="h-3 bg-muted/10 rounded w-full" />
                <div className="h-3 bg-muted/10 rounded w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-16 text-center">
          <Search size={32} className="mx-auto text-muted/30 mb-3" />
          <p className="text-sm text-[#6B6960]">No templates match your search.</p>
          {searchQuery && (
            <button
              onClick={() => { setSearchQuery(''); setActiveCategory('all'); }}
              className="mt-2 text-xs text-[#553DE9] hover:underline"
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <StaggeredList
          animation="scale-in"
          stagger={50}
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5"
        >
          {filtered.map((t) => {
            const gradient = t.gradient || CATEGORY_GRADIENTS[t.category] || CATEGORY_GRADIENTS.Other;
            const techStack = t.tech_stack || [];
            const difficulty = t.difficulty || 'intermediate';
            const buildTime = t.build_time || '5-10 min';

            return (
              <div
                key={t.filename}
                role="button"
                tabIndex={0}
                onClick={() => handleSelect(t.filename)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSelect(t.filename); } }}
                className="bg-white border border-[#ECEAE3] rounded-[5px] shadow-card hover:shadow-card-hover transition-shadow duration-200 cursor-pointer overflow-hidden group"
              >
                {/* Visual preview gradient */}
                <div className={`h-28 bg-gradient-to-br ${gradient} relative overflow-hidden`}>
                  {/* Decorative pattern */}
                  <div className="absolute inset-0 opacity-[0.08]">
                    <div className="absolute top-4 left-4 w-16 h-16 border-2 border-current rounded-lg rotate-12" />
                    <div className="absolute bottom-3 right-6 w-10 h-10 border-2 border-current rounded-full" />
                    <div className="absolute top-6 right-12 w-6 h-6 border-2 border-current rounded" />
                  </div>
                  {/* Category icon overlay */}
                  <div className="absolute top-3 right-3">
                    <Badge status="version">{t.category || 'Other'}</Badge>
                  </div>
                  {/* Tech stack preview in gradient */}
                  {techStack.length > 0 && (
                    <div className="absolute bottom-3 left-3 flex items-center gap-1.5">
                      {techStack.slice(0, 3).map((tech) => (
                        <span key={tech} className="text-[11px] font-semibold text-ink/70 bg-white/70 backdrop-blur-sm px-2 py-0.5 rounded">
                          {tech}
                        </span>
                      ))}
                      {techStack.length > 3 && (
                        <span className="text-[10px] text-ink/50 bg-white/50 backdrop-blur-sm px-1.5 py-0.5 rounded">
                          +{techStack.length - 3}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {/* Card body */}
                <div className="p-4">
                  <h3 className="text-sm font-semibold text-[#36342E] mb-1 group-hover:text-[#553DE9] transition-colors">
                    {formatTemplateName(t.name)}
                  </h3>
                  <p className="text-xs text-[#6B6960] line-clamp-2 mb-3 min-h-[2.4em]">
                    {t.description || t.filename}
                  </p>

                  {/* Tech stack badges */}
                  {techStack.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-3">
                      {techStack.map((tech) => (
                        <span
                          key={tech}
                          className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded ${
                            TECH_COLORS[tech] || 'bg-muted/10 text-muted'
                          }`}
                        >
                          {tech}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Meta row: difficulty + build time + action */}
                  <div className="flex items-center justify-between pt-3 border-t border-[#ECEAE3]">
                    <div className="flex items-center gap-3">
                      <DifficultyIndicator level={difficulty} />
                      <div className="flex items-center gap-1 text-[10px] text-muted">
                        <Clock size={11} />
                        <span>{buildTime}</span>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      icon={Rocket}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSelect(t.filename);
                      }}
                      className="opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      Use
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </StaggeredList>
      )}
    </div>
    </PageTransition>
  );
}
