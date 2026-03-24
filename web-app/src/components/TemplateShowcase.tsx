import { useRef, useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight, ArrowRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface ShowcaseTemplate {
  name: string;
  description: string;
  tech: string[];
  gradient: string;
}

const SHOWCASE_TEMPLATES: ShowcaseTemplate[] = [
  {
    name: 'SaaS Dashboard',
    description: 'Full-stack analytics dashboard with auth, billing, and user management.',
    tech: ['React', 'Node.js', 'PostgreSQL'],
    gradient: 'from-violet-500/20 via-purple-500/10 to-indigo-500/20',
  },
  {
    name: 'REST API',
    description: 'Production-ready API with authentication, rate limiting, and docs.',
    tech: ['Python', 'FastAPI', 'Redis'],
    gradient: 'from-emerald-500/20 via-teal-500/10 to-cyan-500/20',
  },
  {
    name: 'E-Commerce Store',
    description: 'Online store with Stripe payments, cart, and inventory management.',
    tech: ['React', 'Node.js', 'MongoDB'],
    gradient: 'from-amber-500/20 via-orange-500/10 to-yellow-500/20',
  },
  {
    name: 'Discord Bot',
    description: 'Feature-rich bot with slash commands, moderation, and webhooks.',
    tech: ['TypeScript', 'Discord', 'SQLite'],
    gradient: 'from-blue-500/20 via-sky-500/10 to-cyan-500/20',
  },
  {
    name: 'CLI Tool',
    description: 'Interactive command-line application with argument parsing and config.',
    tech: ['TypeScript', 'CLI', 'Node.js'],
    gradient: 'from-rose-500/20 via-pink-500/10 to-fuchsia-500/20',
  },
  {
    name: 'Landing Page',
    description: 'Responsive marketing site with pricing, testimonials, and CTAs.',
    tech: ['React', 'Tailwind', 'Vite'],
    gradient: 'from-slate-500/20 via-gray-500/10 to-zinc-500/20',
  },
];

const TECH_COLORS: Record<string, string> = {
  React: 'bg-sky-500/10 text-sky-600',
  'Node.js': 'bg-green-500/10 text-green-600',
  Python: 'bg-yellow-500/10 text-yellow-700',
  TypeScript: 'bg-blue-500/10 text-blue-600',
  PostgreSQL: 'bg-indigo-500/10 text-indigo-600',
  MongoDB: 'bg-green-600/10 text-green-700',
  Redis: 'bg-red-500/10 text-red-600',
  FastAPI: 'bg-teal-500/10 text-teal-600',
  SQLite: 'bg-blue-400/10 text-blue-500',
  Tailwind: 'bg-cyan-400/10 text-cyan-600',
  Discord: 'bg-indigo-400/10 text-indigo-500',
  CLI: 'bg-amber-500/10 text-amber-600',
  Vite: 'bg-purple-400/10 text-purple-500',
};

export function TemplateShowcase() {
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(true);

  const checkScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 8);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 8);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    checkScroll();
    el.addEventListener('scroll', checkScroll, { passive: true });
    window.addEventListener('resize', checkScroll);
    return () => {
      el.removeEventListener('scroll', checkScroll);
      window.removeEventListener('resize', checkScroll);
    };
  }, []);

  const scroll = (direction: 'left' | 'right') => {
    const el = scrollRef.current;
    if (!el) return;
    const amount = 320;
    el.scrollBy({ left: direction === 'left' ? -amount : amount, behavior: 'smooth' });
  };

  return (
    <section className="w-full max-w-5xl mx-auto py-16">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="font-heading text-h2 text-[#36342E]">
            Start from a Template
          </h2>
          <p className="text-sm text-[#6B6960] mt-1">
            Production-ready starting points for common use cases.
          </p>
        </div>

        {/* Desktop scroll arrows */}
        <div className="hidden md:flex items-center gap-2">
          <button
            onClick={() => scroll('left')}
            disabled={!canScrollLeft}
            className={`w-8 h-8 rounded-lg border flex items-center justify-center transition-all ${
              canScrollLeft
                ? 'border-[#ECEAE3] text-[#36342E] hover:bg-[#F8F4F0]'
                : 'border-[#ECEAE3]/50 text-[#6B6960]/30 cursor-not-allowed'
            }`}
            aria-label="Scroll left"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            onClick={() => scroll('right')}
            disabled={!canScrollRight}
            className={`w-8 h-8 rounded-lg border flex items-center justify-center transition-all ${
              canScrollRight
                ? 'border-[#ECEAE3] text-[#36342E] hover:bg-[#F8F4F0]'
                : 'border-[#ECEAE3]/50 text-[#6B6960]/30 cursor-not-allowed'
            }`}
            aria-label="Scroll right"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {/* Scrollable row */}
      <div
        ref={scrollRef}
        className="flex gap-4 overflow-x-auto pb-4 snap-x snap-mandatory scrollbar-hide"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {SHOWCASE_TEMPLATES.map((template) => (
          <div
            key={template.name}
            className="flex-shrink-0 w-64 rounded-xl border border-[#ECEAE3] bg-white overflow-hidden snap-start hover:shadow-lg hover:border-[#553DE9]/30 transition-all cursor-pointer group"
            onClick={() => navigate('/templates')}
          >
            {/* Gradient header */}
            <div className={`h-20 bg-gradient-to-br ${template.gradient} flex items-end p-3`}>
              <h3 className="text-sm font-bold text-[#36342E] group-hover:text-[#553DE9] transition-colors">
                {template.name}
              </h3>
            </div>

            {/* Body */}
            <div className="p-3">
              <p className="text-xs text-[#6B6960] mb-3 leading-relaxed line-clamp-2">
                {template.description}
              </p>
              <div className="flex flex-wrap gap-1">
                {template.tech.map((t) => (
                  <span
                    key={t}
                    className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                      TECH_COLORS[t] || 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
          </div>
        ))}

        {/* View All card */}
        <div
          className="flex-shrink-0 w-48 rounded-xl border border-dashed border-[#ECEAE3] bg-[#FAF9F6] flex flex-col items-center justify-center gap-2 snap-start cursor-pointer hover:border-[#553DE9]/40 hover:bg-[#553DE9]/5 transition-all group"
          onClick={() => navigate('/templates')}
        >
          <ArrowRight size={20} className="text-[#6B6960] group-hover:text-[#553DE9] transition-colors" />
          <span className="text-sm font-semibold text-[#6B6960] group-hover:text-[#553DE9] transition-colors">
            View All Templates
          </span>
        </div>
      </div>
    </section>
  );
}
