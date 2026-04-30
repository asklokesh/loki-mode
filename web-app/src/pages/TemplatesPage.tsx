import { useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import {
  Search, Rocket, Clock, BarChart3, Users, Star, Plus,
  Globe, Server, Terminal, Bot, Database, Package,
} from 'lucide-react';
import { api } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import { FeaturedTemplates } from '../components/FeaturedTemplates';
import { TemplatePreview } from '../components/TemplatePreview';
import { CustomTemplateCreator } from '../components/CustomTemplateCreator';
import type { TemplateMetadata } from '../types/api';

type Category = 'all' | 'Website' | 'API' | 'CLI' | 'Bot' | 'Data' | 'Other';

const CATEGORIES: { key: Category; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { key: 'all', label: 'All', icon: Package },
  { key: 'Website', label: 'Web Apps', icon: Globe },
  { key: 'API', label: 'APIs', icon: Server },
  { key: 'CLI', label: 'CLIs', icon: Terminal },
  { key: 'Bot', label: 'Bots', icon: Bot },
  { key: 'Data', label: 'Data', icon: Database },
  { key: 'Other', label: 'Other', icon: Package },
];

// Category-specific gradients for card headers
const CATEGORY_GRADIENTS: Record<string, string> = {
  Website: 'from-violet-500 via-purple-500 to-indigo-500',
  API: 'from-teal-500 via-emerald-500 to-cyan-500',
  CLI: 'from-slate-500 via-gray-500 to-blue-500',
  Bot: 'from-orange-500 via-rose-500 to-pink-500',
  Data: 'from-blue-500 via-indigo-500 to-purple-500',
  Other: 'from-slate-400 via-gray-400 to-zinc-500',
};

// Softer tinted gradients for light-mode card headers
const CATEGORY_GRADIENTS_LIGHT: Record<string, string> = {
  Website: 'from-violet-500/20 via-purple-500/10 to-indigo-500/20',
  API: 'from-emerald-500/20 via-teal-500/10 to-cyan-500/20',
  CLI: 'from-slate-500/20 via-gray-400/10 to-blue-500/20',
  Bot: 'from-orange-500/20 via-rose-500/10 to-pink-500/20',
  Data: 'from-blue-500/20 via-indigo-500/10 to-purple-500/20',
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

// Placeholder usage stats
const TEMPLATE_STATS: Record<string, { uses: number; rating: number }> = {
  'saas-starter.md': { uses: 2847, rating: 4.9 },
  'rest-api-auth.md': { uses: 1923, rating: 4.8 },
  'discord-bot.md': { uses: 1654, rating: 4.7 },
  'full-stack-demo.md': { uses: 1432, rating: 4.8 },
  'data-pipeline.md': { uses: 1198, rating: 4.6 },
  'cli-tool.md': { uses: 987, rating: 4.7 },
  'e-commerce.md': { uses: 2156, rating: 4.8 },
  'blog-platform.md': { uses: 1345, rating: 4.5 },
  'rest-api.md': { uses: 1567, rating: 4.6 },
  'slack-bot.md': { uses: 876, rating: 4.4 },
  'dashboard.md': { uses: 1789, rating: 4.7 },
  'web-scraper.md': { uses: 654, rating: 4.3 },
  'chrome-extension.md': { uses: 543, rating: 4.5 },
  'microservice.md': { uses: 1123, rating: 4.6 },
  'mobile-app.md': { uses: 932, rating: 4.4 },
  'game.md': { uses: 765, rating: 4.5 },
  'npm-library.md': { uses: 445, rating: 4.3 },
  'static-landing-page.md': { uses: 1876, rating: 4.6 },
  'simple-todo-app.md': { uses: 2345, rating: 4.7 },
  'ai-chatbot.md': { uses: 1234, rating: 4.8 },
};

function formatNumber(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// SVG decorative patterns per category
function CategoryPattern({ category }: { category: string }) {
  switch (category) {
    case 'Website':
      return (
        <svg className="absolute inset-0 w-full h-full opacity-[0.15]" viewBox="0 0 400 120">
          {/* Mini browser frame */}
          <rect x="40" y="15" width="160" height="90" rx="6" fill="none" stroke="white" strokeWidth="1.5" />
          <line x1="40" y1="30" x2="200" y2="30" stroke="white" strokeWidth="1.5" />
          <circle cx="52" cy="22" r="3" fill="white" fillOpacity="0.6" />
          <circle cx="62" cy="22" r="3" fill="white" fillOpacity="0.6" />
          <circle cx="72" cy="22" r="3" fill="white" fillOpacity="0.6" />
          {/* Content blocks */}
          <rect x="50" y="38" width="80" height="8" rx="2" fill="white" fillOpacity="0.4" />
          <rect x="50" y="52" width="140" height="5" rx="1.5" fill="white" fillOpacity="0.25" />
          <rect x="50" y="62" width="120" height="5" rx="1.5" fill="white" fillOpacity="0.25" />
          <rect x="50" y="78" width="45" height="16" rx="4" fill="white" fillOpacity="0.35" />
          {/* Floating shapes */}
          <circle cx="300" cy="30" r="20" fill="none" stroke="white" strokeWidth="1.5" />
          <rect x="270" y="70" width="25" height="25" rx="5" fill="none" stroke="white" strokeWidth="1" transform="rotate(15 282 82)" />
          <circle cx="350" cy="90" r="8" fill="white" fillOpacity="0.3" />
        </svg>
      );
    case 'API':
      return (
        <svg className="absolute inset-0 w-full h-full opacity-[0.15]" viewBox="0 0 400 120">
          {/* Terminal frame */}
          <rect x="30" y="10" width="180" height="100" rx="6" fill="none" stroke="white" strokeWidth="1.5" />
          <line x1="30" y1="25" x2="210" y2="25" stroke="white" strokeWidth="1.5" />
          <circle cx="42" cy="17" r="3" fill="white" fillOpacity="0.6" />
          <circle cx="52" cy="17" r="3" fill="white" fillOpacity="0.6" />
          {/* JSON-like content */}
          <text x="40" y="42" fill="white" fillOpacity="0.5" fontSize="8" fontFamily="monospace">{'{'}</text>
          <text x="48" y="54" fill="white" fillOpacity="0.4" fontSize="7" fontFamily="monospace">"status": 200,</text>
          <text x="48" y="66" fill="white" fillOpacity="0.4" fontSize="7" fontFamily="monospace">"data": [...]</text>
          <text x="40" y="80" fill="white" fillOpacity="0.5" fontSize="8" fontFamily="monospace">{'}'}</text>
          {/* Network nodes */}
          <circle cx="290" cy="35" r="12" fill="none" stroke="white" strokeWidth="1.5" />
          <circle cx="340" cy="60" r="12" fill="none" stroke="white" strokeWidth="1.5" />
          <circle cx="290" cy="85" r="12" fill="none" stroke="white" strokeWidth="1.5" />
          <line x1="302" y1="35" x2="328" y2="60" stroke="white" strokeWidth="1" />
          <line x1="302" y1="85" x2="328" y2="60" stroke="white" strokeWidth="1" />
          <circle cx="290" cy="35" r="4" fill="white" fillOpacity="0.4" />
          <circle cx="340" cy="60" r="4" fill="white" fillOpacity="0.4" />
          <circle cx="290" cy="85" r="4" fill="white" fillOpacity="0.4" />
        </svg>
      );
    case 'CLI':
      return (
        <svg className="absolute inset-0 w-full h-full opacity-[0.15]" viewBox="0 0 400 120">
          {/* Terminal */}
          <rect x="40" y="12" width="170" height="96" rx="6" fill="none" stroke="white" strokeWidth="1.5" />
          <line x1="40" y1="27" x2="210" y2="27" stroke="white" strokeWidth="1.5" />
          <circle cx="52" cy="19" r="3" fill="white" fillOpacity="0.6" />
          <circle cx="62" cy="19" r="3" fill="white" fillOpacity="0.6" />
          {/* Command output */}
          <text x="50" y="42" fill="white" fillOpacity="0.5" fontSize="7" fontFamily="monospace">$ myapp --help</text>
          <text x="50" y="54" fill="white" fillOpacity="0.35" fontSize="7" fontFamily="monospace">Usage: myapp [cmd]</text>
          <text x="50" y="66" fill="white" fillOpacity="0.35" fontSize="7" fontFamily="monospace">  init    Setup</text>
          <text x="50" y="78" fill="white" fillOpacity="0.35" fontSize="7" fontFamily="monospace">  run     Execute</text>
          <rect x="50" y="88" width="6" height="10" fill="white" fillOpacity="0.6" />
          {/* Floating elements */}
          <text x="270" y="50" fill="white" fillOpacity="0.3" fontSize="24" fontFamily="monospace">&gt;_</text>
          <circle cx="350" cy="80" r="15" fill="none" stroke="white" strokeWidth="1" strokeDasharray="4 4" />
        </svg>
      );
    case 'Bot':
      return (
        <svg className="absolute inset-0 w-full h-full opacity-[0.15]" viewBox="0 0 400 120">
          {/* Chat bubbles */}
          <rect x="40" y="15" width="120" height="28" rx="14" fill="white" fillOpacity="0.2" />
          <rect x="50" y="22" width="60" height="5" rx="2" fill="white" fillOpacity="0.4" />
          <rect x="80" y="55" width="130" height="28" rx="14" fill="white" fillOpacity="0.3" />
          <rect x="90" y="62" width="80" height="5" rx="2" fill="white" fillOpacity="0.4" />
          <rect x="50" y="93" width="100" height="20" rx="10" fill="white" fillOpacity="0.15" />
          <rect x="60" y="99" width="50" height="5" rx="2" fill="white" fillOpacity="0.35" />
          {/* Bot icon */}
          <circle cx="310" cy="55" r="25" fill="none" stroke="white" strokeWidth="1.5" />
          <circle cx="302" cy="50" r="4" fill="white" fillOpacity="0.5" />
          <circle cx="318" cy="50" r="4" fill="white" fillOpacity="0.5" />
          <path d="M300 62 Q310 70 320 62" fill="none" stroke="white" strokeWidth="1.5" />
          <line x1="310" y1="30" x2="310" y2="22" stroke="white" strokeWidth="1.5" />
          <circle cx="310" cy="20" r="3" fill="white" fillOpacity="0.5" />
        </svg>
      );
    case 'Data':
      return (
        <svg className="absolute inset-0 w-full h-full opacity-[0.15]" viewBox="0 0 400 120">
          {/* Database cylinder */}
          <ellipse cx="80" cy="30" rx="35" ry="10" fill="none" stroke="white" strokeWidth="1.5" />
          <line x1="45" y1="30" x2="45" y2="85" stroke="white" strokeWidth="1.5" />
          <line x1="115" y1="30" x2="115" y2="85" stroke="white" strokeWidth="1.5" />
          <ellipse cx="80" cy="85" rx="35" ry="10" fill="none" stroke="white" strokeWidth="1.5" />
          <ellipse cx="80" cy="55" rx="35" ry="10" fill="none" stroke="white" strokeWidth="0.8" strokeDasharray="3 3" />
          {/* Flow arrows */}
          <line x1="140" y1="55" x2="200" y2="55" stroke="white" strokeWidth="1.5" />
          <polygon points="200,50 210,55 200,60" fill="white" fillOpacity="0.5" />
          {/* Chart bars */}
          <rect x="230" y="70" width="15" height="35" rx="3" fill="white" fillOpacity="0.25" />
          <rect x="255" y="50" width="15" height="55" rx="3" fill="white" fillOpacity="0.3" />
          <rect x="280" y="60" width="15" height="45" rx="3" fill="white" fillOpacity="0.25" />
          <rect x="305" y="40" width="15" height="65" rx="3" fill="white" fillOpacity="0.35" />
          <rect x="330" y="55" width="15" height="50" rx="3" fill="white" fillOpacity="0.2" />
        </svg>
      );
    default:
      return (
        <svg className="absolute inset-0 w-full h-full opacity-[0.12]" viewBox="0 0 400 120">
          <circle cx="60" cy="40" r="25" fill="none" stroke="white" strokeWidth="1.5" />
          <circle cx="340" cy="80" r="30" fill="none" stroke="white" strokeWidth="1.5" />
          <rect x="170" y="20" width="35" height="35" rx="8" fill="none" stroke="white" strokeWidth="1.5" transform="rotate(15 187 37)" />
          <circle cx="260" cy="30" r="10" fill="white" fillOpacity="0.3" />
          <circle cx="120" cy="90" r="15" fill="none" stroke="white" strokeWidth="1" strokeDasharray="4 4" />
        </svg>
      );
  }
}

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
              i <= style.bars ? 'bg-current ' + style.color : 'bg-[#ECEAE3]'
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
  const [previewTemplate, setPreviewTemplate] = useState<TemplateMetadata | null>(null);
  const [showCustomCreator, setShowCustomCreator] = useState(false);

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
    <div className="max-w-[1400px] mx-auto px-6 py-8">
      {/* Hero section */}
      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold mb-2">
          <span className="bg-gradient-to-r from-[#553DE9] via-[#7B6BEF] to-[#553DE9] bg-clip-text text-transparent">
            Start with a Template
          </span>
        </h1>
        <p className="text-[#6B6960] text-sm max-w-lg mx-auto mb-6">
          Choose a starting point and customize with AI. Each template is a complete spec
          ready to become your next project.
        </p>

        {/* Centered search bar */}
        <div className="relative max-w-xl mx-auto mb-5">
          <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-[#6B6960]" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search templates by name, tech, or category..."
            className="w-full pl-11 pr-4 py-3 text-sm bg-white border border-[#ECEAE3] rounded-xl outline-none focus:border-[#553DE9] focus:ring-2 focus:ring-[#553DE9]/10 transition-all shadow-sm"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[#6B6960] hover:text-[#36342E] bg-[#F8F4F0] px-2 py-0.5 rounded"
            >
              Clear
            </button>
          )}
        </div>

        {/* Category filter pills */}
        <div className="flex items-center justify-center gap-1.5 flex-wrap" role="tablist">
          {CATEGORIES.map((cat) => {
            const Icon = cat.icon;
            const count = templates ? (cat.key === 'all' ? templates.length : templates.filter(t => (t.category || 'Other') === cat.key).length) : 0;
            return (
              <button
                key={cat.key}
                role="tab"
                aria-selected={activeCategory === cat.key}
                onClick={() => setActiveCategory(cat.key)}
                className={`flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg transition-all whitespace-nowrap ${
                  activeCategory === cat.key
                    ? 'bg-[#553DE9] text-white shadow-sm'
                    : 'text-[#6B6960] hover:text-[#36342E] hover:bg-[#F8F4F0] bg-white border border-[#ECEAE3]'
                }`}
              >
                <Icon size={14} />
                {cat.label}
                {templates && (
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                    activeCategory === cat.key
                      ? 'bg-white/20 text-white'
                      : 'bg-[#F8F4F0] text-[#6B6960]'
                  }`}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Featured templates section (only show when not searching and on 'all' category) */}
      {!searchQuery && activeCategory === 'all' && templates && templates.length > 0 && (
        <FeaturedTemplates
          templates={templates}
          onSelect={handleSelect}
          onPreview={setPreviewTemplate}
        />
      )}

      {/* Template grid */}
      {!templates ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {[1, 2, 3, 4, 5, 6].map(i => (
            <div key={i} className="bg-white border border-[#ECEAE3] rounded-xl shadow-card overflow-hidden animate-pulse">
              <div className="h-32 bg-gradient-to-br from-[#ECEAE3]/30 to-[#ECEAE3]/10" />
              <div className="p-4 space-y-2">
                <div className="h-4 bg-[#ECEAE3]/40 rounded w-3/4" />
                <div className="h-3 bg-[#ECEAE3]/30 rounded w-full" />
                <div className="h-3 bg-[#ECEAE3]/20 rounded w-1/2" />
                <div className="flex gap-1 mt-2">
                  <div className="h-5 w-14 bg-[#ECEAE3]/30 rounded" />
                  <div className="h-5 w-14 bg-[#ECEAE3]/30 rounded" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-16 text-center">
          <Search size={32} className="mx-auto text-[#ECEAE3] mb-3" />
          <p className="text-sm text-[#6B6960] mb-1">No templates match your search.</p>
          <p className="text-xs text-[#939084] mb-3">Try different keywords or browse a category.</p>
          {searchQuery && (
            <button
              onClick={() => { setSearchQuery(''); setActiveCategory('all'); }}
              className="text-xs text-[#553DE9] hover:underline font-medium"
            >
              Clear all filters
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {filtered.map((t) => {
            const category = t.category || 'Other';
            const gradient = CATEGORY_GRADIENTS[category] || CATEGORY_GRADIENTS.Other;
            const techStack = t.tech_stack || [];
            const difficulty = t.difficulty || 'intermediate';
            const buildTime = t.build_time || '5-10 min';
            const stats = TEMPLATE_STATS[t.filename] || { uses: Math.floor(Math.random() * 800) + 100, rating: (Math.random() * 0.7 + 4.0).toFixed(1) };

            return (
              <div
                key={t.filename}
                role="button"
                tabIndex={0}
                onClick={() => setPreviewTemplate(t)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPreviewTemplate(t); } }}
                className="bg-white border border-[#ECEAE3] rounded-xl shadow-card hover:shadow-card-hover hover:-translate-y-0.5 transition-all duration-200 cursor-pointer overflow-hidden group"
              >
                {/* Visual preview header with category pattern */}
                <div className={`h-32 bg-gradient-to-br ${gradient} relative overflow-hidden`}>
                  <CategoryPattern category={category} />

                  {/* Category badge */}
                  <div className="absolute top-3 right-3">
                    <span className="text-[10px] font-semibold text-white/90 bg-white/20 backdrop-blur-sm px-2 py-0.5 rounded">
                      {category}
                    </span>
                  </div>

                  {/* Tech stack preview in header */}
                  {techStack.length > 0 && (
                    <div className="absolute bottom-3 left-3 right-3 flex items-center gap-1.5">
                      {techStack.slice(0, 3).map((tech) => (
                        <span key={tech} className="text-[10px] font-semibold text-white/90 bg-white/20 backdrop-blur-sm px-2 py-0.5 rounded">
                          {tech}
                        </span>
                      ))}
                      {techStack.length > 3 && (
                        <span className="text-[10px] text-white/70 bg-white/15 backdrop-blur-sm px-1.5 py-0.5 rounded">
                          +{techStack.length - 3}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {/* Card body */}
                <div className="p-4">
                  <h3 className="text-sm font-bold text-[#36342E] mb-1 group-hover:text-[#553DE9] transition-colors">
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
                            TECH_COLORS[tech] || 'bg-[#F8F4F0] text-[#6B6960]'
                          }`}
                        >
                          {tech}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Stats row */}
                  <div className="flex items-center gap-3 mb-3 text-[10px] text-[#6B6960]">
                    <span className="flex items-center gap-1">
                      <Users size={10} />
                      {formatNumber(typeof stats.uses === 'number' ? stats.uses : 0)} uses
                    </span>
                    <span className="flex items-center gap-1">
                      <Star size={10} className="text-[#D4A03C]" fill="#D4A03C" />
                      {stats.rating}
                    </span>
                  </div>

                  {/* Meta row: difficulty + build time + action */}
                  <div className="flex items-center justify-between pt-3 border-t border-[#ECEAE3]">
                    <div className="flex items-center gap-3">
                      <DifficultyIndicator level={difficulty} />
                      <div className="flex items-center gap-1 text-[10px] text-[#6B6960]">
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

          {/* "Create Your Own" card at the end of the grid */}
          <div
            role="button"
            tabIndex={0}
            onClick={() => setShowCustomCreator(true)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowCustomCreator(true); } }}
            className="bg-white border-2 border-dashed border-[#ECEAE3] rounded-xl hover:border-[#553DE9]/30 hover:bg-[#553DE9]/[0.02] transition-all duration-200 cursor-pointer overflow-hidden group flex flex-col items-center justify-center min-h-[320px]"
          >
            <div className="w-14 h-14 rounded-2xl bg-[#553DE9]/10 flex items-center justify-center mb-4 group-hover:bg-[#553DE9]/15 transition-colors">
              <Plus size={28} className="text-[#553DE9]" />
            </div>
            <h3 className="text-sm font-bold text-[#36342E] mb-1 group-hover:text-[#553DE9] transition-colors">
              Create Your Own
            </h3>
            <p className="text-xs text-[#6B6960] text-center px-6 max-w-[200px]">
              Design a custom template with your preferred stack and features
            </p>
          </div>
        </div>
      )}

      {/* Template preview modal */}
      {previewTemplate && (
        <TemplatePreview
          template={previewTemplate}
          onClose={() => setPreviewTemplate(null)}
        />
      )}

      {/* Custom template creator modal */}
      {showCustomCreator && (
        <CustomTemplateCreator
          onClose={() => setShowCustomCreator(false)}
        />
      )}
    </div>
  );
}
