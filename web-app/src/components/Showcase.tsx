import { useState, useEffect, useCallback } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface ShowcaseProject {
  name: string;
  builder: string;
  gradient: string;
  description: string;
}

const SHOWCASE_PROJECTS: ShowcaseProject[] = [
  {
    name: 'NovaCRM',
    builder: 'Alex Mercer',
    gradient: 'from-[#553DE9] to-[#7B6BEF]',
    description: 'Full-stack CRM with pipeline management',
  },
  {
    name: 'Pixel Canvas',
    builder: 'Riley Tanaka',
    gradient: 'from-[#E93D82] to-[#F06595]',
    description: 'Collaborative drawing app with WebSocket',
  },
  {
    name: 'DevMetrics',
    builder: 'Jordan Blake',
    gradient: 'from-[#1FC5A8] to-[#38D9A9]',
    description: 'Engineering analytics dashboard',
  },
  {
    name: 'BookShelf',
    builder: 'Sam Patel',
    gradient: 'from-[#2F71E3] to-[#5C93E8]',
    description: 'Reading tracker with AI recommendations',
  },
  {
    name: 'InvoiceFlow',
    builder: 'Casey Ngo',
    gradient: 'from-[#F59F00] to-[#FCC419]',
    description: 'Invoice generation and payment tracking',
  },
  {
    name: 'StatusPage',
    builder: 'Morgan Li',
    gradient: 'from-[#845EF7] to-[#B197FC]',
    description: 'Public status page with incident management',
  },
];

export function Showcase() {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isAutoPlaying, setIsAutoPlaying] = useState(true);
  const visibleCount = 3;
  const maxIndex = SHOWCASE_PROJECTS.length - visibleCount;

  const next = useCallback(() => {
    setCurrentIndex((prev) => (prev >= maxIndex ? 0 : prev + 1));
  }, [maxIndex]);

  const prev = useCallback(() => {
    setCurrentIndex((prev) => (prev <= 0 ? maxIndex : prev - 1));
  }, [maxIndex]);

  useEffect(() => {
    if (!isAutoPlaying) return;
    const timer = setInterval(next, 4000);
    return () => clearInterval(timer);
  }, [isAutoPlaying, next]);

  return (
    <div className="py-12 border-t border-[#ECEAE3]">
      <div className="text-center mb-8">
        <h3
          className="text-2xl font-bold"
          style={{
            background: 'linear-gradient(135deg, #553DE9, #7B6BEF, #E93D82)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}
        >
          Built with Loki Mode
        </h3>
        <p className="text-sm text-[#6B6960] mt-2">
          See what developers are building with autonomous AI.
        </p>
      </div>

      <div
        className="relative"
        onMouseEnter={() => setIsAutoPlaying(false)}
        onMouseLeave={() => setIsAutoPlaying(true)}
      >
        {/* Navigation arrows */}
        <button
          onClick={prev}
          className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-4 z-10 w-8 h-8 rounded-full bg-white border border-[#ECEAE3] shadow-sm flex items-center justify-center text-[#6B6960] hover:text-[#36342E] hover:shadow-md transition-all"
          aria-label="Previous project"
        >
          <ChevronLeft size={16} />
        </button>
        <button
          onClick={next}
          className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-4 z-10 w-8 h-8 rounded-full bg-white border border-[#ECEAE3] shadow-sm flex items-center justify-center text-[#6B6960] hover:text-[#36342E] hover:shadow-md transition-all"
          aria-label="Next project"
        >
          <ChevronRight size={16} />
        </button>

        {/* Cards carousel */}
        <div className="overflow-hidden">
          <div
            className="flex gap-4 transition-transform duration-500 ease-out"
            style={{
              transform: `translateX(-${currentIndex * (100 / visibleCount + 1.5)}%)`,
            }}
          >
            {SHOWCASE_PROJECTS.map((project, i) => (
              <div
                key={i}
                className="flex-shrink-0 bg-white border border-[#ECEAE3] rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-shadow"
                style={{ width: `calc(${100 / visibleCount}% - ${((visibleCount - 1) * 16) / visibleCount}px)` }}
              >
                {/* Gradient screenshot placeholder */}
                <div className={`h-32 bg-gradient-to-br ${project.gradient} flex items-center justify-center`}>
                  <span className="text-white/80 text-sm font-medium">{project.name}</span>
                </div>
                <div className="p-4">
                  <h4 className="text-sm font-bold text-[#36342E]">{project.name}</h4>
                  <p className="text-xs text-[#6B6960] mt-1">{project.description}</p>
                  <div className="flex items-center justify-between mt-3 pt-3 border-t border-[#ECEAE3]">
                    <span className="text-xs text-[#939084]">by {project.builder}</span>
                    <span className="text-xs text-[#553DE9] font-medium cursor-pointer hover:text-[#4832c7]">
                      View
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Dots indicator */}
        <div className="flex justify-center gap-1.5 mt-4">
          {Array.from({ length: maxIndex + 1 }).map((_, i) => (
            <button
              key={i}
              onClick={() => setCurrentIndex(i)}
              className={`w-2 h-2 rounded-full transition-colors ${
                i === currentIndex ? 'bg-[#553DE9]' : 'bg-[#ECEAE3]'
              }`}
              aria-label={`Go to slide ${i + 1}`}
            />
          ))}
        </div>
      </div>

      <div className="text-center mt-6">
        <a
          href="https://github.com/asklokesh/loki-mode/discussions"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-[#553DE9] hover:text-[#4832c7] font-medium transition-colors"
        >
          Submit your project
        </a>
      </div>
    </div>
  );
}
