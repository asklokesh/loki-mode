import { useEffect, useState, useRef } from 'react';

interface StatItem {
  label: string;
  value: number;
  suffix?: string;
}

function AnimatedStat({ label, value, suffix = '' }: StatItem) {
  const [displayed, setDisplayed] = useState(0);
  const animatedRef = useRef(false);
  const elementRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (animatedRef.current) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !animatedRef.current) {
          animatedRef.current = true;
          const duration = 800;
          const startTime = performance.now();

          function animate(now: number) {
            const elapsed = now - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            setDisplayed(Math.round(value * eased));
            if (progress < 1) requestAnimationFrame(animate);
          }

          requestAnimationFrame(animate);
        }
      },
      { threshold: 0.3 }
    );

    if (elementRef.current) observer.observe(elementRef.current);
    return () => observer.disconnect();
  }, [value]);

  return (
    <div ref={elementRef} className="text-center">
      <div className="text-2xl font-bold text-[#36342E] tabular-nums">
        {displayed.toLocaleString()}{suffix}
      </div>
      <div className="text-xs text-[#6B6960] mt-1">{label}</div>
    </div>
  );
}

export function OpenSourceStats() {
  // Placeholder data -- in production, these could come from the GitHub API
  const stats: StatItem[] = [
    { label: 'GitHub Stars', value: 2450 },
    { label: 'Forks', value: 380 },
    { label: 'Contributors', value: 47 },
    { label: 'npm Downloads', value: 12800, suffix: '+' },
  ];

  return (
    <div className="py-8 border-t border-[#ECEAE3]">
      <div className="flex items-center justify-center gap-2 mb-6">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="text-[#36342E]"
        >
          <path
            d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
            fill="currentColor"
          />
        </svg>
        <span className="text-sm font-semibold text-[#36342E]">Open Source</span>
      </div>

      <div className="grid grid-cols-4 gap-6 max-w-lg mx-auto">
        {stats.map((stat) => (
          <AnimatedStat key={stat.label} {...stat} />
        ))}
      </div>

      <div className="mt-4 text-center">
        <a
          href="https://github.com/asklokesh/loki-mode"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 text-sm text-[#553DE9] hover:text-[#4832c7] font-medium transition-colors"
        >
          Star us on GitHub
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M7 17L17 7M17 7H7M17 7V17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </a>
      </div>
    </div>
  );
}
